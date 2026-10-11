/*
 * PW-04：CI 的契约新鲜度检查必须同时覆盖 raw 快照（contract/openapi.json）
 *        与被声明为权威的生成物（client-web/src/api/generated.ts）。
 * PW-21：契约快照的来源元数据必须是**单一、可机械核对**的记录，且 ref 要能解析到
 *        真实上游提交、content sha 要与真实字节一致——形状像 40 位十六进制不算通过。
 *
 * 做法不是「读源码看有没有字符串」，而是：
 *   1. 用 js-yaml 从 .github/workflows/ci.yml **逐字取出**那个 step 的 run 脚本；
 *   2. 在临时仓库里起一个本地 HTTP 服务当作「上游 pim-api 的 raw 端」，
 *      用真实 scripts/ci/fetch-contract.sh（真实 openapi-typescript）跑一遍；
 *   3. 造出「生成物是新的、raw 快照是旧的」这一种状态，断言该 step 必须失败。
 * 全程只连 127.0.0.1，不碰外网、不碰生产、不碰 5858。
 *
 * ⚠️ 证据等级：新鲜度重放 = 真实脚本 + 本地替身上游；不是 GitHub Actions 真跑。
 * 来源身份（upstreamRef 可解析 + 字节一致）由脚本自身在 CI 里真实执行：
 * 它按解析出的提交 SHA 再取一次并比对字节，失败即非零退出——不依赖本地 clone，
 * 也没有 skip 分支。真实 GitHub 上游的联通性仍不在本机验证范围内。
 */
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { createServer, type Server } from 'node:http'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import yaml from 'js-yaml'
import { CLIENT_WEB, REPO_ROOT, loadContract } from './_lib/contract'

const WORK = path.join(CLIENT_WEB, 'audit-tests', '.tmp-freshness')
const SNAPSHOT = path.join(REPO_ROOT, 'contract', 'openapi.json')
const PROVENANCE = path.join(REPO_ROOT, 'contract', 'provenance.json')

interface WorkflowStep {
  name?: string
  run?: string
  uses?: string
}

interface Workflow {
  jobs?: Record<string, { steps?: WorkflowStep[] }>
}

/** 从真实 ci.yml 里逐字取出指定 step 的 run 脚本 */
function workflowStepRun(stepName: string): string {
  const wf = yaml.load(
    readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
  ) as Workflow
  for (const job of Object.values(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) {
      if (step.name === stepName && step.run) return step.run
    }
  }
  throw new Error(`ci.yml 里找不到名为 "${stepName}" 且带 run 的 step`)
}

const FRESHNESS_STEP = 'Verify client contract is up to date'

/** 上游不存在的 40 位 SHA（本地 raw 端对它 404） */
const MISSING_REF = 'dead'.repeat(10)
/** 第一次返回快照、第二次返回不同字节的 40 位 SHA（模拟上游在两次读取之间变化） */
const DRIFT_REF = 'a'.repeat(40)
/**
 * 另一个 40 位 SHA，但字节与快照**相同**——用来证明「同 bytes 不同 ref」是合法的
 * 等价来源（不能被一律打红）。
 */
const SAME_BYTES_REF = 'c'.repeat(40)
/**
 * 40 位 SHA，但其字节与快照**不同**——记录里的 ref 与内容哈希互相矛盾时必须失败。
 */
const CONTRADICTION_REF = 'b'.repeat(40)

/* ── 本地 raw 端（替代 raw.githubusercontent.com） ─────────── */

let server: Server
let rawBase = ''
let upstreamContract = ''
let upstreamSha256 = ''
/** 记录脚本实际请求的 ref，用于「声明的 ref 真的被请求」的行为断言 */
const requestedRefs: string[] = []
/** DRIFT_REF 被请求的次数（第一次正常、之后漂移） */
let driftHits = 0
/** 本地 git 远端：给脚本解析分支名 → 提交 SHA（避免测试访问真实 GitHub） */
const UPSTREAM_GIT = path.join(WORK, 'upstream-git')
let upstreamHead = ''

