/*
 * PW-09：对真实后端做核验的脚本必须「能失败」（不得含恒真断言），并且必须明确
 *        写明它需要真实后端、不进 CI gate（不再要求每个文件名都出现在 CI 命令里）。
 * PW-10：开发用 mock 服务器不得实现契约与源码都不存在的端点。
 * PW-N3：mock 的监听端口必须是可隔离的（能指定端口启动，且不占用 5858）。
 *
 * PW-09 用 AST 判定恒真断言（见 _lib/assertions.ts），并配故障对照。
 * PW-10 / PW-N3 是**行为测试**：真的把 scripts/mock-api.mjs 起起来，用真实 HTTP 请求
 * 探一个契约外的端点与一个契约内的对照端点。
 *
 * ⚠️ mock 启动方式（安全约束）：源码里的默认端口是 5858，而本机 5858 上有来源不明的
 * 真实 PIM API 在应答。因此这里把源码复制一份、把默认端口改成一个随机空闲端口，
 * 再用 MOCK_PORT 指定另一个随机空闲端口去启动——**任何一步都不会绑定或连接 5858**。
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { createServer } from 'node:net'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { findTautologicalAssertions } from './_lib/assertions'
import { CLIENT_WEB, REPO_ROOT, loadContract } from './_lib/contract'

/* ── PW-09 ─────────────────────────────────────────────────── */

const QA_SCRIPTS = readdirSync(path.join(CLIENT_WEB, 'scripts')).filter((f) =>
  /\.(mjs|js|py)$/.test(f),
)

/** 需要真实后端/测试账号的脚本：必须被文档显式声明为「不进 CI gate」 */
const BACKEND_SCRIPTS = QA_SCRIPTS.filter((f) => /^(verify-|probe-|qa-|extract-)/.test(f))

describe('PW-09：QA/自验脚本不得含恒真断言', () => {
  it('前置：至少扫到 verify-pitfalls.mjs，且判定器认得出它的断言助手', () => {
    const src = readFileSync(path.join(CLIENT_WEB, 'scripts', 'verify-pitfalls.mjs'), 'utf8')
    const injected = findTautologicalAssertions(
      `${src}\nok('probe', true, 'injected')\n`,
      'verify-pitfalls.mjs',
    )
    expect(injected.length, '判定器认不出 verify-pitfalls 的断言助手').toBeGreaterThan(0)
  })

  it('scripts/ 下的脚本里不得存在恒真断言', () => {
    const findings = QA_SCRIPTS.flatMap((f) =>
      findTautologicalAssertions(readFileSync(path.join(CLIENT_WEB, 'scripts', f), 'utf8'), f),
    )
    expect(
      findings.map((f) => `${f.file}:${f.line} ${f.callee}(…) → ${f.reason}  [${f.expression}]`).join('\n'),
      '恒真断言让「脚本通过」失去证明力',
    ).toBe('')
  })

  it('故障对照：字面量 true / `|| true` / `true || …` 都必须被识别，干净的断言不得被误报', () => {
    const cases: [string, number][] = [
      ["const ok = (n, cond, d) => { results.push({ pass: !!cond, d }) }\nok('a', true, 'x')\n", 1],
      ["const ok = (n, cond, d) => { results.push({ pass: !!cond, d }) }\nok('a', cond === 0 || true, 'x')\n", 1],
      ["const ok = (n, cond, d) => { results.push({ pass: !!cond, d }) }\nok('a', true || cond, 'x')\n", 1],
      ["const ok = (n, cond, d) => { results.push({ pass: !!cond, d }) }\nok('a', cond === 0, 'x')\n", 0],
      ["const ok = (n, cond, d) => { results.push({ pass: !!cond, d }) }\nok('a', Array.isArray(x) && x.length > 0, 'x')\n", 0],
    ]
    for (const [src, expected] of cases) {
      expect(findTautologicalAssertions(src, 'probe.mjs').length, `判定失败：${src}`).toBe(expected)
    }
  })

  it('需要真实后端的脚本必须在文档里显式声明「不进 CI gate」（不是靠文件名逐个进 CI）', () => {
    const agents = readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8')
    // 文档里必须有一段统一声明，并逐条列出这些脚本
    const section = /需要真实后端的本地脚本[\s\S]{0,1200}/.exec(agents)
    expect(section, 'AGENTS.md 缺少「需要真实后端的本地脚本」一节').not.toBeNull()
    const missing = BACKEND_SCRIPTS.filter((f) => !section![0].includes(f))
    expect(
      missing,
      `这些脚本需要真实后端，却没有在 AGENTS.md 的声明段里列出：${missing.join(', ')}`,
    ).toEqual([])
    expect(section![0]).toMatch(/不进[^\n]*gate|不进入[^\n]*gate/)
  })

  it('（记录）这些脚本的结论不会被写成已验证后端：本轮没有隔离后端与凭据', () => {
    // 前置事实，防止有人把「脚本存在」当成「后端核验已通过」。
    expect(BACKEND_SCRIPTS.length).toBeGreaterThan(0)
    const pitfalls = readFileSync(path.join(CLIENT_WEB, 'scripts', 'verify-pitfalls.mjs'), 'utf8')
    expect(pitfalls).toMatch(/NOT-VERIFIED|不进 CI gate/)
  })
})

