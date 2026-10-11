/*
 * PW-09 目标 RED（R7 DeepSeek / R8-R9 强化）。依据：独立设计 `reviews/web-pw09-ci-design-grok.md`
 * + R6 独立 review `reviews/web-round6-grok.md` §5 + R8 独审 `reviews/web-round8-codex.md` §2 I1。
 *
 * 现状：`client-web/scripts/verify-pitfalls.mjs` 已经在隔离真实 API/库上跑通
 * （5 条 PASS + 2 条 NOTE），在 CI 的 `pw09-pitfalls` 隔离 job 中真实执行并受 gate 约束。
 * 本文件对该 CI job 及 Gate 做严格判据约束与故障对照：
 *
 * ── 被验证的入口契约 ────────────────────────────────────────────────────────
 *   1. 存在一条真实执行 `client-web/scripts/verify-pitfalls.mjs` 的命令，
 *      所在 job 被 CI Gate 的 needs 消费；
 *   2. CI Gate 真的读 needs.<job>.result 并交给 check；
 *   3. CI Gate 严格仅接受 success（五态测试：failure/cancelled/skipped/empty 必须非 0）；
 *   4. 不得被 if: / continue-on-error / || true 架空；
 *   5. 数据库是本 job 自己的 Postgres（全新容器，随机密码由 step 写入 $GITHUB_ENV）；
 *   6. pim-api 必须 pin 到固定 SHA 3a038d9090512ab69365deaa27fcfa2f0e38a132；
 *   7. actions/setup-dotnet 从 pinned global.json 安装 SDK；
 *   8. API 连接键必须使用 ConnectionStrings__DefaultConnection；
 *   9. 健康检查要求 /health/ready（200 + Healthy）及未鉴权 /api/v1/status/（401），超时非 0；
 *  10. 一次性账号注册必须严格要求 HTTP 201 与业务码 code:0，且响应在内存解析、不打印正文；
*      该 step 还必须**从实际 YAML 取出来真实执行**（受控 curl 五态），而不是只匹配字符串
*      —— 只查字符串时，`sed "$d"` 这类在 `set -euo pipefail` 下必炸的写法能长期假绿（R9 独审 I1）。
 *  11. QA 脚本执行管道必须启用 pipefail；
 *  12. QA stdout 日志脱敏上传（pw09-qa-sanitized.log, if-no-files-found: error），资源无条件清理；
 *  13. 权限保持 contents: read，不得使用 pull_request_target。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import yaml from 'js-yaml'
import { afterAll, describe, expect, it } from 'vitest'
import { CLIENT_WEB, REPO_ROOT } from './_lib/contract'
import { realCommandLines } from './_lib/shell-build'

/* ── 类型与装载 ────────────────────────────────────────────── */

interface WfStep {
  name?: string
  run?: string
  uses?: string
  if?: string | boolean
  'continue-on-error'?: boolean | string
  env?: Record<string, string>
  with?: Record<string, unknown>
}

interface WfJob {
  name?: string
  needs?: string | string[]
  if?: string | boolean
  'continue-on-error'?: boolean | string
  env?: Record<string, string>
  services?: Record<string, { image?: string; env?: Record<string, string> }>
  steps?: WfStep[]
}

interface Wf {
  name?: string
  on?: unknown
  permissions?: Record<string, string>
  jobs?: Record<string, WfJob>
}

const CI_TEXT = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
const CI = yaml.load(CI_TEXT) as Wf

/** 已知的固定 API 参考 SHA（设计 §2） */
const API_SHA = '3a038d9090512ab69365deaa27fcfa2f0e38a132'

function jobRunText(job: WfJob): string {
  return (job.steps ?? []).map((s) => s.run ?? '').join('\n')
}

/** 真实执行 `scripts/verify-pitfalls.mjs` 的命令行（走与其它判据同一套过滤，echo 不算） */
function invocationOf(wf: Wf): { job: string; step: WfStep; command: string } | null {
  for (const [job, j] of Object.entries(wf.jobs ?? {})) {
    for (const step of j.steps ?? []) {
      for (const cmd of realCommandLines(step.run ?? '')) {
        if (/scripts\/verify-pitfalls\.mjs/.test(cmd)) return { job, step, command: cmd }
      }
    }
  }
  return null
}

const MISSING_JOB = 'CI 里没有真实执行 client-web/scripts/verify-pitfalls.mjs 的 job：PW-09 仍未实现'

/** 写进 `$GITHUB_ENV` 的变量名 + 含随机源的 step 序号 */
function secretPublishingSteps(job: WfJob): { index: number; names: string[]; random: boolean }[] {
  const out: { index: number; names: string[]; random: boolean }[] = []
  ;(job.steps ?? []).forEach((step, index) => {
    const run = step.run ?? ''
    const publishes = />>?\s*"?\$(?:\{)?GITHUB_ENV/.test(run)
    const random = /openssl\s+rand|rand\s+-hex|\/dev\/urandom/.test(run)
    if (!publishes) return
    const names: string[] = []
    for (const line of run.split('\n')) {
      if (!/\$(?:\{)?GITHUB_ENV/.test(line)) continue
      for (const m of line.matchAll(/([A-Za-z_][A-Za-z0-9_]*)=/g)) names.push(m[1]!)
    }
    out.push({ index, names, random })
  })
  return out
}

function runGateBash(gateScript: string, pw09Result: string): number {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    R_RESOLVE: 'success',
    R_WEB: 'success',
    R_SCRIPTS: 'success',
    R_SHELL_ANDROID: 'success',
    R_SHELL_TAURI: 'success',
    R_PR_METADATA: 'success',
    R_PW09: pw09Result,
  }
  try {
    execFileSync('bash', ['-c', gateScript], { env, stdio: 'pipe' })
    return 0
  } catch (err: unknown) {
    const e = err as { status?: number }
    return e.status ?? 1
  }
}

/* ── 判据（每条返回失败原因字符串，null = 通过） ───────────── */