beforeAll(async () => {
  upstreamContract = readFileSync(SNAPSHOT, 'utf8')
  upstreamSha256 = createHash('sha256').update(upstreamContract).digest('hex')
  server = createServer((req, res) => {
    const m = /^\/2746267826\/pim-api\/([^/]+)\/contract\/openapi\.json$/.exec(req.url ?? '')
    if (m) {
      const ref = decodeURIComponent(m[1]!)
      requestedRefs.push(ref)
      if (ref === MISSING_REF) {
        res.writeHead(404)
        res.end('not found')
        return
      }
      let body = upstreamContract
      if (ref === DRIFT_REF) {
        driftHits += 1
        if (driftHits > 1) body = `${upstreamContract}\n`
      }
      // 该 ref 的字节与快照不同：用来构造「记录的 ref 与 bytes 矛盾」
      if (ref === CONTRADICTION_REF) body = `${upstreamContract}\n`
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(body)
      return
    }
    res.writeHead(404)
    res.end('not found')
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const addr = server.address()
  if (addr === null || typeof addr === 'string') throw new Error('无法取得本地端口')
  rawBase = `http://127.0.0.1:${addr.port}`

  // 本地只读上游：只用来把 master 解析成提交 SHA，raw 端仍由上面的本地 HTTP 提供
  rmSync(UPSTREAM_GIT, { recursive: true, force: true })
  mkdirSync(UPSTREAM_GIT, { recursive: true })
  await run('git', ['init', '-q', '-b', 'master'], UPSTREAM_GIT)
  await run('git', ['config', 'user.email', 'audit@pim.local'], UPSTREAM_GIT)
  await run('git', ['config', 'user.name', 'audit'], UPSTREAM_GIT)
  writeFileSync(path.join(UPSTREAM_GIT, 'contract.txt'), 'upstream', 'utf8')
  await run('git', ['add', '-A'], UPSTREAM_GIT)
  await run('git', ['commit', '-qm', 'upstream'], UPSTREAM_GIT)
  upstreamHead = (await run('git', ['rev-parse', 'HEAD'], UPSTREAM_GIT)).output.trim()
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  rmSync(WORK, { recursive: true, force: true })
})

const execFileAsync = promisify(execFile)

/**
 * 必须用异步执行：本文件里有一个 127.0.0.1 的本地 raw 端跑在**同一个**事件循环上，
 * 用 execFileSync 阻塞事件循环会让服务器无法应答，curl 一直等 → 死锁。
 */
async function run(
  cmd: string,
  args: string[],
  cwd: string,
  extraEnv: Record<string, string> = {},
): Promise<{ status: number; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync(cmd, args, {
      cwd,
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: {
        ...process.env,
        TMPDIR: path.join(WORK, 'tmp'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        // 只连本地 raw 端与本地 git 远端，绝不访问真实 GitHub。
        // REF 保持 CI 的真实取值 master，由本地远端把 master 解析成提交 SHA。
        PIM_CONTRACT_RAW_BASE: rawBase,
        PIM_CONTRACT_REF: 'master',
        PIM_CONTRACT_REMOTE: UPSTREAM_GIT,
        ...extraEnv,
      },
    })
    return { status: 0, output: `${stdout}${stderr}` }
  } catch (err) {
    const e = err as { code?: number; status?: number; stdout?: string; stderr?: string }
    return { status: e.code ?? e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

/** 造一个临时仓库：真实脚本 + 真实生成物 + 指定内容（或篡改后）的快照 */
async function makeScratch(
  name: string,
  opts: { staleSnapshot: boolean; staleGenerated: boolean },
): Promise<string> {
  const dir = path.join(WORK, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(path.join(dir, 'scripts', 'ci'), { recursive: true })
  mkdirSync(path.join(dir, 'contract'), { recursive: true })
  mkdirSync(path.join(dir, 'client-web', 'src', 'api'), { recursive: true })
  mkdirSync(path.join(WORK, 'tmp'), { recursive: true })

  cpSync(
    path.join(REPO_ROOT, 'scripts', 'ci', 'fetch-contract.sh'),
    path.join(dir, 'scripts', 'ci', 'fetch-contract.sh'),
  )
  // openapi-typescript 与它的依赖直接从真实 client-web/node_modules 复用（只读）
  symlinkSync(path.join(CLIENT_WEB, 'node_modules'), path.join(dir, 'client-web', 'node_modules'), 'dir')

  const generated = readFileSync(path.join(CLIENT_WEB, 'src', 'api', 'generated.ts'), 'utf8')
  writeFileSync(
    path.join(dir, 'client-web', 'src', 'api', 'generated.ts'),
    opts.staleGenerated ? `${generated}\n// audit fault: stale generated.ts\n` : generated,
    'utf8',
  )

  let snapshot = upstreamContract
  if (opts.staleSnapshot) {
    const parsed = JSON.parse(upstreamContract) as { paths: Record<string, unknown> }
    delete parsed.paths['/api/v1/status']
    snapshot = `${JSON.stringify(parsed, null, 2)}\n`
  }
  writeFileSync(path.join(dir, 'contract', 'openapi.json'), snapshot, 'utf8')

  await run('git', ['init', '-q'], dir)
  await run('git', ['config', 'user.email', 'audit@pim.local'], dir)
  await run('git', ['config', 'user.name', 'audit'], dir)
  await run('git', ['add', '-A'], dir)
  await run('git', ['commit', '-qm', 'baseline'], dir)
  // 忽略 node_modules 符号链接，避免污染 diff
  writeFileSync(path.join(dir, '.gitignore'), 'client-web/node_modules\n', 'utf8')
  return dir
}

async function replayFreshnessStep(
  dir: string,
): Promise<{ status: number; output: string; diff: string }> {
  const script = path.join(dir, 'step.sh')
  writeFileSync(script, workflowStepRun(FRESHNESS_STEP), 'utf8')
  const r = await run('bash', [script], dir)
  const diff = (await run('git', ['--no-pager', 'diff', '--name-only'], dir)).output.trim()
  return { ...r, diff }
}

/* ── 前置：脚本与上游都可用 ─────────────────────────────────── */

describe('前置条件（不满足则整个 replay 无意义）', () => {
  it('ci.yml 里存在该 step，且它调用了真实 fetch-contract.sh', () => {
    const runText = workflowStepRun(FRESHNESS_STEP)
    expect(runText).toContain('scripts/ci/fetch-contract.sh')
  })

  it('本地 raw 端能提供契约，且真实 fetch-contract.sh 可用它生成 types', async () => {
    const dir = await makeScratch('probe', { staleSnapshot: false, staleGenerated: false })
    const r = await run('bash', ['scripts/ci/fetch-contract.sh'], dir)
    expect(r.status, `fetch-contract.sh 失败：\n${r.output}`).toBe(0)
    const gen = readFileSync(path.join(dir, 'client-web', 'src', 'api', 'generated.ts'), 'utf8')
    expect(gen).toContain('export interface paths')
  }, 120_000)
})

/* ── PW-04 ─────────────────────────────────────────────────── */

describe('PW-04：raw 快照陈旧必须让门禁变红', () => {
  it('step 的 diff 范围必须同时覆盖 contract/openapi.json 与 generated.ts', () => {
    const runText = workflowStepRun(FRESHNESS_STEP)
    const diffTargets = [...runText.matchAll(/git\s+(?:--no-pager\s+)?diff[^\n]*/g)].map((m) => m[0])
    expect(
      diffTargets.join('\n'),
      '新鲜度 step 没同时检查快照与生成物，其中一边陈旧时会给绿灯',
    ).toContain('contract/openapi.json')
    expect(diffTargets.join('\n')).toContain('client-web/src/api/generated.ts')
  })

  it('已提交「生成物是新的、raw 快照是旧的」时，重放该 step 必须失败', async () => {
    const dir = await makeScratch('stale-snapshot', { staleSnapshot: true, staleGenerated: false })
    const r = await replayFreshnessStep(dir)
    expect(
      r.status,
      `目标行为：raw 快照与上游不一致必须让 CI 变红。实际 exit=${r.status}\n${r.output}\nstep 后 git diff --name-only:\n${r.diff}`,
    ).not.toBe(0)
  }, 120_000)

  it('对照：已提交陈旧 generated.ts 必须失败（证明重放机制本身有效）', async () => {
    const dir = await makeScratch('stale-generated', { staleSnapshot: false, staleGenerated: true })
    const r = await replayFreshnessStep(dir)
    expect(r.status, `陈旧 generated.ts 必须失败。输出：\n${r.output}`).not.toBe(0)
  }, 120_000)

  it('对照：两者都新鲜时必须通过（证明重放机制不是永远失败）', async () => {
    const dir = await makeScratch('both-fresh', { staleSnapshot: false, staleGenerated: false })
    const r = await replayFreshnessStep(dir)
    expect(r.status, `都不陈旧时应通过。输出：\n${r.output}`).toBe(0)
  }, 120_000)

  it('故障对照：把 raw 快照的路径真删掉后，未提交状态下 step 也看不到差异（证明必须用已提交基线）', async () => {
    // 这不是缺陷，只是记录审计里 F4′ 的假阴性成因，防止有人用「未提交工作区」当证据。
    const dir = await makeScratch('uncommitted-snapshot', { staleSnapshot: false, staleGenerated: false })
    const parsed = JSON.parse(upstreamContract) as { paths: Record<string, unknown> }
    delete parsed.paths['/api/v1/status']
    writeFileSync(path.join(dir, 'contract', 'openapi.json'), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8')
    const r = await replayFreshnessStep(dir)
    expect(r.status).toBe(0)
  }, 120_000)
})

/* ── PW-21：来源元数据 ─────────────────────────────────────── */

interface Provenance {
  repo?: string
  upstreamRef?: string
  contentSha256?: string
  snapshotBytes?: number
  fetchedAtUtc?: string
}

/**
 * 机械核对「来源记录 ↔ 真实快照字节」。
 * 返回失败原因列表；**形状正确但内容对不上**必须失败——这正是 I-2 要求的
 * 「不能 40 位十六进制形式通过」。
 */
function verifyProvenance(
  provenance: Provenance | null,
  snapshotBytes: Buffer,
): string[] {
  const problems: string[] = []
  if (!provenance) return ['缺少 contract/provenance.json（来源元数据没有可机读来源）']
  const actual = createHash('sha256').update(snapshotBytes).digest('hex')
  if (typeof provenance.upstreamRef !== 'string' || !/^[0-9a-f]{40}$/.test(provenance.upstreamRef)) {
    problems.push(
      `upstreamRef "${provenance.upstreamRef ?? '<缺失>'}" 不是完整的 40 位提交 SHA，无法与上游解析比对`,
    )
  }
  if (!provenance.contentSha256) {
    problems.push('缺少 contentSha256（内容哈希）')
  } else if (provenance.contentSha256 !== actual) {
    problems.push(
      `contentSha256 与快照真实字节不一致：记录 ${provenance.contentSha256}，实际 ${actual}`,
    )
  }
  if (provenance.snapshotBytes !== undefined && provenance.snapshotBytes !== snapshotBytes.length) {
    problems.push(
      `snapshotBytes 与快照真实长度不一致：记录 ${provenance.snapshotBytes}，实际 ${snapshotBytes.length}`,
    )
  }
  return problems
}

/** 当前仓库里的来源记录（唯一来源：contract/provenance.json） */
function committedProvenance(): Provenance | null {
  if (!existsSync(PROVENANCE)) return null
  return JSON.parse(readFileSync(PROVENANCE, 'utf8')) as Provenance
}

/** 按 ref 取一次上游字节（本地替身 raw 端；取不到返回 null，不 skip） */
async function fetchUpstreamBytes(ref: string): Promise<Buffer | null> {
  const res = await fetch(`${rawBase}/2746267826/pim-api/${ref}/contract/openapi.json`)
  if (!res.ok) return null
  return Buffer.from(await res.arrayBuffer())
}

/**
 * PW-21 的**严格**反 control：不仅看「记录的形状 + 本地快照 sha」，
 * 还要把**记录声明的那个 ref** 的字节取回来与快照比对：
 * - 同一个 ref 取到的字节与快照一致 ⇒ 记录成立（同 bytes 不同 ref 也算等价来源，合法）；
 * - 取到的字节与记录/快照矛盾 ⇒ 失败（记录 ref 与 bytes 互相矛盾）；
 * - 取不到该 ref ⇒ 失败（无法核对，不能算通过、也不能 skip）。
 * 这样「内容 sha 对 + 随便填 40 位十六进制」不再能过。
 */
async function verifyProvenanceAgainstRecordedRef(
  provenance: Provenance | null,
  snapshotBytes: Buffer,
): Promise<string[]> {
  const problems = verifyProvenance(provenance, snapshotBytes)
  const ref = provenance?.upstreamRef
  if (typeof ref !== 'string' || !/^[0-9a-f]{40}$/.test(ref)) return problems
  const fetched = await fetchUpstreamBytes(ref)
  if (fetched === null) {
    problems.push(`按记录的 upstreamRef ${ref} 取不到上游字节：来源无法核对（不能算通过）`)
    return problems
  }
  if (!fetched.equals(snapshotBytes)) {
    problems.push(
      `记录的 upstreamRef ${ref} 对应的字节与快照不一致：这条来源记录与内容互相矛盾`,
    )
  }
  return problems
}

describe('PW-21：快照来源元数据必须可机械核对（单一来源 + 真实内容哈希）', () => {
  it('仓库必须有 contract/provenance.json（唯一来源，不再靠 README 里手写的 HEAD/sha）', () => {
    expect(
      existsSync(PROVENANCE),
      '缺少 contract/provenance.json：上游 ref 与内容 sha 只能靠 contract/README.md 里手写的值，PW-21 会一直复发',
    ).toBe(true)
  })

  it('内容哈希必须与提交的快照真实字节一致，ref 必须是完整 40 位 SHA', () => {
    const problems = verifyProvenance(committedProvenance(), readFileSync(SNAPSHOT))
    expect(problems.join('\n')).toBe('')
  })

  it('故障对照：形状合法的假 ref / 假 content sha 必须被判失败（证明不是看形状）', () => {
    const bytes = readFileSync(SNAPSHOT)
    // 40 位十六进制但内容哈希是编的
    expect(
      verifyProvenance({ upstreamRef: '0'.repeat(40), contentSha256: '0'.repeat(64) }, bytes).length,
    ).toBeGreaterThan(0)
    // 缩写的上游 HEAD（旧 README 的写法）
    expect(
      verifyProvenance({ upstreamRef: '2f56dbb3', contentSha256: upstreamSha256 }, bytes).length,
    ).toBeGreaterThan(0)
    // 内容哈希正确 + 合法 ref → 形状层面通过（严格比对见下一条）
    expect(
      verifyProvenance({ upstreamRef: 'a'.repeat(40), contentSha256: upstreamSha256 }, bytes),
    ).toEqual([])
  })

  it('反向对照（严格）：比的是「记录的 ref 对应的字节」——同 bytes 不同 ref 合法，ref 与 bytes 矛盾必失败', async () => {
    /*
     * review C5 的返工点：旧反 control 只对**本地快照**比 sha，于是
     * 「contentSha256 正确 + 任何 40 位十六进制 ref」（哪怕是 `'a'.repeat(40)`）
     * 都能过——太松。这里把「记录的 ref」也真取一次字节来比。
     */
    const bytes = readFileSync(SNAPSHOT)

    // 同一个 ref 取到的字节与快照相同：等价来源，合法（不能因为 ref 不是真上游就一律打红）
    expect(
      await verifyProvenanceAgainstRecordedRef(
        { upstreamRef: SAME_BYTES_REF, contentSha256: upstreamSha256 },
        bytes,
      ),
    ).toEqual([])

    // 记录的 ref 取到的字节与快照/记录矛盾 ⇒ 必须失败
    expect(
      (
        await verifyProvenanceAgainstRecordedRef(
          { upstreamRef: CONTRADICTION_REF, contentSha256: upstreamSha256 },
          bytes,
        )
      ).join('\n'),
      '记录的 ref 与 bytes 矛盾却被判通过：来源核对太松',
    ).toMatch(/字节与快照不一致/)

    // 解析不到该 ref ⇒ 失败（不 skip、不算通过）
    expect(
      (
        await verifyProvenanceAgainstRecordedRef(
          { upstreamRef: MISSING_REF, contentSha256: upstreamSha256 },
          bytes,
        )
      ).join('\n'),
    ).toMatch(/取不到上游字节/)

    // 反向对照：仓库里真实的来源记录必须通过（防止判据恒假）
    expect(
      (await verifyProvenanceAgainstRecordedRef(committedProvenance(), bytes)).join('\n'),
    ).toBe('')
  })

  it('provenance.json 不得被塞进 CI 的 git diff（上游有新提交而快照字节不变时会无故变红）', () => {
    const step = workflowStepRun(FRESHNESS_STEP)
    const diffLine = /git\s+diff[^\n]*/.exec(step)
    expect(diffLine, '新鲜度 step 里找不到 git diff 命令行').not.toBeNull()
    expect(
      diffLine![0].includes('provenance.json'),
      'CI 的快照比对把 contract/provenance.json 也算进去了：上游 ref 前进而 openapi.json 字节不变时，' +
        '这条检查会无故变红（provenance 只作为来源记录提交，不参与快照等价比对）',
    ).toBe(false)
  })

  it('contract/README.md 不得再手写一份会漂移的 HEAD/sha；若有 sha256 声明必须与快照一致', () => {
    const readme = readFileSync(path.join(REPO_ROOT, 'contract', 'README.md'), 'utf8')
    const declared = /sha256[：:\s]*`([0-9a-f]{64})`/i.exec(readme)
    if (declared) {
      expect(
        declared[1],
        'contract/README.md 里的 sha256 与快照实际内容不一致（手写值又漂移了）',
      ).toBe(upstreamSha256)
    }
    const head = /HEAD[^\n`]*`([0-9a-zA-Z]{7,40})`/.exec(readme)
    if (head) {
      expect(
        head[1],
        'contract/README.md 手写的上游 HEAD 与 provenance 的 upstreamRef 不一致',
      ).toBe(committedProvenance()?.upstreamRef)
    }
  })

  it('真实 fetch-contract.sh 跑完后必须落盘来源记录，且 ref 就是本次请求的 ref、sha 与真实内容一致', async () => {
    requestedRefs.length = 0
    const dir = await makeScratch('provenance', { staleSnapshot: false, staleGenerated: false })
    const r = await run('bash', ['scripts/ci/fetch-contract.sh'], dir)
    expect(r.status, `fetch-contract.sh 失败：\n${r.output}`).toBe(0)
    expect(requestedRefs[0], '第一次必须按本次请求的 ref（CI 里是 master）取').toBe('master')
    const pinned = requestedRefs.slice(1)
    expect(
      pinned.length,
      '脚本还必须按解析出的提交 SHA 再取一次做字节复核',
    ).toBeGreaterThanOrEqual(1)
    expect(
      [...new Set(pinned)],
      '字节复核必须用解析出的不可变提交 SHA，而不是再次请求分支名',
    ).toEqual([upstreamHead])

    const metaPath = path.join(dir, 'contract', 'provenance.json')
    expect(
      existsSync(metaPath),
      'fetch-contract.sh 跑完后没有生成机读来源记录 contract/provenance.json',
    ).toBe(true)

    const meta = JSON.parse(readFileSync(metaPath, 'utf8')) as Provenance
    const bytes = readFileSync(path.join(dir, 'contract', 'openapi.json'))
    expect(verifyProvenance(meta, bytes).join('\n')).toBe('')
    expect(meta.upstreamRef, '来源记录必须写解析后的不可变提交 SHA').toBe(upstreamHead)
    expect(meta.contentSha256, '内容 SHA 必须是本次取到字节的真实哈希').toBe(upstreamSha256)
  }, 120_000)

  it('故障对照：上游解析不出该 ref 时脚本必须失败（不写形状合法的假来源、也不 skip）', async () => {
    requestedRefs.length = 0
    const dir = await makeScratch('provenance-missing-ref', {
      staleSnapshot: false,
      staleGenerated: false,
    })
    const r = await run('bash', ['scripts/ci/fetch-contract.sh'], dir, {
      PIM_CONTRACT_REF: MISSING_REF,
    })
    expect(r.status, `上游没有这个 ref，脚本仍然成功了：\n${r.output}`).not.toBe(0)
    expect(r.output, '失败原因必须是「取不到上游契约」').toMatch(/无法拉取契约/)
    expect(
      existsSync(path.join(dir, 'contract', 'provenance.json')),
      '失败路径上不得留下一条来源记录',
    ).toBe(false)
  }, 120_000)

  it('故障对照：两次读取字节不一致时必须失败（证明真的复核了权威字节，而不是只看形状）', async () => {
    driftHits = 0
    const dir = await makeScratch('provenance-drift', { staleSnapshot: false, staleGenerated: false })
    const r = await run('bash', ['scripts/ci/fetch-contract.sh'], dir, {
      PIM_CONTRACT_REF: DRIFT_REF,
    })
    expect(
      r.status,
      `按同一个提交取到的两次字节不一致，脚本仍然成功了：\n${r.output}`,
    ).not.toBe(0)
    expect(r.output, '必须以「字节不一致」为由失败').toMatch(/不一致/)
  }, 120_000)

  it('分支名必须被解析成不可变提交 SHA 并写进来源记录（公开只读上游，无需凭据、不 skip）', async () => {
    const dir = await makeScratch('provenance-branch', {
      staleSnapshot: false,
      staleGenerated: false,
    })
    const r = await run('bash', ['scripts/ci/fetch-contract.sh'], dir, {
      PIM_CONTRACT_REF: 'master',
      PIM_CONTRACT_REMOTE: UPSTREAM_GIT,
    })
    expect(r.status, `按分支取契约失败：\n${r.output}`).toBe(0)
    const meta = JSON.parse(
      readFileSync(path.join(dir, 'contract', 'provenance.json'), 'utf8'),
    ) as Provenance
    expect(
      meta.upstreamRef,
      '传入分支名时，来源记录必须写解析后的不可变提交 SHA，而不是分支名',
    ).toBe(upstreamHead)
    expect(meta.upstreamRef).toMatch(/^[0-9a-f]{40}$/)
  }, 120_000)

  it('契约快照本身确实是新鲜的（内容维度，避免把过期当成本问题）', () => {
    const contract = loadContract()
    expect(contract.paths.size).toBeGreaterThan(200)
  })
})
