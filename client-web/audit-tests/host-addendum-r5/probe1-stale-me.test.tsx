// @vitest-environment jsdom
/*
 * Web R5 addendum · 疑点 1（独立 reviewer 探针，只读源树上的隔离副本）
 *
 * 问题：AuthProvider 的 host effect 里 `meRun` 只在 `runMe()` 里递增。
 * `host.session.ended`（匹配当前 handshakeId）与「新代次 authenticated:false」都属于
 * 「本代次的会话已经结束/未认证」，但都不会作废正在等待的 `authApi.me()`。
 *
 * 唯一规格：`remediation/host-session/reviewed-spec.md`
 * （sha256 8964935021f69ff2e44c6d8932fa7a5f00645ddc5f249661b88f93694312ccf8）
 *   §2「会话结束只由 host.session.ended 表示」
 *   §6.1「authenticated === false：不调用 /auth/me，用户保持 null」
 *   §6.2 expired/invalid：「用户清到 null 后留在宿主未登录说明」
 *
 * 本文件是**手写 wire** + 真实 `AuthProvider` / `RequireAuth` + 延迟 `/auth/me`。
 * 每条「目标断言」都用 `await` 等真实 React 落地，另配正控制证明设施与延迟响应本身有效。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RequireAuth } from '@/app/guards'
import { AuthProvider, useAuth } from '@/features/auth/auth-context'

const HANDSHAKE_ID = '6f1e8c0a-1b2c-4d3e-8f90-123456789abc'
const NEW_HANDSHAKE_ID = '11111111-2222-4333-8444-555555555555'

interface Frame {
  v?: unknown
  type?: string
  requestId?: string
  clientNonce?: string
  [key: string]: unknown
}

class Transport {
  posted: Frame[] = []
  private listeners = new Set<(ev: MessageEvent) => void>()

  install(marker = true): void {
    if (marker) {
      ;(window as unknown as { __PIM_HOST_CHANNEL__?: unknown }).__PIM_HOST_CHANNEL__ = {
        v: 1,
        product: 'pim-host-windows',
      }
    }
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: {
        webview: {
          postMessage: (msg: string) => {
            try {
              this.posted.push(JSON.parse(msg) as Frame)
            } catch {
              /* 页面发出的不是 JSON：忽略，探针只关心合法帧 */
            }
          },
          addEventListener: (t: string, h: (ev: MessageEvent) => void) => {
            if (t === 'message') this.listeners.add(h)
          },
          removeEventListener: (_t: string, h: (ev: MessageEvent) => void) => {
            this.listeners.delete(h)
          },
        },
      },
    })
  }

  uninstall(): void {
    delete (window as unknown as { chrome?: unknown }).chrome
    delete (window as unknown as { __PIM_HOST_CHANNEL__?: unknown }).__PIM_HOST_CHANNEL__
  }

  /** 宿主 → 页面：按规格手写的 JSON 文本（不经过被测序列化器） */
  send(frame: Frame): void {
    const data = JSON.stringify(frame)
    for (const l of [...this.listeners]) l(new MessageEvent('message', { data }))
  }

  of(type: string): Frame[] {
    return this.posted.filter((f) => f.type === type)
  }

  first(type: string): Frame {
    const f = this.of(type)[0]
    if (!f) throw new Error(`页面没有发出 ${type}`)
    return f
  }
}

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: status === 200 ? 0 : 50001, message: 'x', data }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

function Probe() {
  const a = useAuth()
  return (
    <div>
      <span data-testid="user">{a.user?.username ?? 'none'}</span>
      <span data-testid="booting">{String(a.booting)}</span>
      <span data-testid="boot-error">{String(a.bootError)}</span>
      <span data-testid="host-status">{a.hostStatus}</span>
      <span data-testid="host-authenticated">{String(a.hostAuthenticated)}</span>
      <button onClick={() => a.retryBoot()}>do-retry</button>
    </div>
  )
}