const CRITERIA: Record<string, (wf: Wf) => string | null> = {
  /** 1 · 存在真实执行 QA 脚本的命令 */
  invocation: (wf) => (invocationOf(wf) ? null : MISSING_JOB),

  /** 1 · 跑它的 job 被 CI Gate 的 needs 消费 */
  gateNeeds: (wf) => {
    const found = invocationOf(wf)
    if (!found) return MISSING_JOB
    const gate = Object.values(wf.jobs ?? {}).find((j) => j.name === 'CI Gate')
    if (!gate) return 'ci.yml 里找不到名为 "CI Gate" 的 job'
    const needs = (Array.isArray(gate.needs) ? gate.needs : [gate.needs]).filter(
      (x): x is string => typeof x === 'string',
    )
    return needs.includes(found.job)
      ? null
      : `跑真实 QA 的 job（${found.job}）没有被 CI Gate 消费：它失败不会影响整体门禁`
  },

  /** 2 · Gate 真的读 needs.<job>.result 并交给 check */
  gateCheck: (wf) => {
    const found = invocationOf(wf)
    if (!found) return MISSING_JOB
    const gate = Object.values(wf.jobs ?? {}).find((j) => j.name === 'CI Gate')
    const step = (gate?.steps ?? []).find((s) => s.run)
    if (!step) return 'CI Gate 没有可执行的 run 步骤'
    const wired = Object.entries(step.env ?? {}).filter(([, tpl]) =>
      new RegExp(`needs\\.${found.job}\\.result`).test(tpl),
    )
    if (wired.length === 0) {
      return `CI Gate 没有从 needs.${found.job}.result 取值：job 失败不会让 Gate 失败`
    }
    for (const [key] of wired) {
      if (!(step.run ?? '').includes(`$${key}`)) {
        return `CI Gate 取了 ${key} 却没有把它交给 check（门禁没真的消费 ${found.job}）`
      }
    }
    return new RegExp(`check\\s+"?${found.job}"?`).test(step.run ?? '')
      ? null
      : `CI Gate 的 check 没有逐项判断 ${found.job}`
  },

  /** 3 · 不得被 if: / continue-on-error / || true 架空 */
  notNeutered: (wf) => {
    const found = invocationOf(wf)
    if (!found) return MISSING_JOB
    const job = wf.jobs![found.job]!
    if (job['continue-on-error'] !== undefined) return `job ${found.job} 声明了 continue-on-error`
    if (typeof job.if === 'string' && /pull_request|event_name/.test(job.if)) {
      return `job ${found.job} 的 if: 把真实 QA 限制成只在特定事件上跑（push 时会 skipped）`
    }
    for (const [i, step] of (job.steps ?? []).entries()) {
      if (step['continue-on-error'] !== undefined) {
        return `job ${found.job} 的 step #${i} "${step.name ?? ''}" 声明了 continue-on-error`
      }
      if (/\|\|\s*true\b|&&\s*true\b/.test(step.run ?? '')) {
        return `job ${found.job} 的 step #${i} "${step.name ?? ''}" 用 || true / && true 吞掉了失败`
      }
    }
    return null
  },

  /** 4 · 数据库必须是本 job 自己的隔离实例 */
  isolatedDb: (wf) => {
    const found = invocationOf(wf)
    if (!found) return MISSING_JOB
    const job = wf.jobs![found.job]!
    const text = jobRunText(job) + '\n' + JSON.stringify(job.services ?? {})
    if (!/postgres:\d+/.test(text)) return 'QA job 里没有 Postgres 镜像：它连的到底是哪个库？'
    for (const forbidden of [
      '15432', // 开发机 round1 隔离库端口
      '5433', // 开发机另一个在用实例
      '5858', // 本机真实 API
      'pim-r1-pg',
      'pim-pg-test',
      'pim_prod',
      'pim-pim-1', // 生产容器
      '127.0.0.1:5432',
      'localhost:5432',
    ]) {
      if (text.includes(forbidden)) return `QA job 指向了开发机/生产设施：${forbidden}`
    }
    return null
  },

  /** 5 · 随机密码只能由 step 生成并经 $GITHUB_ENV 传给后续 step */
  randomPassword: (wf) => {
    const found = invocationOf(wf)
    if (!found) return MISSING_JOB
    const job = wf.jobs![found.job]!
    for (const [name, svc] of Object.entries(job.services ?? {})) {
      if (Object.keys(svc.env ?? {}).includes('POSTGRES_PASSWORD')) {
        return (
          `services.${name} 声明了 POSTGRES_PASSWORD：服务容器的 env 在 steps 之前求值，` +
          `拿不到随机值；要么用 trust 认证，要么在 step 里自己起 Postgres`
        )
      }
    }
    const publishers = secretPublishingSteps(job)
    if (publishers.length === 0) {
      return 'QA job 没有「把随机数据库密码写进 $GITHUB_ENV」的步骤：随机密码这个形状不成立'
    }
    for (const p of publishers) {
      if (!p.random) {
        return `step #${p.index} 往 GITHUB_ENV 写了值却没有随机源：照抄常量不是隔离凭据`
      }
      if (p.names.length === 0) return `step #${p.index} 没有能从 GITHUB_ENV 行里解析出变量名`
    }
    const names = publishers.flatMap((p) => p.names)
    const usedLater = names.filter((name) => {
      const after = publishers[0]!.index
      return (job.steps ?? []).slice(after).some((step) =>
        new RegExp(`\\$\\{?${name}\\b`).test((step.run ?? '') + JSON.stringify(step.env ?? {})),
      )
    })
    return usedLater.length > 0
      ? null
      : `生成了随机密码（${names.join(', ')}）却没有任何后续 step 引用它：连接串没有真的用上`
  },

  /** 6 · pim-api 必须 pin 到固定 SHA */
  pinnedApi: (wf) => {
    const found = invocationOf(wf)
    if (!found) return MISSING_JOB
    const job = wf.jobs![found.job]!
    const text = jobRunText(job) + '\n' + JSON.stringify(job.steps ?? [])
    if (!text.includes(API_SHA)) return `QA job 没有 pin 到 pim-api ${API_SHA}`
    if (/ref:\s*(master|main)\b/.test(text)) {
      return 'QA job 用浮动分支拉取 pim-api：同样的 commit 会在不同时间跑出不同后端'
    }
    return null
  },

  /** 7 · 健康检查失败必须非 0（Postgres 就绪 + /health/ready 200 Healthy + /api/v1/status/ 401） */
  healthFails: (wf) => {
    const found = invocationOf(wf)
    if (!found) return MISSING_JOB
    const runs = jobRunText(wf.jobs![found.job]!)
    if (!/pg_isready/.test(runs)) return 'QA job 没有等待 Postgres 就绪（pg_isready）'
    if (!/\/health\/ready/.test(runs) || !/"status":"Healthy"/.test(runs)) {
      return 'QA job 必须等待 /health/ready 返回 200 及 Healthy（不得仅检查 /health/live）'
    }
    if (!/\/api\/v1\/status\//.test(runs) || !/"\$statusCode"\s*=\s*"401"/.test(runs)) {
      return 'QA job 必须等待未鉴权路由 /api/v1/status/ 返回 401'
    }
    if (!/exit\s+1/.test(runs)) {
      return 'QA job 的就绪轮询没有失败退出路径：起不来时它会「成功」结束'
    }
    return null
  },

  /** 8 · 权限与事件模型不得放宽 */
  permissions: (wf) => {
    const found = invocationOf(wf)
    if (!found) return MISSING_JOB
    if (wf.permissions?.['contents'] !== 'read') return 'ci.yml 顶部权限不是 contents: read'
    const text = jobRunText(wf.jobs![found.job]!) + JSON.stringify(wf.jobs![found.job]!)
    if (/contents:\s*write/.test(text)) return 'QA job 声明了 contents: write'
    return null
  },

  /** 9 · actions/setup-dotnet 绑定 pinned global.json */
  dotnetSetup: (wf) => {
    const found = invocationOf(wf)
    if (!found) return MISSING_JOB
    const job = wf.jobs![found.job]!
    const step = (job.steps ?? []).find((s) => s.uses?.startsWith('actions/setup-dotnet'))
    if (!step) return 'QA job 缺少 actions/setup-dotnet 步骤'
    const globalJson = String(step.with?.['global-json-file'] ?? '')
    if (!globalJson.includes('global.json')) return 'setup-dotnet 未绑定 global-json-file'
    return null
  },

  /** 10 · 必须使用 ConnectionStrings__DefaultConnection 键并引用 PW09_PG_PASSWORD */
  connectionKey: (wf) => {
    const found = invocationOf(wf)
    if (!found) return MISSING_JOB
    const job = wf.jobs![found.job]!
    const startStep = (job.steps ?? []).find((s) => (s.run ?? '').includes('dotnet run'))
    if (!startStep) return 'QA job 缺少启动 API 的步骤'
    const env = startStep.env ?? {}
    if (!('ConnectionStrings__DefaultConnection' in env)) {
      return 'API 启动步骤必须使用 ConnectionStrings__DefaultConnection 连接键（不得使用 Default 等错误键）'
    }
    if (!String(env['ConnectionStrings__DefaultConnection']).includes('PW09_PG_PASSWORD')) {
      return 'ConnectionStrings__DefaultConnection 未引用 PW09_PG_PASSWORD'
    }
    return null
  },

  /** 11 · 必须包含一次性账号注册且严格断言 HTTP 201 与 code:0，内存解析不打印正文 */
  registration: (wf) => {
    const found = invocationOf(wf)
    if (!found) return MISSING_JOB
    const job = wf.jobs![found.job]!
    const step = (job.steps ?? []).find((s) => (s.run ?? '').includes('/api/v1/auth/register'))
    if (!step?.run) return 'QA job 缺少一次性账号注册步骤（/api/v1/auth/register）'
    const run = step.run
    if (!/PW09_USER="qa_\$\(openssl rand -hex 4\)"/.test(run) || !/PW09_PASS=/.test(run)) {
      return '注册步骤未生成随机账号/密码'
    }
    if (!/::add-mask::/.test(run)) return '注册步骤未对 QA 密码添加 mask'
    if (!/PIM_TEST_USER=/.test(run) || !/PIM_TEST_PASS=/.test(run)) {
      return '注册步骤未将 PIM_TEST_USER / PIM_TEST_PASS 写入 $GITHUB_ENV'
    }
    if (!/if\s+\[\s+"\$http_code"\s+!=\s+"201"\s+\];\s*then/.test(run) || /"\$http_code"\s*!=\s*"200"/.test(run)) {
      return '注册步骤必须严格要求 HTTP 201，不得接受 200'
    }
    if (!/\bcode\b/.test(run) || !/(?:node|python|jq)/.test(run)) {
      return '注册步骤必须在内存中解析响应体并断言 code=0'
    }
    // Token/body protection: 不得直接 echo $reg_body 或 echo $reg_resp 或 cat register.json 泄漏到 stdout
    if (/(?:^|\n)\s*echo\s+"?\$(?:reg_body|reg_resp)"?\s*(?:$|\n|;)/.test(run) || /cat\s+.*register\.json/.test(run)) {
      return '注册步骤不得打印含敏感凭据的注册响应正文'
    }
    return null
  },

  /** 12 · QA 脚本管道必须启用 pipefail 避免失败被 tee 吞掉 */
  qaPipeline: (wf) => {
    const found = invocationOf(wf)
    if (!found) return MISSING_JOB
    const job = wf.jobs![found.job]!
    const step = (job.steps ?? []).find((s) => (s.run ?? '').includes('scripts/verify-pitfalls.mjs'))
    if (!step?.run) return '缺少 QA 执行步骤'
    if (!/set\s+(-[a-zA-Z]*o\s+pipefail|-euo\s+pipefail)/.test(step.run)) {
      return 'QA 执行步骤使用管道时必须设置 pipefail（避免失败被 tee 吞掉）'
    }
    return null
  },

  /** 13 · QA 日志脱敏上传与无条件清理 */
  safeUploadAndCleanup: (wf) => {
    const found = invocationOf(wf)
    if (!found) return MISSING_JOB
    const job = wf.jobs![found.job]!
    const steps = job.steps ?? []
    const sanitizeStep = steps.find((s) => (s.run ?? '').includes('pw09-qa-sanitized.log'))
    if (!sanitizeStep) return '缺少 QA 日志脱敏步骤'
    if (sanitizeStep.if !== 'always()') return '脱敏步骤必须为 if: always()'
    if (!/(?:accessToken|refreshToken|Authorization|PIM_TEST_PASS|Password|password)/.test(sanitizeStep.run ?? '')) {
      return '脱敏步骤未过滤敏感字段/关键词'
    }
    const uploadStep = steps.find((s) => s.uses?.startsWith('actions/upload-artifact'))
    if (!uploadStep) return '缺少 upload-artifact 步骤'
    if (uploadStep.if !== 'always()') return 'upload-artifact 步骤必须为 if: always()'
    if (uploadStep.with?.['if-no-files-found'] !== 'error') {
      return 'upload-artifact 必须设置 if-no-files-found: error'
    }
    const cleanupStep = steps.find((s) => s.name?.includes('Cleanup isolated resources'))
    if (!cleanupStep) return '缺少 Cleanup isolated resources 步骤'
    if (cleanupStep.if !== 'always()') return '清理步骤必须为 if: always()'
    if (!/docker\s+rm\s+-f\s+pw09-pg/.test(cleanupStep.run ?? '')) return '清理步骤未清理 Postgres 容器'
    if (!/kill/.test(cleanupStep.run ?? '')) return '清理步骤未停止 API 进程'
    return null
  },

  /** 14 · CI Gate 严格仅接受 success，五态评估（success=0，failure/cancelled/skipped/empty!=0） */
  gateStrictSuccess: (wf) => {
    const gate = Object.values(wf.jobs ?? {}).find((j) => j.name === 'CI Gate')
    const step = (gate?.steps ?? []).find((s) => s.run)
    if (!step?.run) return 'CI Gate 没有可执行的 run 步骤'
    const script = step.run
    if (/\b(?:skipped)\b/.test(script) && /\[\s*"\$result"\s*=\s*"skipped"\s*\]/.test(script)) {
      return 'Gate 把 skipped 判定为成功放行'
    }
    if (!/\[\s*"\$result"\s*=\s*"success"\s*\]/.test(script)) {
      return 'Gate 没有严格要求 result 等于 success'
    }
    for (const badState of ['failure', 'cancelled', 'skipped', '']) {
      const exitCode = runGateBash(script, badState)
      if (exitCode === 0) {
        return `Gate 在 R_PW09="${badState}" 状态下异常返回 0`
      }
    }
    if (runGateBash(script, 'success') !== 0) {
      return 'Gate 在全部 success 状态下未返回 0'
    }
    return null
  },
}