/* ── PW-10 / PW-N3：mock 行为 ──────────────────────────────── */

const FABRICATED = '/api/v1/files/sync-batches'
const CONTROL = '/api/v1/calendar/calendars'

function pickFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.once('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      if (addr === null || typeof addr === 'string') {
        reject(new Error('无法取得空闲端口'))
        return
      }
      const port = addr.port
      srv.close(() => resolve(port))
    })
  })
}

interface MockHandle {
  child: ChildProcess
  stdout: string
  stderr: string
  /** 从 stdout 的启动行里解析出的实际监听端口 */
  announcedPort: number | null
}

/** 用真实 scripts/mock-api.mjs（**不改源码、不复制改写**）起一个隔离实例 */
function startMock(env: Record<string, string>): MockHandle {
  const handle: MockHandle = {
    child: spawn(process.execPath, [path.join(CLIENT_WEB, 'scripts', 'mock-api.mjs')], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ...env },
    }),
    stdout: '',
    stderr: '',
    announcedPort: null,
  }
  handle.child.stdout?.on('data', (d: Buffer) => {
    handle.stdout += d.toString()
    const m = /mock api on http:\/\/[^:]+:(\d+)/.exec(handle.stdout)
    if (m && handle.announcedPort === null) handle.announcedPort = Number(m[1])
  })
  handle.child.stderr?.on('data', (d: Buffer) => {
    handle.stderr += d.toString()
  })
  return handle
}

/** 指定 MOCK_PORT 启动的实例 */
let mockWithPort: MockHandle | null = null
/** 完全不设置 MOCK_PORT 启动的实例（验证默认不会去独占 5858） */
let mockDefault: MockHandle | null = null
let envPort = 0
let mockSource = ''

async function respondsOn(port: number): Promise<boolean> {
  if (port === 0 || port === 5858) return false
  try {
    const res = await fetch(`http://127.0.0.1:${port}${CONTROL}`)
    return res.status > 0
  } catch {
    return false
  }
}

async function waitFor(port: number, attempts = 60): Promise<boolean> {
  for (let i = 0; i < attempts; i += 1) {
    if (await respondsOn(port)) return true
    await new Promise((r) => setTimeout(r, 100))
  }
  return false
}

async function waitForAnnounced(handle: MockHandle | null, attempts = 100): Promise<number | null> {
  for (let i = 0; i < attempts; i += 1) {
    if (handle?.announcedPort != null) return handle.announcedPort
    await new Promise((r) => setTimeout(r, 100))
  }
  return handle?.announcedPort ?? null
}

beforeAll(async () => {
  mockSource = readFileSync(path.join(CLIENT_WEB, 'scripts', 'mock-api.mjs'), 'utf8')
  envPort = await pickFreePort()
  mockWithPort = startMock({ MOCK_PORT: String(envPort) })
  await waitFor(envPort, 40)
  // 不设置 MOCK_PORT：只允许绑内核分配的空闲端口（绝不是 5858）
  mockDefault = startMock({})
  await waitForAnnounced(mockDefault, 100)
}, 60_000)

