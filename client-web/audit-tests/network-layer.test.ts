/*
 * PW-18：429 必须尊重 Retry-After 的真实语义。
 * PW-08：绕开统一传输的生产调用点必须逐条有依据（ICS 的真实用户动作见 ics-user-action.test.tsx）。
 * PW-07 / F-11：宿主会话协议（BLOCKED）——本轮只留护栏，不写会接受「把令牌写进存储」的断言。
 *
 * 判定方式已按第二轮 review 返工：
 * - 不再用第二个自写 AST 分析器（它曾把 server-form 已经检查过的 res.ok 判成违规，
 *   造出一个不存在的 PW-N2）；改用与契约测试同一条真实抽取管线 + 逐条固定清单；
 * - ICS 的「相对路径 + 无条件成功提示」由真实组件/用户动作测试覆盖，不再靠文本启发式；
 *   Round 3 已把 ICS 接进统一传输，故该清单从 4 条缩短为 2 条。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { ApiError, apiFetch, clearTokens, resetRefreshState, setTokens } from '@/api/client'
import { extractCallSites } from './_lib/callsites'
import { CLIENT_WEB } from './_lib/contract'

/* ── 绕开统一传输的生产调用点（真实抽取，逐条固定） ───────────── */

const RAW_FETCH_SITES = extractCallSites()
  .filter((s) => s.level === 'business' && s.wrapper === 'fetch')
  .map((s) => `${s.file}:${s.line}`)
  .sort()

interface RawFetchEvidence {
  where: string
  reason: string
}

/**
 * 逐条依据（不是白名单字符串匹配：数量/位置变化都会让断言失败，必须人工复核）。
 * `RED` 表示该处仍是待修缺陷，RED 由真实组件测试看守。
 */
const RAW_FETCH_EVIDENCE: RawFetchEvidence[] = [
  {
    where: 'src/features/files/upload-engine.ts:195',
    reason:
      '第三方预授权 URL：目标地址来自服务端响应字段 session.uploadUrl，客户端表达式决定不了，不能套 apiUrl()。',
  },
  {
    /*
     * 行号在 Round 5 由 59 → 60：host 通道的服务器地址守卫给 server-form 加了
     * 一行 import（`detectHostChannel`），这处 `fetch(candidateUrl(value, '/api/version')`
     * 本身没有改动（下面的 PW-N2 用例仍然按源码文本核对 res.ok 检查）。这正是
     * 这份清单要求「移动必须人工复核」的场景：复核结论是无行为变化。
     */
    where: 'src/features/server/server-form.tsx:60',
    reason:
      '连通性探测：用 candidateUrl(value, …) 拼候选地址，并已在其后检查 res.ok（PW-N2 不成立，已在第二轮撤销）。',
  },
  /*
   * ICS 导出/导入（原 settings-pages.tsx:820/866）已在 Round 3 接进统一传输
   * （fetchBlob(..., { refreshOn401: true }) / apiUpload），因此**不再**出现在这份
   * 「绕开统一传输」清单里；由 ics-user-action.test.tsx 看守。
   * 清单允许因正确修复而变短，但新增/移动必须人工复核。
   */
]