function evaluate(wf: Wf): Record<string, string | null> {
  return Object.fromEntries(Object.entries(CRITERIA).map(([k, fn]) => [k, fn(wf)]))
}

/** 对当前 ci.yml 逐条判据的结论 */
const CURRENT = evaluate(CI)

/* ── 目标 RED（当前应为红） ────────────────────────────────── */

describe('PW-09：真实 QA 脚本必须由 CI 隔离 job 真实执行，并让现有 CI Gate 失败', () => {
  it('（RED）存在真实执行 scripts/verify-pitfalls.mjs 的命令，且所在 job 被 CI Gate 消费', () => {
    expect(CURRENT.invocation, MISSING_JOB).toBeNull()
    expect(CURRENT.gateNeeds).toBeNull()
  })

  it('（RED）CI Gate 必须真的读该 job 的 needs.<job>.result 并交给 check', () => {
    expect(CURRENT.gateCheck, MISSING_JOB).toBeNull()
  })

  it('（RED）QA job 不得被 if: / continue-on-error / || true 架空', () => {
    expect(CURRENT.notNeutered, MISSING_JOB).toBeNull()
  })

  it('（RED）必须是本 job 自己的 Postgres，不得指向开发机或生产', () => {
    expect(CURRENT.isolatedDb, MISSING_JOB).toBeNull()
  })

  it('（RED）随机密码必须由 step 生成并写进 $GITHUB_ENV（services: 的 env 读不到未来 step 的值）', () => {
    expect(CURRENT.randomPassword, MISSING_JOB).toBeNull()
  })

  it('（RED）pim-api 必须 pin 到固定 SHA，不得用浮动分支', () => {
    expect(CURRENT.pinnedApi, MISSING_JOB).toBeNull()
  })

  it('（RED）健康检查必须能失败：pg_isready + API 就绪轮询，超时非 0', () => {
    expect(CURRENT.healthFails, MISSING_JOB).toBeNull()
  })

  it('（RED）权限与事件模型不得放宽（contents: read，无 pull_request_target / contents: write）', () => {
    expect(CURRENT.permissions, MISSING_JOB).toBeNull()
    expect(/pull_request_target/.test(CI_TEXT), 'ci.yml 使用了 pull_request_target').toBe(false)
  })

  it('（RED）actions/setup-dotnet 必须绑定 pinned global.json', () => {
    expect(CURRENT.dotnetSetup, MISSING_JOB).toBeNull()
  })

  it('（RED）API 必须使用 ConnectionStrings__DefaultConnection 并引用随机密码', () => {
    expect(CURRENT.connectionKey, MISSING_JOB).toBeNull()
  })

  it('（RED）必须包含一次性账号注册且严格断言 HTTP 201 与 code:0，内存解析不打印正文', () => {
    expect(CURRENT.registration, MISSING_JOB).toBeNull()
  })

  it('（RED）QA 脚本管道必须启用 pipefail 避免失败被 tee 吞掉', () => {
    expect(CURRENT.qaPipeline, MISSING_JOB).toBeNull()
  })

  it('（RED）QA 必须包含日志脱敏上传与无条件清理步骤', () => {
    expect(CURRENT.safeUploadAndCleanup, MISSING_JOB).toBeNull()
  })

  it('（RED）CI Gate 必须严格仅接受 success，五态测试（failure/cancelled/skipped/empty 非 0）', () => {
    expect(CURRENT.gateStrictSuccess, MISSING_JOB).toBeNull()
  })
})

