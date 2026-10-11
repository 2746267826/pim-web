// @vitest-environment jsdom
/*
 * Web R5 addendum · 疑点 3（独立 reviewer 探针）
 *
 * 问题：规格 §2 的 wire 表里 `host.refresh.result` 的 `reason` 是**可选**字段
 * （必填只有 v/type/requestId/ok），且「可选字段可以不出现」；`reason` 出现时
 * 只允许 invalid/transient/unauthenticated。当前 `parseHostFrame` 对 ok:false
 * 强制要求 `reason` 是 string——比 freeze 更严：合法的省略帧被整帧丢弃。
 *
 * 页面期望行为（freeze §6.2）：本请求按 transient 失败，不结束会话、不清令牌。
 * 处置方向**不是**扩 wire reason（不得新增枚举值），只是让合法省略帧被接受。
 */
import { act, cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiFetch, resetRefreshState } from '@/api/client'
import { AuthProvider, useAuth } from '@/features/auth/auth-context'
import { parseHostFrame } from '@/lib/host-wire'

const HANDSHAKE_ID = '6f1e8c0a-1b2c-4d3e-8f90-123456789abc'
const API_PATH = '/api/v1/today/sections'
const DOC = window.location.origin

function refreshJson(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    v: 1,
    type: 'host.refresh.result',
    requestId: 'req-ref-1',
    ok: false,
    ...over,
  })
}

/* ── 传输 ─────────────────────────────────────────────────── */

let listeners: Set<(ev: MessageEvent) => void>
let posted: Record<string, unknown>[]
let refreshReply: string | null

function installTransport(): void {
  ;(window as unknown as { __PIM_HOST_CHANNEL__?: unknown }).__PIM_HOST_CHANNEL__ = {
    v: 1,
    product: 'pim-host-windows',
  }
  posted = []
  listeners = new Set()
  Object.defineProperty(window, 'chrome', {
    configurable: true,
    value: {
      webview: {
        postMessage: (msg: string) => {
          const frame = JSON.parse(msg) as Record<string, unknown>
          posted.push(frame)
          if (frame['type'] === 'page.ready') {
            sendRaw(
              JSON.stringify({
                v: 1,
                type: 'host.state',
                requestId: frame['requestId'],
                clientNonce: frame['clientNonce'],
                handshakeId: HANDSHAKE_ID,
                product: 'pim-host-windows',
                apiOrigin: DOC,
                authenticated: true,
              }),
            )
          } else if (frame['type'] === 'page.refresh' && refreshReply !== null) {
            sendRaw(refreshReply.replace('req-ref-1', String(frame['requestId'])))
          }
        },
        addEventListener: (t: string, h: (ev: MessageEvent) => void) => {
          if (t === 'message') listeners.add(h)
        },
        removeEventListener: (_t: string, h: (ev: MessageEvent) => void) => {
          listeners.delete(h)
        },
      },
    },
  })
}

function sendRaw(raw: string): void {
  for (const l of [...listeners]) l(new MessageEvent('message', { data: raw }))
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: 'x', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function Probe() {
  const a = useAuth()
  return <span data-testid="user">{a.user?.username ?? 'none'}</span>
}

const flush = async (n = 6): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0)
    })
  }
}

let fetchCalls: { url: string; status: number }[]
let unauthorized = 0
const onUnauthorized = (): void => {
  unauthorized += 1
}

beforeEach(() => {
  vi.useFakeTimers()
  installTransport()
  refreshReply = null
  fetchCalls = []
  unauthorized = 0
  resetRefreshState()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/me')) {
        fetchCalls.push({ url, status: 200 })
        return envelope({ username: 'host-user' })
      }
      fetchCalls.push({ url, status: 401 })
      return new Response('', { status: 401 })
    }),
  )
  window.addEventListener('pim:unauthorized', onUnauthorized)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  window.removeEventListener('pim:unauthorized', onUnauthorized)
  delete (window as unknown as { chrome?: unknown }).chrome
  delete (window as unknown as { __PIM_HOST_CHANNEL__?: unknown }).__PIM_HOST_CHANNEL__
  vi.unstubAllGlobals()
  resetRefreshState()
})

/** 真实 AuthProvider 建好 host 会话（authenticated:true + me 成功） */
async function establishedSession(): Promise<void> {
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  )
  await flush(8)
  expect(screen.getByTestId('user').textContent, '前置：宿主会话没有建立').toBe('host-user')
}

function tokenWrites(): string[] {
  const out: string[] = []
  for (let i = 0; i < localStorage.length; i++) {
    const k = localStorage.key(i)
    if (k && /^pim\.(accessToken|refreshToken)$/.test(k)) out.push(k)
  }
  return out
}

/* ── 1. parse 级 ──────────────────────────────────────────── */