afterAll(() => {
  mockWithPort?.child.kill()
  mockDefault?.child.kill()
})

/** 递归在源码里找字符串（grep 命中 0 行会返回非零退出码，不适合直接用） */
function filesContaining(dir: string, needle: string): string[] {
  const out: string[] = []
  const walk = (p: string): void => {
    for (const e of readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name)
      if (e.isDirectory()) walk(full)
      else if (/\.(ts|tsx|mjs|js)$/.test(e.name) && readFileSync(full, 'utf8').includes(needle)) {
        out.push(path.relative(CLIENT_WEB, full))
      }
    }
  }
  walk(dir)
  return out
}

describe('PW-N3：mock 必须能在指定端口上隔离启动（不占用 5858）', () => {
  it('设置 MOCK_PORT 时，mock 必须监听该端口（且不需要改产品源码）', async () => {
    expect(
      mockWithPort,
      `mock-api.mjs 无法在隔离端口启动：${mockWithPort?.stderr.slice(0, 400) ?? ''}`,
    ).not.toBeNull()
    const res = await fetch(`http://127.0.0.1:${envPort}${CONTROL}`)
    expect(res.status, '对照端点必须可用，否则无法区分「mock 没起来」与「该端点不存在」').toBe(200)
  })

  it('未设置 MOCK_PORT 时不得默认独占 5858（应绑内核分配的空闲端口）', async () => {
    const announced = await waitForAnnounced(mockDefault)
    expect(
      announced,
      `未设置 MOCK_PORT 时 mock 没有报告监听端口：${mockDefault?.stderr.slice(0, 400) ?? ''}`,
    ).not.toBeNull()
    expect(
      announced,
      '未设置 MOCK_PORT 时 mock 仍然把 5858 当默认端口：本机 5858 上可能已有真实的 PIM API',
    ).not.toBe(5858)
    expect(await respondsOn(announced!), 'mock 报告的端口必须真的在应答').toBe(true)
  })

  it('源码不得把 5858 硬编码为监听端口，且默认值必须来自可配置项', () => {
    expect(
      /\.listen\(\s*5858\s*,/.test(mockSource),
      'mock 仍然把 5858 硬编码为默认监听端口',
    ).toBe(false)
    expect(mockSource, 'mock 必须读取 MOCK_PORT 环境变量').toMatch(/MOCK_PORT/)
  })
})

describe('PW-10：mock 服务器只能实现契约里存在的端点', () => {
  it('契约里不存在的 /api/v1/files/sync-batches 不得被 mock 提供', async () => {
    const contract = loadContract()
    expect(contract.paths.has(FABRICATED), '前提：契约里确实没有这个路径').toBe(false)

    const res = await fetch(`http://127.0.0.1:${envPort}${FABRICATED}`)
    const body = (await res.json().catch(() => null)) as { code?: number } | null
    expect(
      res.status,
      `mock 提供了契约里不存在的端点 ${FABRICATED}，会让开发以为它存在（真实后端 404）`,
    ).toBe(404)
    expect(body?.code).not.toBe(0)
  })

  it('源码里也没有任何地方调用这个虚构端点（否则说明它曾被认为存在）', () => {
    const hits = filesContaining(path.join(CLIENT_WEB, 'src'), 'sync-batches')
    expect(hits, `${hits.join(', ')} 里出现了 sync-batches`).toEqual([])
  })

  it('mock 声明的路径字面量必须是契约路径的子集（动态段按模板比对）', () => {
    const contract = loadContract()
    const literals = new Set<string>()
    for (const m of mockSource.matchAll(/['"`](\/api\/v1\/[^'"`$]*)['"`]/g)) literals.add(m[1]!)
    const extra = [...literals].filter((p) => {
      const clean = p.replace(/\/+$/, '')
      if (contract.paths.has(clean)) return false
      return ![...contract.paths].some((cp) => {
        const re = new RegExp(
          `^${cp
            .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
            .replace(/\\\{[^}]+\\\}/g, '[^/]+')}$`,
        )
        return re.test(clean)
      })
    })
    expect(extra.sort(), 'mock 声明的契约外路径').toEqual([])
  })
})