/* ── 判据自身的故障对照（证明这些 RED 不是恒真/恒假） ───────── */

/*
 * `GOOD_WORKFLOW`：满足上面全部判据的**最小形状**。
 */
const GOOD_WORKFLOW = `name: CI
on:
  push:
    branches: [master]
  pull_request:
    branches: [master]
    types: [opened, synchronize, reopened, edited]
  workflow_dispatch:
permissions:
  contents: read
jobs:
  pw09-pitfalls:
    name: Real QA against an isolated backend
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Checkout the pinned pim-api reference
        uses: actions/checkout@v4
        with:
          repository: 2746267826/pim-api
          ref: ${API_SHA}
          path: .pw09/pim-api
      - name: Setup .NET SDK from pinned global.json
        uses: actions/setup-dotnet@v4
        with:
          global-json-file: .pw09/pim-api/global.json
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - name: Start this job's own Postgres with a per-run random password
        run: |
          set -euo pipefail
          PW09_PG_PASSWORD="$(openssl rand -hex 16)"
          echo "::add-mask::$PW09_PG_PASSWORD"
          echo "PW09_PG_PASSWORD=$PW09_PG_PASSWORD" >> "$GITHUB_ENV"
          docker run -d --name pw09-pg \\
            -e POSTGRES_USER=pim -e POSTGRES_DB=pim \\
            -e POSTGRES_PASSWORD="$PW09_PG_PASSWORD" \\
            -p 127.0.0.1:65432:5432 postgres:16-alpine
      - name: Wait for Postgres to accept connections
        run: |
          set -euo pipefail
          for i in $(seq 1 30); do
            if docker exec pw09-pg pg_isready -U pim >/dev/null 2>&1; then break; fi
            sleep 1
            if [ "$i" = "30" ]; then exit 1; fi
          done
      - name: Start the pinned API against this job's database
        env:
          ASPNETCORE_ENVIRONMENT: Development
          ASPNETCORE_URLS: http://127.0.0.1:18082
          ConnectionStrings__DefaultConnection: Host=127.0.0.1;Port=65432;Database=pim;Username=pim;Password=\${{ env.PW09_PG_PASSWORD }}
        run: |
          set -euo pipefail
          cd .pw09/pim-api
          dotnet run --project src/Pim.Api/Pim.Api.csproj --no-launch-profile > /tmp/pw09-api.log 2>&1 &
          echo $! > /tmp/pw09-api.pid
      - name: Wait for API ready and bootstrap one-off test account
        run: |
          set -euo pipefail
          for i in $(seq 1 60); do
            code=$(curl -s -o /tmp/pw09-ready.json -w '%{http_code}' http://127.0.0.1:18082/health/ready) || code=000
            if [ "$code" = "200" ] && grep -q '"status":"Healthy"' /tmp/pw09-ready.json 2>/dev/null; then
              statusCode=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18082/api/v1/status/) || statusCode=000
              if [ "$statusCode" = "401" ]; then
                break
              fi
            fi
            sleep 1
            if [ "$i" = "60" ]; then exit 1; fi
          done
          PW09_USER="qa_$(openssl rand -hex 4)"
          PW09_PASS="Qa_$(openssl rand -hex 8)!"
          echo "::add-mask::$PW09_PASS"
          echo "PIM_TEST_USER=$PW09_USER" >> "$GITHUB_ENV"
          echo "PIM_TEST_PASS=$PW09_PASS" >> "$GITHUB_ENV"
          reg_resp=$(curl -s -w '\\n%{http_code}' -X POST http://127.0.0.1:18082/api/v1/auth/register \\
            -H 'Content-Type: application/json' \\
            -d "{\\"username\\":\\"$PW09_USER\\",\\"email\\":\\"$PW09_USER@example.com\\",\\"password\\":\\"$PW09_PASS\\"}")
          http_code=$(echo "$reg_resp" | tail -n 1)
          if [ "$http_code" != "201" ]; then
            echo "Registration failed with HTTP $http_code"
            exit 1
          fi
          reg_body=$(echo "$reg_resp" | sed '$d')
          reg_code=$(node -e '
            const resp = process.argv[1] ? JSON.parse(process.argv[1]) : {};
            if (resp.code !== 0) {
              process.exit(1);
            }
          ' "$reg_body" 2>/dev/null && echo 0 || echo 1)
          if [ "$reg_code" != "0" ]; then
            echo "Registration returned non-zero business code"
            exit 1
          fi
      - name: Run the real QA script against the isolated backend
        working-directory: client-web
        run: |
          set -euo pipefail
          node scripts/verify-pitfalls.mjs | tee /tmp/pw09-qa.log
      - name: Sanitize and upload QA stdout artifact
        if: always()
        run: |
          set -euo pipefail
          sed -E '/(accessToken|refreshToken|Authorization|PIM_TEST_PASS|Password|password)/Id' /tmp/pw09-qa.log > /tmp/pw09-qa-sanitized.log
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: pw09-pitfalls-qa-log
          path: /tmp/pw09-qa-sanitized.log
          if-no-files-found: error
      - name: Cleanup isolated resources
        if: always()
        run: |
          if [ -f /tmp/pw09-api.pid ]; then
            kill -9 "\$(cat /tmp/pw09-api.pid)" 2>/dev/null || code=0
          fi
          docker rm -f pw09-pg >/dev/null 2>&1 || code=0
  gate:
    name: CI Gate
    needs: [pw09-pitfalls]
    if: always()
    runs-on: ubuntu-latest
    steps:
      - name: Evaluate required jobs
        env:
          R_PW09: \${{ needs.pw09-pitfalls.result }}
        run: |
          set -uo pipefail
          fail=0
          check () {
            local label="$1" result="$2"
            if [ "$result" = "success" ]; then echo "ok $label"; else echo "bad $label"; fail=1; fi
          }
          check "pw09-pitfalls" "$R_PW09"
          if [ "$fail" -ne 0 ]; then exit 1; fi
`