describe('疑点 3 · parse 级（SPEC §2：reason 是可选项）', () => {
  it('C0 正控制：ok:true（无 reason）与 ok:false+reason:"transient" 都被接受', () => {
    const okTrue = parseHostFrame(
      JSON.stringify({ v: 1, type: 'host.refresh.result', requestId: 'req-ref-1', ok: true }),
    )
    expect(okTrue).not.toBeNull()
    expect(parseHostFrame(refreshJson({ reason: 'transient' }))).not.toBeNull()
  })

  it('C1 反控制：未知 reason、ok:true 带 reason、ended 缺 reason 仍必须拒绝（不得扩协议）', () => {
    expect(parseHostFrame(refreshJson({ reason: 'bogus' }))).toBeNull()
    expect(parseHostFrame(refreshJson({ ok: true, reason: 'transient' }))).toBeNull()
    expect(
      parseHostFrame(
        JSON.stringify({
          v: 1,
          type: 'host.session.ended',
          handshakeId: HANDSHAKE_ID,
          reason: undefined,
        }),
      ),
    ).toBeNull()
  })

  it('T1：ok:false 省略 reason（规格可选字段不出现）应被 parse 接受', () => {
    const frame = parseHostFrame(refreshJson())
    console.log('[probe3 T1 观测] parseHostFrame(ok:false, reason 省略) =', frame)
    expect(frame, 'SPEC §2：reason 是可选项，「可选字段可以不出现」——不该整帧丢弃').not.toBeNull()
    expect(frame && frame.type === 'host.refresh.result' ? frame.ok : null).toBe(false)
  })
})

/* ── 2. 业务级：401 → page.refresh → 宿主回 ok:false 无 reason ── */

describe('疑点 3 · 业务级（合法省略帧应按 transient 失败本请求，不结束会话）', () => {
  it('T2：省略 reason 的 ok:false 应立即失败本请求（不等 8 秒超时）', async () => {
    refreshReply = refreshJson()
    await establishedSession()
    let settled = 'pending'
    const p = apiFetch(API_PATH).then(
      () => {
        settled = 'resolved'
      },
      () => {
        settled = 'rejected'
      },
    )
    await flush(8)
    const observed = {
      pageRefreshCount: posted.filter((f) => f['type'] === 'page.refresh').length,
      settled,
      user: screen.getByTestId('user').textContent,
      unauthorized,
      tokenKeys: tokenWrites(),
    }
    console.log('[probe3 T2 观测]', JSON.stringify(observed))
    expect(observed.pageRefreshCount, '前置：页面确实发了 page.refresh').toBe(1)
    expect(
      observed.settled,
      'SPEC §6.2：宿主回了合法 ok:false（reason 省略）→ 本请求按 transient 失败，不该停在 8 秒超时上',
    ).toBe('rejected')
    /*
     * R6 独立 review §4 · M2：这条原来只钉了「立即 rejected」，把同一观测里的
     * 安全属性丢掉了——「按 transient 失败」和「当成清会话」都会 rejected，
     * 少了这几条断言就分不出两者。这里按 T3 超时路径的同一组安全属性钉住。
     */
    expect(observed.user, '省略 reason 的合法失败帧把用户清了（必须是安全 transient）').toBe('host-user')
    expect(observed.unauthorized, 'host 通道不得广播浏览器登出').toBe(0)
    expect(observed.tokenKeys, 'host 通道不得写/清令牌').toEqual([])
    expect(
      posted.filter((f) => f['type'] === 'host.session.ended'),
      '合法的 ok:false 失败帧不得结束宿主会话',
    ).toHaveLength(0)
    await p
  })

  it('T3：宿主完全不回复 → 8 秒超时也必须是「安全 transient」：不结束会话、不清令牌、不广播、用户保持', async () => {
    refreshReply = null // 宿主一个字都不回：这条只看 8 秒超时兜底
    await establishedSession()
    let settled = 'pending'
    const p = apiFetch(API_PATH).then(
      () => {
        settled = 'resolved'
      },
      () => {
        settled = 'rejected'
      },
    )
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7999)
    })
    await flush(4)
    expect(settled, '7999ms 就提前失败了（超时常量不是 8s）').toBe('pending')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    await flush(4)
    expect(settled).toBe('rejected')
    expect(screen.getByTestId('user').textContent, '超时后用户被改动了').toBe('host-user')
    expect(unauthorized, 'host 通道不得广播浏览器登出').toBe(0)
    expect(tokenWrites(), 'host 通道不得写/清令牌').toEqual([])
    expect(posted.filter((f) => f['type'] === 'host.session.ended')).toHaveLength(0)
    await p.catch(() => undefined)
  })

  it('C2 正控制：带 reason:"transient" 时立即失败（同一分支被真实走到）', async () => {
    refreshReply = refreshJson({ reason: 'transient' })
    await establishedSession()
    let settled = 'pending'
    const p = apiFetch(API_PATH).then(
      () => {
        settled = 'resolved'
      },
      () => {
        settled = 'rejected'
      },
    )
    await flush(8)
    expect(settled, 'reason:"transient" 的合法帧没有立即失败').toBe('rejected')
    expect(screen.getByTestId('user').textContent).toBe('host-user')
    await p.catch(() => undefined)
  })
})