describe('PW-08：绕开统一传输的生产调用点必须逐条有依据', () => {
  it('清单被逐条固定住（新增/移动都会失败，必须人工复核）', () => {
    expect(RAW_FETCH_SITES).toEqual(RAW_FETCH_EVIDENCE.map((e) => e.where).sort())
  })

  it('每条依据都必须写明理由', () => {
    for (const e of RAW_FETCH_EVIDENCE) {
      expect(e.reason.length, `${e.where} 的依据太短`).toBeGreaterThan(20)
    }
  })

  it('PW-N2 撤销的依据：server-form 确实在用到响应体前检查了 res.ok', () => {
    const text = readFileSync(
      path.join(CLIENT_WEB, 'src/features/server/server-form.tsx'),
      'utf8',
    )
    const callIdx = text.indexOf("fetch(candidateUrl(value, '/api/version')")
    expect(callIdx, 'server-form 的连通性探测位置变了，请重新核对').toBeGreaterThan(-1)
    const body = text.slice(callIdx, callIdx + 1200)
    expect(
      /if\s*\(\s*!\s*res\.ok\s*\)/.test(body),
      'server-form 的连通性探测没有在读取响应体前检查 res.ok',
    ).toBe(true)
  })

  it('第三方例外必须是服务端返回的地址（不是客户端拼的 PIM 路径）', () => {
    const text = readFileSync(
      path.join(CLIENT_WEB, 'src/features/files/upload-engine.ts'),
      'utf8',
    )
    expect(text).toMatch(/fetch\(\s*session\.uploadUrl/)
  })
})

/* ── PW-18 ───────────────────────────────────────────────────── */

describe('PW-18：429 必须尊重 Retry-After 语义', () => {
  /**
   * 服务端登录锁定的真实行为（pim-api AuthEndpoints.cs:118-125）是
   * 「同一 IP 15 分钟内失败 >=5 次 → 429 + Retry-After: 900」。
   */
  function stub429(retryAfter: string) {
    const sleeps: number[] = []
    let requests = 0
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        requests += 1
        return new Response(JSON.stringify({ code: 42901, message: 'too many attempts', data: null }), {
          status: 429,
          headers: { 'content-type': 'application/json', 'retry-after': retryAfter },
        })
      }),
    )
    vi.stubGlobal(
      'setTimeout',
      vi.fn((fn: () => void, ms: number) => {
        sleeps.push(ms)
        fn()
        return 0 as unknown as ReturnType<typeof setTimeout>
      }),
    )
    return { sleeps, requests: () => requests }
  }

  it('Retry-After: 900 时不得把等待截断成 5 秒后盲目重试，也不得发起第二次请求', async () => {
    const env = stub429('900')
    const err = await apiFetch('/api/v1/auth/login').catch((e) => e)
    expect(err, '429 必须抛错而不是当成成功').toBeInstanceOf(ApiError)
    expect(
      env.sleeps.some((ms) => ms > 0 && ms < 900_000),
      `等待被截断成 ${env.sleeps.join(',')} 毫秒；服务端要求 900 秒，缩短后必然再次 429`,
    ).toBe(false)
    expect(
      env.requests(),
      '被强制锁定 15 分钟时又打了一次请求，会再消耗一次失败计数',
    ).toBe(1)
    expect((err as ApiError).retryAfterMs).toBe(900_000)
  })

  it('429 的错误信息必须包含可读的等待时长，而不是通用 HTTP 429', async () => {
    stub429('900')
    const err = (await apiFetch('/api/v1/auth/login').catch((e) => e)) as ApiError
    expect(err).toBeInstanceOf(ApiError)
    expect(
      /900|900\s*秒|15\s*分钟|稍后|等待/.test(err.message),
      `错误信息 "${err.message}" 没有告诉用户要等多久`,
    ).toBe(true)
  })

  it('HTTP-date 形式的 Retry-After 也要被换算成真实等待时长', async () => {
    const when = new Date(Date.now() + 300_000).toUTCString()
    stub429(when)
    const err = (await apiFetch('/api/v1/auth/login').catch((e) => e)) as ApiError
    expect(err.retryAfterMs).toBeGreaterThan(290_000)
    expect(err.retryAfterMs).toBeLessThanOrEqual(300_000)
    expect(err.message).toMatch(/分钟/)
  })
})

/* ── PW-07 / F-11：BLOCKED 期间的护栏 ────────────────────────── */

describe('PW-07 / F-11：宿主会话协议未定，本轮 BLOCKED', () => {
  /**
   * 为什么这里没有断言：
   * review（C-4）指出旧断言「client.ts 里出现 tokenProvider 字样」会被
   * `setTokens` / localStorage 写入同样满足——它会把「把真令牌放进页面存储」
   * 判成通过，和 review-policy 第 2 条相反。
   * 宿主握手的协议、消息字段、401/超时/退出语义必须与 Windows 侧共同批准后
   * 再写行为 RED（协议草案见 remediation/host-session/design.md）。
   */
  it('护栏：修复 F-11 不得以删掉现有登录存储为代价', () => {
    const text = readFileSync(path.join(CLIENT_WEB, 'src/api/client.ts'), 'utf8')
    expect(text).toMatch(/export function getAccessToken/)
    expect(text).toMatch(/export function setTokens/)
    expect(text).toMatch(/export function clearTokens/)
    const storage = readFileSync(path.join(CLIENT_WEB, 'src/lib/storage.ts'), 'utf8')
    expect(storage).toMatch(/pim\.accessToken/)
  })
})

/* ── 统一传输本身的行为（证明缺的是 ICS 没用它） ─────────────── */

describe('统一传输行为对照', () => {
  it('（行为）apiBase 拼接与 401 刷新后重放', async () => {
    setTokens('old-access', 'refresh-1')
    const calls: string[] = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        calls.push(String(url))
        const auth = new Headers(init?.headers).get('authorization')
        if (String(url).includes('/api/v1/auth/refresh')) {
          return new Response(
            JSON.stringify({ code: 0, message: 'ok', data: { accessToken: 'new-access', refreshToken: 'refresh-2' } }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        if (auth === 'Bearer old-access') {
          return new Response(JSON.stringify({ code: 40101, message: '过期', data: null }), {
            status: 401,
            headers: { 'content-type': 'application/json' },
          })
        }
        return new Response(JSON.stringify({ code: 0, message: 'ok', data: { ok: true } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        })
      }),
    )
    const { setApiBase } = await import('@/lib/apiBase')
    setApiBase('http://192.0.2.10:5858')
    try {
      await expect(apiFetch<{ ok: boolean }>('/api/v1/calendar/export-ics')).resolves.toEqual({ ok: true })
      expect(calls[0]).toBe('http://192.0.2.10:5858/api/v1/calendar/export-ics')
      expect(calls.filter((c) => c.includes('/auth/refresh')).length).toBe(1)
    } finally {
      setApiBase('')
      resetRefreshState()
      clearTokens()
      vi.unstubAllGlobals()
    }
  })

  it('（行为）非 2xx 一定抛错，不会静默成功', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ code: 50001, message: '服务器错误', data: null }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        }),
      ),
    )
    await expect(apiFetch('/api/v1/calendar/export-ics')).rejects.toBeInstanceOf(ApiError)
    vi.unstubAllGlobals()
  })
})