const GOOD = yaml.load(GOOD_WORKFLOW) as Wf

const SAFE_UPLOAD_AND_CLEANUP_BLOCK = `      - name: Sanitize and upload QA stdout artifact
        if: always()
        run: |
          set -euo pipefail
          sed -E '/(accessToken|refreshToken|Authorization|PIM_TEST_PASS|Password|password)/Id' /tmp/pw09-qa.log > /tmp/pw09-qa-sanitized.log
      - uses: actions/upload-artifact@v4
        if: always()
        with:
          name: pw09-pitfalls-qa-log
          path: /tmp/pw09-qa-sanitized.log
          if-no-files-found: error
      - name: Cleanup isolated resources
        if: always()
        run: |
          if [ -f /tmp/pw09-api.pid ]; then
            kill -9 "\$(cat /tmp/pw09-api.pid)" 2>/dev/null || code=0
          fi
          docker rm -f pw09-pg >/dev/null 2>&1 || code=0`

describe('PW-09 判据的故障对照：好形状必须全过，每一处精准 mutant 必须打红对应判据', () => {
  it('GOOD_WORKFLOW 满足全部判据（判据不是恒假）', () => {
    const result = evaluate(GOOD)
    const failed = Object.entries(result)
      .filter(([, v]) => v !== null)
      .map(([k, v]) => `${k}: ${v}`)
    expect(failed, `GOOD_WORKFLOW 没能满足这些判据：\n${failed.join('\n')}`).toEqual([])
  })

  const mutants: [string, string, string, string][] = [
    [
      'invocation',
      '把脚本执行换成 echo',
      'node scripts/verify-pitfalls.mjs',
      'echo node scripts/verify-pitfalls.mjs',
    ],
    [
      'gateNeeds',
      '把 pw09-pitfalls 从 gate.needs 里删掉',
      'needs: [pw09-pitfalls]',
      'needs: []',
    ],
    [
      'gateCheck',
      '把 gate 里对该 job 结果的 check 删掉',
      'check "pw09-pitfalls" "$R_PW09"',
      'echo "skip pw09"',
    ],
    [
      'notNeutered',
      '给脚本执行 step 加 continue-on-error',
      '      - name: Run the real QA script against the isolated backend\n        working-directory: client-web\n        run:',
      '      - name: Run the real QA script against the isolated backend\n        continue-on-error: true\n        working-directory: client-web\n        run:',
    ],
    [
      'isolatedDb',
      '把库端口指向开发机隔离实例 15432',
      '-p 127.0.0.1:65432:5432',
      '-p 127.0.0.1:15432:5432',
    ],
    [
      'randomPassword',
      '去掉生成随机密码的步骤形状（改成照抄常量）',
      'PW09_PG_PASSWORD="$(openssl rand -hex 16)"',
      'PW09_PG_PASSWORD="pw09-fixed-password"',
    ],
    [
      'pinnedApi',
      '把 pim-api 的 ref 从固定 SHA 换成浮动分支',
      `ref: ${API_SHA}`,
      'ref: master',
    ],
    [
      'healthFails',
      '去掉 Postgres 就绪检查',
      'if docker exec pw09-pg pg_isready -U pim >/dev/null 2>&1; then break; fi',
      'true',
    ],
    [
      'healthFails',
      '把 /health/ready 改成 /health/live',
      '/health/ready',
      '/health/live',
    ],
    [
      'dotnetSetup',
      '去掉 setup-dotnet 步骤',
      '- name: Setup .NET SDK from pinned global.json\n        uses: actions/setup-dotnet@v4\n        with:\n          global-json-file: .pw09/pim-api/global.json',
      '# no dotnet setup',
    ],
    [
      'connectionKey',
      '把连接键改回错误的 ConnectionStrings__Default',
      'ConnectionStrings__DefaultConnection:',
      'ConnectionStrings__Default:',
    ],
    [
      'registration',
      '删除一次性账号注册步骤',
      '          PW09_USER="qa_$(openssl rand -hex 4)"',
      '          # no registration',
    ],
    [
      'qaPipeline',
      '删除 QA 管道的 set -euo pipefail',
      '          set -euo pipefail\n          node scripts/verify-pitfalls.mjs | tee /tmp/pw09-qa.log',
      '          node scripts/verify-pitfalls.mjs | tee /tmp/pw09-qa.log',
    ],
    [
      'safeUploadAndCleanup',
      '删除脱敏上传与 cleanup 步骤',
      SAFE_UPLOAD_AND_CLEANUP_BLOCK,
      '      - name: Dummy cleanup\n        run: echo done',
    ],
    [
      'gateStrictSuccess',
      '让 Gate 把 skipped 当成成功',
      'if [ "$result" = "success" ]; then',
      'if [ "$result" = "success" ] || [ "$result" = "skipped" ]; then',
    ],
  ]

  for (const [criterion, label, from, to] of mutants) {
    it(`mutant · ${label} ⇒ ${criterion} 必须打红`, () => {
      const mutated = GOOD_WORKFLOW.replace(from, to)
      expect(mutated, `mutant 注入没有生效（fixture 漂移）：${from}`).not.toBe(GOOD_WORKFLOW)
      expect(
        evaluate(yaml.load(mutated) as Wf)[criterion],
        `${label} 之后 ${criterion} 仍然通过：这条判据打不中它要挡的假绿`,
      ).not.toBeNull()
    })
  }

  it('mutant · 权限放宽成 contents: write ⇒ permissions 必须打红', () => {
    const mutated = GOOD_WORKFLOW.replace('permissions:\n  contents: read', 'permissions:\n  contents: write')
    expect(mutated).not.toBe(GOOD_WORKFLOW)
    expect(evaluate(yaml.load(mutated) as Wf).permissions).not.toBeNull()
  })

  it('mutant · services: 里写死 POSTGRES_PASSWORD（设计里的错误形状）必须打红', () => {
    const mutated = GOOD_WORKFLOW.replace(
      '    runs-on: ubuntu-latest\n    steps:',
      [
        '    runs-on: ubuntu-latest',
        '    services:',
        '      postgres:',
        '        image: postgres:16-alpine',
        '        env:',
        '          POSTGRES_PASSWORD: postgres',
        '    steps:',
      ].join('\n'),
    )
    expect(mutated).not.toBe(GOOD_WORKFLOW)
    expect(
      evaluate(yaml.load(mutated) as Wf).randomPassword,
      'services.env 里写死密码被判为「随机密码形状成立」：照抄的设计又回来了',
    ).not.toBeNull()
  })

  it('mutant · gate 读了 result 却没交给 check（取值不消费）必须打红', () => {
    const mutated = GOOD_WORKFLOW.replace('check "pw09-pitfalls" "$R_PW09"', 'echo "$R_PW09"')
    expect(mutated).not.toBe(GOOD_WORKFLOW)
    expect(evaluate(yaml.load(mutated) as Wf).gateCheck).not.toBeNull()
  })
})