function renderHostRoute() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/today']}>
        <Probe />
        <Routes>
          <Route path="/login" element={<div data-testid="login-page">login</div>} />
          <Route element={<RequireAuth />}>
            <Route path="/today" element={<div data-testid="protected">protected</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  )
}

const flush = async (times = 8): Promise<void> => {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

const userText = (): string => screen.getByTestId('user').textContent ?? ''

let transport: Transport
let meResolvers: ((r: Response) => void)[]
let meRequests: number

async function mePending(): Promise<void> {
  await waitFor(() => expect(meRequests, '入口未到达：host.state 没有触发 /auth/me').toBe(1))
  expect(userText(), 'me 未回时用户必须还是 null').toBe('none')
}

async function readyHandshake(auth: boolean): Promise<Frame> {
  await waitFor(() => expect(transport.of('page.ready')).toHaveLength(1))
  const ready = transport.first('page.ready')
  transport.send({
    v: 1,
    type: 'host.state',
    requestId: ready.requestId,
    clientNonce: ready.clientNonce,
    handshakeId: HANDSHAKE_ID,
    product: 'pim-host-windows',
    apiOrigin: window.location.origin,
    authenticated: auth,
  })
  return ready
}

beforeEach(() => {
  meResolvers = []
  meRequests = 0
  transport = new Transport()
  transport.install()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      if (url.endsWith('/api/v1/auth/me')) {
        meRequests += 1
        return await new Promise<Response>((resolve) => meResolvers.push(resolve))
      }
      return envelope(null)
    }),
  )
})

afterEach(() => {
  cleanup()
  transport.uninstall()
  vi.unstubAllGlobals()
})

describe('疑点 1 正控制（必须绿：延迟 me 的设施与业务链路本身可用）', () => {
  it('C1：authenticated:true → 延迟 me 200 → 用户写入、守卫放行、锁定 me 只调用一次', async () => {
    renderHostRoute()
    await readyHandshake(true)
    await mePending()
    await act(async () => {
      meResolvers[0]!(envelope({ username: 'host-user' }))
    })
    await waitFor(() => expect(userText()).toBe('host-user'))
    expect(screen.getByTestId('protected')).toBeTruthy()
    expect(screen.getByTestId('booting').textContent).toBe('false')
    expect(meRequests).toBe(1)
  })

  it('C2：authenticated:true → 匹配的 host.session.ended(expired) 被真实处理（用户清 null、守卫不放行）', async () => {
    renderHostRoute()
    await readyHandshake(true)
    await mePending()
    transport.send({
      v: 1,
      type: 'host.session.ended',
      handshakeId: HANDSHAKE_ID,
      reason: 'expired',
    })
    await waitFor(() => expect(userText()).toBe('none'))
    expect(screen.getByTestId('booting').textContent).toBe('false')
    expect(screen.getByTestId('host-authenticated').textContent).toBe('false')
    expect(screen.queryByTestId('protected')).toBeNull()
    // me 仍未落地：这条 ended 帧确实被处理了，而不是帧被忽略
    expect(meRequests).toBe(1)
  })
})