/* ── 注册 step 必须真的能跑：从实际 YAML 提取并注入受控 curl 响应 ─────────
 *
 * R9 独审 I1：`registration` 判据只做**字符串**检查，所以 `sed "$d"`（`d` 未定义，
 * 在 step 自己的 `set -euo pipefail` 下必然 `unbound variable` 退出）能长期假绿 ——
 * 夹具 `GOOD_WORKFLOW` 用的是正确的 `sed '$d'`，生产 workflow 却没人真跑过。
 *
 * 这里把**实际 ci.yml 里的注册 step** 取出来真实执行，只把 `curl` 换成受控响应：
 * 合法 201/code0 必须退出 0，四类受控负例必须非 0 且失败原因来自业务判定，
 * 输出里不得出现响应正文标记或生成的测试密码。
 * 同一套 harness 同时跑夹具 `GOOD_WORKFLOW` 作为正对照，证明它不是恒假。
 */

/** 受控响应正文里的哨兵：只要它出现在 step 输出里，就说明正文被打印了 */
const REGISTER_SENTINEL = 'pw09-sentinel-2f4c1a7b'

const REGISTER_STEP_MISSING = '注册 step 不存在或不再可独立执行'
const REGISTER_MARKER_MISSING = '注册 step 缺少 PW09_USER 赋值（写法变了，判据需要同步）'
const REGISTER_SHELL_MISSING = '注册 step 没有 set -euo pipefail（shell 选项被移除，判据需要同步）'

/**
 * 从实际 workflow YAML 里取出注册 step 的**可执行片段**：保留 step 自己的 shell
 * 选项行和注册块本身（就绪轮询部分要用真实 API，不在这里重造，另由真实隔离链覆盖）。
 */
function registrationScript(wf: Wf): string {
  const found = invocationOf(wf)
  if (!found) throw new Error(MISSING_JOB)
  const step = (wf.jobs![found.job]!.steps ?? []).find((s) =>
    (s.run ?? '').includes('/api/v1/auth/register'),
  )
  if (!step?.run) throw new Error(REGISTER_STEP_MISSING)
  const shellMode = step.run.split('\n').find((line) => line.trim() === 'set -euo pipefail')
  if (!shellMode) throw new Error(REGISTER_SHELL_MISSING)
  const marker = step.run.indexOf('PW09_USER=')
  if (marker < 0) throw new Error(REGISTER_MARKER_MISSING)
  const start = step.run.lastIndexOf('\n', marker) + 1
  return `${shellMode.trim()}\n${step.run.slice(start)}`
}

interface RegistrationRun {
  status: number
  output: string
  /** step 写进 $GITHUB_ENV 的内容，用来检查生成的密码没有被打印 */
  env: string
}

/**
 * 捕获到的输出在进入断言消息（会在失败时被打印）之前先遮蔽 `::add-mask::` 的值：
 * runner 会消费该行，但测试框架不会，直接回显等于把一次性密码写进测试日志。
 */
function redactMasked(output: string): string {
  return output.replace(/(::add-mask::)\S+/g, '$1<masked>')
}

/**
 * 执行注册 step：`curl` 被替换成打印 `FAKE_BODY` + HTTP 码的 shell 函数，
 * 语义与 step 里的 `-w '\n%{http_code}'` 一致（正文一行 + 状态码一行）。
 */