describe('疑点 1 目标断言（SPEC 期望；失败 = 源码疑点被证实）', () => {
  it('T1：host.session.ended 之后到达的旧 me 200 不得把用户写回、不得让守卫放行', async () => {
    renderHostRoute()
    await readyHandshake(true)
    await mePending()
    transport.send({
      v: 1,
      type: 'host.session.ended',
      handshakeId: HANDSHAKE_ID,
      reason: 'expired',
    })
    await waitFor(() => expect(userText()).toBe('none'))
    expect(screen.getByTestId('host-authenticated').textContent).toBe('false')

    // 旧 me 现在才 200（同一 effect、同一 meRun）
    await act(async () => {
      meResolvers[0]!(envelope({ username: 'host-user' }))
    })
    await flush(10)
    expect(
      userText(),
      'SPEC §2/§6.2：会话已由 host.session.ended 结束，旧 me 的 200 不得重新写回用户',
    ).toBe('none')
    expect(screen.queryByTestId('protected'), '守卫在会话结束后被旧 me 放行了').toBeNull()
  })

  it('T1b：同一时序下守卫是否放行（拆开断言，便于分别取证）——会话结束后旧 me 让 RequireAuth 渲染受保护路由', async () => {
    renderHostRoute()
    await readyHandshake(true)
    await mePending()
    transport.send({
      v: 1,
      type: 'host.session.ended',
      handshakeId: HANDSHAKE_ID,
      reason: 'logout',
    })
    await waitFor(() => expect(userText()).toBe('none'))
    await act(async () => {
      meResolvers[0]!(envelope({ username: 'host-user' }))
    })
    await flush(10)
    // 观测：会话已结束（hostAuthenticated=false）但 user 被旧 me 写回 → 守卫放行
    const observed = {
      user: userText(),
      hostAuthenticated: screen.getByTestId('host-authenticated').textContent,
      protectedRendered: screen.queryByTestId('protected') !== null,
    }
    console.log('[probe1 T1b 观测]', JSON.stringify(observed))
    expect(
      observed,
      'SPEC §2/§6.2：host.session.ended 之后不得由旧 me 放行受保护路由',
    ).toEqual({ user: 'none', hostAuthenticated: 'false', protectedRendered: false })
  })

  it('T2：新代次 authenticated:false 之后的旧代次延迟 me 不得改写新代次状态', async () => {
    renderHostRoute()
    await readyHandshake(true)
    await mePending()

    // 重试 = 新代次（新 page.ready / 新 requestId+nonce / 新 handshakeId）
    await act(async () => {
      screen.getByRole('button', { name: 'do-retry' }).click()
    })
    await waitFor(() => expect(transport.of('page.ready')).toHaveLength(2))
    const ready2 = transport.of('page.ready')[1]!
    transport.send({
      v: 1,
      type: 'host.state',
      requestId: ready2.requestId,
      clientNonce: ready2.clientNonce,
      handshakeId: NEW_HANDSHAKE_ID,
      product: 'pim-host-windows',
      apiOrigin: window.location.origin,
      authenticated: false,
    })
    await waitFor(() => expect(screen.getByTestId('host-authenticated').textContent).toBe('false'))
    expect(userText(), '§6.1：authenticated:false 用户保持 null').toBe('none')

    await act(async () => {
      meResolvers[0]!(envelope({ username: 'host-user' }))
    })
    await flush(10)
    expect(
      userText(),
      'SPEC §6.1：新代次 authenticated:false，旧代次的 me 结果不得写回用户',
    ).toBe('none')
    expect(screen.queryByTestId('protected')).toBeNull()
  })

  it('T3：新代次 authenticated:true 的 me 尚未回来时，旧代次 me 不得抢先写入', async () => {
    renderHostRoute()
    await readyHandshake(true)
    await mePending()

    await act(async () => {
      screen.getByRole('button', { name: 'do-retry' }).click()
    })
    await waitFor(() => expect(transport.of('page.ready')).toHaveLength(2))
    const ready2 = transport.of('page.ready')[1]!
    transport.send({
      v: 1,
      type: 'host.state',
      requestId: ready2.requestId,
      clientNonce: ready2.clientNonce,
      handshakeId: NEW_HANDSHAKE_ID,
      product: 'pim-host-windows',
      apiOrigin: window.location.origin,
      authenticated: true,
    })
    await waitFor(() => expect(meRequests).toBe(2))

    // 旧代次的 me 先回，且返回的是**另一个**用户
    await act(async () => {
      meResolvers[0]!(envelope({ username: 'stale-user' }))
    })
    await flush(10)
    expect(
      userText(),
      'SPEC §2：旧代次的 me 结果不得作用于新代次（应为 none，等新代次自己的 me）',
    ).not.toBe('stale-user')
  })
})