function runRegistrationStep(script: string, http: string, body: string): RegistrationRun {
  const dir = mkdtempSync(path.join(tmpdir(), 'pw09-registration.'))
  try {
    const envFile = path.join(dir, 'github-env')
    writeFileSync(envFile, '')
    const prelude = `curl(){ printf '%s\\n%s\\n' "$FAKE_BODY" "$FAKE_HTTP"; }\nexport -f curl\n`
    const readEnv = (): string => {
      try {
        return readFileSync(envFile, 'utf8')
      } catch {
        return ''
      }
    }
    try {
      const out = execFileSync('bash', ['-c', prelude + script], {
        env: { ...process.env, FAKE_HTTP: http, FAKE_BODY: body, GITHUB_ENV: envFile },
        encoding: 'utf8',
        timeout: 60_000,
      })
      return { status: 0, output: redactMasked(String(out)), env: readEnv() }
    } catch (err) {
      const e = err as { status?: number; stdout?: string; stderr?: string }
      return {
        status: e.status ?? -1,
        output: redactMasked(`${e.stdout ?? ''}${e.stderr ?? ''}`),
        env: readEnv(),
      }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('PW-09：实际 ci.yml 的注册 step 必须真的跑得通，不是只被检查字符串', () => {
  it('（RED）合法 201/code:0 必须退出 0', () => {
    const script = registrationScript(CI)
    const r = runRegistrationStep(script, '201', `{"code":0,"accessToken":"${REGISTER_SENTINEL}"}`)
    expect(
      r.output,
      `合法注册响应把哨兵正文打印到了输出：${REGISTER_SENTINEL}`,
    ).not.toContain(REGISTER_SENTINEL)
    expect(
      r.status,
      `合法的 201/code:0 注册响应被判定为失败（实际退出 ${r.status}）：\n${r.output.slice(-500)}`,
    ).toBe(0)
  })

  it('受控负例必须非 0，失败原因来自业务判定，且不打印正文/密码', () => {
    const cases: [string, string, string, RegExp][] = [
      ['HTTP 200 + code:0（必须严格要求 201）', '200', '{"code":0}', /Registration failed with HTTP 200/],
      ['HTTP 201 + code:1', '201', '{"code":1}', /non-zero business code/],
      ['HTTP 201 + 只在文本里出现 code:0', '201', '{"message":"code:0"}', /non-zero business code/],
      ['HTTP 201 + 非法 JSON', '201', 'not-json', /non-zero business code/],
    ]
    const failures: string[] = []
    for (const [label, http, body, diagnostic] of cases) {
      const r = runRegistrationStep(registrationScript(CI), http, body)
      if (r.status === 0) {
        failures.push(`${label}：退出 0，fail-closed 失效`)
      } else if (!diagnostic.test(r.output)) {
        failures.push(`${label}：失败原因不是业务判定（输出：${r.output.slice(-200)}）`)
      }
      if (r.output.includes(REGISTER_SENTINEL)) failures.push(`${label}：输出了响应正文`)
      // `::add-mask::<password>` 是 GitHub 要求的遮蔽指令（runner 会消费该行），
      // 只有它**以外**的输出出现密码才算泄漏。
      const visible = r.output
        .split('\n')
        .filter((line) => !line.trimStart().startsWith('::add-mask::'))
        .join('\n')
      const password = /^PIM_TEST_PASS=(.*)$/m.exec(r.env)?.[1]
      if (password && visible.includes(password)) failures.push(`${label}：输出了 step 自己生成的测试密码`)
    }
    expect(failures, failures.join('\n')).toEqual([])
  })

  it('正对照：同一 harness 下夹具 GOOD_WORKFLOW 的注册 step 必须退出 0（harness 不是恒假）', () => {
    const script = registrationScript(GOOD)
    const ok = runRegistrationStep(script, '201', '{"code":0}')
    expect(
      ok.status,
      `夹具里的正确注册 step 也没通过 harness（实际退出 ${ok.status}）：\n${ok.output.slice(-500)}`,
    ).toBe(0)
    const bad = runRegistrationStep(script, '201', '{"code":1}')
    expect(bad.status, '夹具 + code:1 也退出 0：harness 打不中非零业务码').not.toBe(0)
  })
})

/* ── 脚本侧：⑤/④b 仍是 NOTE，Outlook 只做形状观察 ───────── */

describe('PW-09：脚本结论不得被改成恒真（⑤ / ④b 仍 NOTE，Outlook 只观察形状）', () => {
  const SRC = readFileSync(path.join(CLIENT_WEB, 'scripts', 'verify-pitfalls.mjs'), 'utf8')

  it('⑤ 302 下载与 ④b 无斜杠 status 必须仍是 note()，不得改成 ok()', () => {
    expect(SRC, '⑤ 302 下载被改成了 ok() 断言：没有 OneDrive 绑定就没有可判定证据').not.toMatch(
      /ok\(\s*['"`]⑤/,
    )
    expect(SRC, '⑤ 302 下载不再是 note()（判据可能被删或被恒真化）').toMatch(/note\(\s*['"`]⑤/)
    expect(SRC, '④ 无斜杠 status 被改成了 ok() 断言：没有期望值就不能算 PASS').not.toMatch(
      /ok\(\s*['"`]④\s*status\s*无斜杠/,
    )
    expect(SRC, '④ 无斜杠 status 不再是 note()').toMatch(/note\(\s*['"`]④\s*status\s*无斜杠/)
  })

  it('③ Outlook 只断言「响应形状里有 total 字段」，不得写成真实同步已通过', () => {
    expect(
      SRC,
      '③ Outlook 的断言不是「字段存在」这一形状观察，可能已升级成真实同步 PASS',
    ).toMatch(/ok\(\s*['"`]③[^'"`]*['"`]\s*,\s*'total'\s+in\s/)
    expect(
      SRC,
      '③ 被写成了「Outlook 同步已通过」这类没有绑定就证明不了的结论',
    ).not.toMatch(/ok\(\s*['"`]③[^'"`]*(同步成功|已同步|sync\s+passed)/i)
  })

  it('脚本必须把 NOTE 项与 PASS 项分开输出，并从 FAIL 推导退出码', () => {
    expect(SRC, '脚本摘要没有把未验证项标成 NOT-VERIFIED').toMatch(/NOT-VERIFIED/)
    expect(
      SRC,
      '脚本退出码不是由 FAIL 数量推导（可能变成恒 0）',
    ).toMatch(/process\.exitCode\s*=\s*fails\.length\s*\?\s*1\s*:\s*0/)
  })
})

/* ── 环境故障必须非 0（真实执行脚本，不需要活后端） ─────────── */

const TMP = path.join(CLIENT_WEB, 'audit-tests', '.tmp-pw09')

/**
 * 把 `scripts/` 复制到**没有 `.env`** 的隔离目录再执行：
 * `env.mjs` 会读 `../.env`，源树里的 `.env` 是 gitignore 的本机文件，不能让它
 * 影响「缺环境变量必须非 0」这条对照。
 */
function isolatedScripts(): string {
  const dir = path.join(TMP, 'scripts')
  rmSync(TMP, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  for (const f of ['env.mjs', 'verify-pitfalls.mjs']) {
    cpSync(path.join(CLIENT_WEB, 'scripts', f), path.join(dir, f))
  }
  return path.join(dir, 'verify-pitfalls.mjs')
}

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
      srv.close(() => resolve(addr.port))
    })
  })
}

interface RunResult {
  status: number
  output: string
}

function runPitfalls(script: string, env: Record<string, string | undefined>): RunResult {
  const clean: NodeJS.ProcessEnv = { ...process.env }
  for (const k of ['PIM_API_TARGET', 'PIM_TEST_USER', 'PIM_TEST_PASS']) delete clean[k]
  for (const [k, v] of Object.entries(env)) if (v !== undefined) clean[k] = v
  try {
    const out = execFileSync('node', [script], { cwd: TMP, env: clean, timeout: 60_000 })
    return { status: 0, output: String(out) }
  } catch (err) {
    const e = err as { status?: number; stdout?: Buffer; stderr?: Buffer }
    return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('PW-09：环境/凭据故障必须非 0（不得把环境错误算成 PASS）', () => {
  it('缺 PIM_API_TARGET / 测试账号时脚本必须非 0 退出', () => {
    const r = runPitfalls(isolatedScripts(), {
      PIM_API_TARGET: undefined,
      PIM_TEST_USER: undefined,
      PIM_TEST_PASS: undefined,
    })
    expect(r.status, `缺环境变量时脚本退出 0（输出：${r.output.slice(0, 200)}）`).not.toBe(0)
    expect(r.output, '缺少环境变量时没有明确报错').toMatch(/PIM_API_TARGET|PIM_TEST_USER|PIM_TEST_PASS/)
  })

  it('连不上后端（错误地址）时脚本必须非 0 退出', async () => {
    const port = await pickFreePort()
    const r = runPitfalls(isolatedScripts(), {
      PIM_API_TARGET: `http://127.0.0.1:${port}`,
      PIM_TEST_USER: 'pw09_ci_control',
      PIM_TEST_PASS: 'pw09_ci_control_pass',
    })
    expect(
      r.status,
      `后端连不上时脚本退出 0（输出：${r.output.slice(0, 200)}）：环境错误被当成了 PASS`,
    ).not.toBe(0)
  })
})
