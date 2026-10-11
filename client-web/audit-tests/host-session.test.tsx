// @vitest-environment jsdom
/*
 * desktopHost：Web 侧宿主会话**行为 RED**（Round 4：按 Grok R3 review 的十组具体补测返工）。
 *
 * 唯一规格：`remediation/host-session/reviewed-spec.md`
 * （sha256 8964935021f69ff2e44c6d8932fa7a5f00645ddc5f249661b88f93694312ccf8，本轮不重新设计六条消息）。
 *
 * 证据等级：真实 `AuthProvider` / `login` / `register` / `apiFetch` / `fetchBlob`
 * + 真实 `RequireAuth` 守卫与真实 `LoginPage` + jsdom + **faithful fake host transport**
 * （只实现规格 §2 的书面 wire 与页面可见的 `chrome.webview` 桥面；不伪造 WebView2 的
 * `WebMessageReceived` / `e.Source` 平台事件，那是 Windows runner 的义务，保持 NOT-VERIFIED）。
 * 期望帧在测试里手写（不导入被测序列化器生成期望值）。
 *
 * 本轮**不实现** host 登录、不删 storage、不启用 host mode、不接 bridge——这些是下一步。
 * 因此 host 用例是**断言失败**（RED），browser 无标记回归必须继续绿。
 *
 * 每条用例都先断言「目标逻辑在真实入口上必须先发生」（发 page.ready / 调 /auth/me），
 * 再断言细分场景。这样将来的错误实现会在**细分断言**上失败，而不是「因为还没实现所以
 * 什么都没发生」。无法在旧产品上跑到的细分场景（错误 UI 等）在 round4/report.md 里
 * 明确标成「coverage 尚待 GREEN」，不冒充独立 RED。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { RequireAuth } from '@/app/guards'
import { apiFetch, clearTokens, fetchBlob, resetRefreshState, setTokens } from '@/api/client'
import { AuthProvider, useAuth } from '@/features/auth/auth-context'
import { LoginPage } from '@/features/auth/pages/login-page'
import { ServerForm } from '@/features/server/server-form'
import { getApiBase, setApiBase } from '@/lib/apiBase'
import {
  HOST_CHANNEL_MARKER_SCRIPT,
  detectHostChannel,
  parseHostMarker,
} from '@/lib/host-channel'
import { MAX_FRAME_BYTES, parseHostFrame, utf8ByteLength } from '@/lib/host-wire'

/** browser 通道的基址（localStorage `pim.apiBase`）；host 通道必须改用文档 origin */
const API_BASE = 'http://192.0.2.10:5858'
const HANDSHAKE_ID = '6f1e8c0a-1b2c-4d3e-8f90-123456789abc'
/** 上一次导航代次的 handshakeId（规格 §2「导航代次」） */
const OLD_HANDSHAKE_ID = '00000000-1111-4222-8333-444444444444'
/** host 通道的 API 基址 = 文档 origin（规格 §2/§6.1），不用 pim.apiBase */
const DOC_ORIGIN = window.location.origin
const API_PATH = '/api/v1/today/sections'

interface Frame {
  v?: unknown
  type?: string
  requestId?: string
  clientNonce?: string
  [key: string]: unknown
}

/* ── faithful fake host transport（按规格 §2 手写 wire） ──────── */

class FakeHostTransport {
  /** 页面 → 宿主 */
  posted: Frame[] = []
  /** 宿主是否自动回复 page.ready（false = 由用例逐帧控制） */
  autoHandshake = true
  authenticated = true
  apiOrigin = DOC_ORIGIN
  /** page.refresh 的回复；null = 不回（模拟 8 秒超时） */
  refreshResult: Frame | null = { v: 1, type: 'host.refresh.result', ok: true }
  private listeners = new Set<(ev: MessageEvent) => void>()

  install(): void {
    Object.defineProperty(window, 'chrome', {
      configurable: true,
      value: {
        webview: {
          postMessage: (msg: string) => this.onPageMessage(msg),
          addEventListener: (eventType: string, h: (ev: MessageEvent) => void) => {
            if (eventType === 'message') this.listeners.add(h)
          },
          removeEventListener: (_eventType: string, h: (ev: MessageEvent) => void) => {
            this.listeners.delete(h)
          },
        },
      },
    })
  }

  uninstall(): void {
    delete (window as unknown as { chrome?: unknown }).chrome
  }

  /** 宿主 → 页面（`message` 事件）；字符串按原样发送，用来构造超长帧 */
  send(frame: Frame | string): void {
    const data = typeof frame === 'string' ? frame : JSON.stringify(frame)
    for (const l of [...this.listeners]) l(new MessageEvent('message', { data }))
  }

  /**
   * 宿主 → 页面，**对象形态**：真实 WebView2 的 `PostWebMessageAsJson(json)` 到页面
   * 之后，`MessageEvent.data` 就是解析好的**对象**（不是字符串）。上面那个 `send()`
   * 发的是字符串，只能证明「字符串形态」这一半。
   */
  sendObject(frame: Frame): void {
    for (const l of [...this.listeners]) l(new MessageEvent('message', { data: frame }))
  }

  private onPageMessage(raw: string): void {
    let frame: Frame
    try {
      frame = JSON.parse(raw) as Frame
    } catch {
      return
    }
    this.posted.push(frame)
    if (!this.autoHandshake) return
    if (frame.type === 'page.ready') {
      this.send(this.hostState(frame))
    } else if (frame.type === 'page.refresh' && this.refreshResult) {
      this.send({ ...this.refreshResult, requestId: frame.requestId })
    }
  }

  /** 合法 host.state（hand-written wire，值来自用例的显式输入） */
  hostState(ready: Frame, overrides: Partial<Frame> = {}): Frame {
    return {
      v: 1,
      type: 'host.state',
      requestId: ready.requestId,
      clientNonce: ready.clientNonce,
      handshakeId: HANDSHAKE_ID,
      product: 'pim-host-windows',
      apiOrigin: this.apiOrigin,
      authenticated: this.authenticated,
      ...overrides,
    }
  }

  typeCount(type: string): number {
    return this.posted.filter((f) => f.type === type).length
  }

  first(type: string): Frame {
    const f = this.posted.find((x) => x.type === type)
    if (!f) throw new Error(`页面没有发出 ${type}（形态尚未实现）`)
    return f
  }
}

/* ── 环境 ─────────────────────────────────────────────────── */

let transport: FakeHostTransport
let fetchCalls: { url: string; method: string; auth: string | null }[] = []
let fetchImpl: (url: string, init?: RequestInit) => Response
let unauthorizedEvents = 0

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: status === 200 ? 0 : 50001, message: 'x', data }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

/** 立刻返回指定 HTTP 状态的响应（无 JSON 体，模拟 401/500 等） */
function statusOnly(status: number): Response {
  return new Response('', { status })
}

let setItemSpy: ReturnType<typeof vi.spyOn>
let removeItemSpy: ReturnType<typeof vi.spyOn>
let getItemSpy: ReturnType<typeof vi.spyOn>

const TOKEN_KEY_RE = /^pim\.(accessToken|refreshToken)$/

function tokenKeyCalls(spy: ReturnType<typeof vi.spyOn>): unknown[][] {
  return (spy.mock.calls as unknown[][]).filter((c) => TOKEN_KEY_RE.test(String(c[0])))
}

/** 令牌 storage 的读写次数（access + refresh 两个键） */
function tokenIO(): { reads: number; writes: number } {
  return {
    reads: tokenKeyCalls(getItemSpy).length,
    writes: tokenKeyCalls(setItemSpy).length + tokenKeyCalls(removeItemSpy).length,
  }
}

function tokenStorageTouched(): boolean {
  const io = tokenIO()
  return io.reads > 0 || io.writes > 0
}

function meCalls(): { url: string; method: string; auth: string | null }[] {
  return fetchCalls.filter((c) => c.url.endsWith('/api/v1/auth/me'))
}

function dataCalls(): { url: string; method: string; auth: string | null }[] {
  return fetchCalls.filter((c) => c.url.includes(API_PATH))
}

beforeEach(() => {
  clearTokens()
  resetRefreshState()
  setApiBase(API_BASE)
  fetchCalls = []
  unauthorizedEvents = 0
  transport = new FakeHostTransport()
  fetchImpl = () => envelope(null)
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      fetchCalls.push({
        url,
        method: init?.method ?? 'GET',
        auth: new Headers(init?.headers).get('authorization'),
      })
      return fetchImpl(url, init)
    }),
  )
  getItemSpy = vi.spyOn(Storage.prototype, 'getItem')
  setItemSpy = vi.spyOn(Storage.prototype, 'setItem')
  removeItemSpy = vi.spyOn(Storage.prototype, 'removeItem')
  window.addEventListener('pim:unauthorized', onUnauthorized)
})

const onUnauthorized = (): void => {
  unauthorizedEvents += 1
}

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  window.removeEventListener('pim:unauthorized', onUnauthorized)
  transport.uninstall()
  delete (window as unknown as { __PIM_HOST_CHANNEL__?: unknown }).__PIM_HOST_CHANNEL__
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  setApiBase('')
  resetRefreshState()
  clearTokens()
})

/* ── 安装接缝 ─────────────────────────────────────────────── */

/** 生产标记常量脚本里的对象（唯一来源，避免两边各写一套协议） */
function productionMarker(): unknown {
  const v = /v:(\d+)/.exec(HOST_CHANNEL_MARKER_SCRIPT)
  const product = /product:"([^"]+)"/.exec(HOST_CHANNEL_MARKER_SCRIPT)
  if (!v || !product) throw new Error('生产标记脚本里没有 v / product，协议已变')
  return { v: Number(v[1]), product: product[1] }
}

function installMarker(value: unknown = productionMarker()): void {
  ;(window as unknown as { __PIM_HOST_CHANNEL__?: unknown }).__PIM_HOST_CHANNEL__ = value
}

function installHost(opts: { authenticated?: boolean; silent?: boolean; marker?: unknown } = {}): FakeHostTransport {
  installMarker(opts.marker ?? productionMarker())
  transport = new FakeHostTransport()
  transport.authenticated = opts.authenticated ?? true
  transport.autoHandshake = !opts.silent
  transport.install()
  return transport
}

/** 只装页面可见的桥面，不装标记（用于「有 webview 但没标记」的回归） */
function installBridgeOnly(): FakeHostTransport {
  transport = new FakeHostTransport()
  transport.install()
  return transport
}

/* ── React 探针 ───────────────────────────────────────────── */

function Probe() {
  const auth = useAuth()
  return (
    <div>
      <span data-testid="channel">{auth.hostChannel}</span>
      <span data-testid="user">{auth.user?.username ?? 'none'}</span>
      <span data-testid="booting">{String(auth.booting)}</span>
      <span data-testid="boot-error">{String(auth.bootError)}</span>
      {/* 退出超时（2s 内没有匹配的 session.ended）必须变成可见的可重试错误 */}
      <span data-testid="logout-error">{String(auth.hostLogoutError)}</span>
      <button onClick={() => void auth.login('audit', 'pw').catch(() => {})}>do-login</button>
      <button
        onClick={() =>
          void auth
            .register({ username: 'audit', email: 'a@pim.local', password: 'password1' })
            .catch(() => {})
        }
      >
        do-register
      </button>
      <button onClick={() => auth.logout()}>do-logout</button>
      <button onClick={() => auth.retryBoot()}>do-retry</button>
    </div>
  )
}

function renderAuth() {
  return render(
    <AuthProvider>
      <Probe />
    </AuthProvider>,
  )
}

/**
 * 真实路由入口：未登录时 `RequireAuth` 会跳到 `/login` 并渲染真实 `LoginPage`。
 * 「账密表单出现/不出现」是「有没有退回浏览器登录」的可观察判据。
 */
function renderHostRoute() {
  return render(
    <AuthProvider>
      <MemoryRouter initialEntries={['/today']}>
        <Probe />
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<RequireAuth />}>
            <Route path="/today" element={<div data-testid="protected">protected</div>} />
          </Route>
        </Routes>
      </MemoryRouter>
    </AuthProvider>,
  )
}

/** 账密表单（真实 LoginPage 的密码输入）是否可见 */
function credentialFormVisible(): boolean {
  return document.querySelector('#login-password') !== null
}

function retryButton(): HTMLElement | null {
  return screen.queryByRole('button', { name: /重试/ })
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** 推微任务 / React 工作（假定时器下只推进 0ms，不发生超时） */
async function flush(times = 8): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
      else await new Promise((r) => setTimeout(r, 0))
    })
  }
}

async function flushUntil(cond: () => boolean, tries = 60): Promise<void> {
  for (let i = 0; i < tries && !cond(); i++) await flush(1)
}

const userText = (): string => screen.getByTestId('user').textContent ?? ''
const isHostUser = (): boolean => userText() === 'host-user'

/** 让 /auth/me 成功返回 host 用户 */
function meSucceeds(): void {
  fetchImpl = (url) =>
    url.endsWith('/api/v1/auth/me') ? envelope({ username: 'host-user' }) : envelope(null)
}

/* ══ 1. 标记接缝（生产函数，必须绿） ═══════════════════════ */

describe('宿主标记接缝（规格 §1）', () => {
  it('只认 v===1 且 product==="pim-host-windows"；v 是字符串或别的版本都按 browser', () => {
    expect(parseHostMarker({ v: 1, product: 'pim-host-windows' })).not.toBeNull()
    expect(parseHostMarker({ v: '1', product: 'pim-host-windows' })).toBeNull()
    expect(parseHostMarker({ v: 2, product: 'pim-host-windows' })).toBeNull()
    expect(parseHostMarker({ v: 1, product: 'other-host' })).toBeNull()
    expect(parseHostMarker(undefined)).toBeNull()
  })

  it('生产标记常量脚本本身能被生产解析器接受，且没有令牌/URL/用户信息', () => {
    // Windows 侧安装的就是这段常量脚本（不允许插值）：逐字节锁住它
    expect(HOST_CHANNEL_MARKER_SCRIPT).toBe(
      'window.__PIM_HOST_CHANNEL__={v:1,product:"pim-host-windows"};',
    )
    expect(HOST_CHANNEL_MARKER_SCRIPT).not.toMatch(/token|authorization|https?:|refresh/i)
    // 用例安装的标记来自这个常量本身，不是另抄一份协议
    expect(parseHostMarker(productionMarker())).not.toBeNull()
    expect(detectHostChannel({ __PIM_HOST_CHANNEL__: productionMarker() })).toBe('host')
  })

  it('没有标记时（即使存在 chrome.webview）通道仍是 browser', () => {
    installBridgeOnly()
    expect(detectHostChannel()).toBe('browser')
  })
})

/* ══ 2. 浏览器回归：必须保持绿 ══════════════════════════════ */

describe('浏览器回归（没有标记 = 今天的行为，必须绿）', () => {
  it('AuthProvider 报告 browser，且 login() 仍走浏览器路径写令牌', async () => {
    fetchImpl = (url) =>
      url.includes('/api/v1/auth/login')
        ? envelope({ accessToken: 'a1', refreshToken: 'r1', user: { username: 'web-user' } })
        : envelope(null)
    const user = userEvent.setup()
    renderAuth()
    await waitFor(() => expect(screen.getByTestId('booting').textContent).toBe('false'))
    expect(screen.getByTestId('channel').textContent).toBe('browser')
    await user.click(screen.getByRole('button', { name: 'do-login' }))
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('web-user'))
    expect(tokenStorageTouched(), '浏览器通道必须继续写令牌').toBe(true)
  })

  it('apiFetch 的 401 仍走 /api/v1/auth/refresh 并重放一次', async () => {
    setTokens('old', 'refresh-1')
    let hit = 0
    fetchImpl = (url) => {
      if (url.includes('/api/v1/auth/refresh'))
        return envelope({ accessToken: 'new', refreshToken: 'refresh-2' })
      hit += 1
      return hit === 1 ? statusOnly(401) : envelope({ ok: true })
    }
    await apiFetch(API_PATH)
    expect(fetchCalls.some((c) => c.url.includes('/api/v1/auth/refresh'))).toBe(true)
    expect(hit).toBe(2)
  })

  it('browser 的 fetchBlob 默认仍不刷新：401 直接失败，不发 /auth/refresh', async () => {
    setTokens('old', 'refresh-1')
    fetchImpl = () => statusOnly(401)
    await expect(fetchBlob(API_PATH)).rejects.toThrow(/401/)
    expect(
      fetchCalls.some((c) => c.url.includes('/api/v1/auth/refresh')),
      'browser 默认 fetchBlob 不该刷新（今天的缩略图行为）',
    ).toBe(false)
    expect(fetchCalls.filter((c) => c.url.includes(API_PATH))).toHaveLength(1)
  })
})

/* ══ 3. host 通道：握手与守卫（RED，规格 §1） ═══════════════ */

describe('host 通道：握手与守卫（RED，规格 §1）', () => {
  it('启动必须发一条 page.ready（监听器装好之后），且只作为握手请求', async () => {
    installHost()
    renderAuth()
    await waitFor(() => expect(screen.getByTestId('channel').textContent).toBe('host'))
    await waitFor(() =>
      expect(
        transport.typeCount('page.ready'),
        'host 通道没有发 page.ready：页面拿不到 host.state，永远不会成为宿主会话',
      ).toBe(1),
    )
    const ready = transport.first('page.ready')
    expect(ready.v).toBe(1)
    expect(String(ready.requestId ?? '')).toMatch(/^[A-Za-z0-9_-]{1,64}$/)
    expect(String(ready.clientNonce ?? '')).toMatch(/^[A-Za-z0-9_-]{8,64}$/)
  })

  it('authenticated:true 时 storage 为空也必须调用 GET /api/v1/auth/me，用户只来自 me 的结果', async () => {
    installHost({ authenticated: true })
    meSucceeds()
    renderAuth()
    await waitFor(() =>
      expect(
        meCalls().some((c) => c.method === 'GET'),
        'host.state.authenticated=true 时没有调用 /auth/me：守卫拿不到用户对象',
      ).toBe(true),
    )
    await waitFor(() => expect(userText()).toBe('host-user'))
  })

  it('authenticated:false 时不得调用 /auth/me，用户保持未登录', async () => {
    installHost({ authenticated: false })
    renderAuth()
    await waitFor(() => expect(screen.getByTestId('channel').textContent).toBe('host'))
    await flush()
    expect(
      transport.typeCount('page.ready'),
      'host 通道没有发 page.ready（host 行为尚未实现）',
    ).toBeGreaterThan(0)
    expect(meCalls()).toHaveLength(0)
    expect(userText()).toBe('none')
  })

  /*
   * 2/3/4 的坏帧用例：**先**断言「坏帧单独不能建立会话」，**再**用一帧合法
   * host.state 证明传输与目标逻辑本身是成立的（否则「没有调用 me」只是
   * 「什么都没实现」，等于没测）。合法帧对同一 page.ready 回复，规格未禁止。
   */
  function readyFrame(): Frame {
    return transport.first('page.ready')
  }

  function validState(overrides: Partial<Frame> = {}): Frame {
    return {
      v: 1,
      type: 'host.state',
      requestId: readyFrame().requestId,
      clientNonce: readyFrame().clientNonce,
      handshakeId: HANDSHAKE_ID,
      product: 'pim-host-windows',
      apiOrigin: DOC_ORIGIN,
      authenticated: true,
      ...overrides,
    }
  }

  /**
   * 一帧**字段值全部合法**的 `host.state`，只用 ASCII 空白（合法 JSON 空白）
   * 把它填到指定总字节数：体积是这条帧唯一可能非法的维度。
   */
  function paddedState(totalBytes: number): string {
    const frame = JSON.stringify(validState())
    return ' '.repeat(totalBytes - utf8ByteLength(frame)) + frame
  }

  async function expectBadFramesRejected(buildFrames: () => (Frame | string)[]): Promise<void> {
    installHost({ silent: true, authenticated: true })
    meSucceeds()
    renderAuth()
    await waitFor(() =>
      expect(
        transport.typeCount('page.ready'),
        'host 通道没有发 page.ready：坏帧用例连入口都到不了',
      ).toBe(1),
    )
    for (const f of buildFrames()) transport.send(f)
    await flush(4)
    expect(meCalls(), '坏帧竟然建立了会话（调用了 /auth/me）').toHaveLength(0)
    expect(userText(), '坏帧竟然设置了用户').toBe('none')

    // 反向对照：同一 view 上合法的 host.state 必须建立会话
    transport.send(validState())
    await flushUntil(isHostUser)
    expect(
      userText(),
      '同一 page.ready 的合法 host.state 也没能建立会话：上面的「没有 me」证明不了坏帧被拒',
    ).toBe('host-user')
    expect(meCalls().length).toBeGreaterThan(0)
  }

  it('clientNonce 不匹配的单帧 host.state 不得建立会话（只有匹配的才建立）', async () => {
    await expectBadFramesRejected(() => [validState({ clientNonce: 'nonce_WRONG_12chars' })])
  })

  it('requestId 不匹配的单帧 host.state 不得建立会话（只有匹配的才建立）', async () => {
    await expectBadFramesRejected(() => [validState({ requestId: 'req-other-999' })])
  })

  it('规格外类型（page.ack / host.error / page.unauthorized / session.*）不得建立会话', async () => {
    await expectBadFramesRejected(() => [
      { v: 1, type: 'page.ack', requestId: 'req-ready-1' },
      { v: 1, type: 'host.error', requestId: 'req-ready-1', reason: 'x' },
      { v: 1, type: 'page.unauthorized', requestId: 'req-ready-1' },
      { v: 1, type: 'session.hello' },
      { v: 1, type: 'session.ended', handshakeId: HANDSHAKE_ID, reason: 'logout' },
    ])
  })

  it('v 为字符串 "1"、v 为 2、product 不对：都不建立会话', async () => {
    await expectBadFramesRejected(() => [
      validState({ v: '1' }),
      validState({ v: 2 }),
      validState({ product: 'other-host' }),
    ])
  })

  it('多了 token / authorization / url 字段的帧必须整帧丢弃（不做字段名正则绕过）', async () => {
    await expectBadFramesRejected(() => [
      validState({ token: 'canary-token' }),
      validState({ authorization: 'Bearer canary' }),
      validState({ url: 'https://evil.example.com/' }),
    ])
  })

  it('超过 4096 字节的帧必须丢弃（合法内容 + 前导空白填充，只让体积超限）', async () => {
    installHost({ silent: true, authenticated: true })
    meSucceeds()
    renderAuth()
    await waitFor(() => expect(transport.typeCount('page.ready')).toBe(1))
    const big = ' '.repeat(4200) + JSON.stringify(validState())
    expect(big.length, '前置：构造出的帧必须真的超过 4096 字节').toBeGreaterThan(4096)
    transport.send(big)
    await flush(4)
    expect(meCalls(), '超过 4096 字节的帧仍然建立了会话').toHaveLength(0)
    expect(userText()).toBe('none')
    transport.send(validState())
    await flushUntil(isHostUser)
    expect(userText()).toBe('host-user')
  })

  it('4096 是 UTF-8 字节上限：判据落在 parser 真正调用的 utf8ByteLength 接缝上（多字节边界）', () => {
    /*
     * 为什么不在 parser 级拿「多字节帧」证明：合法字段里唯一可能带多字节的只有
     * `apiOrigin`，而它的值必须是文档 origin（纯 ASCII）——所以**不存在**
     * 「字段值全部合法、又接近 4096」的 host.state（独立 reviewer 的 probe2 实测：
     * 合法字段最大值只有 326 字节）。旧版把多字节串塞进 `apiOrigin` 的 path，
     * 靠的是「路径不参与 origin 比较」；本轮 apiOrigin 的值形态已被要求校验，
     * 那种帧会因**字段非法**被拒 —— 继续用它就变成「红得对、理由错」的假绿。
     *
     * 所以字节数的敏感度钉在 parser 真正调用的这个纯函数上：把实现换成
     * `String.length`（故障对照 #17）时，这条必须打红。
     */
    // 3 字节字符边界：1365 × 3 = 4095 ≤ 4096；1366 × 3 = 4098 > 4096
    expect(utf8ByteLength('中'.repeat(1365))).toBe(4095)
    expect(utf8ByteLength('中'.repeat(1365))).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    expect(utf8ByteLength('中'.repeat(1366))).toBe(4098)
    expect(utf8ByteLength('中'.repeat(1366))).toBeGreaterThan(MAX_FRAME_BYTES)
    // 4 字节字符（UTF-16 代理对：String.length 会数成 2）
    expect(utf8ByteLength('😀'.repeat(1024))).toBe(4096)
    expect(utf8ByteLength('😀'.repeat(1025))).toBe(4100)
    expect('😀'.repeat(1024)).toHaveLength(2048)
    // ASCII 与多字节混合：字节数 ≠ 字符数
    const mixed = 'a'.repeat(10) + '中'.repeat(10)
    expect(utf8ByteLength(mixed)).toBe(40)
    expect(mixed).toHaveLength(20)
  })

  /*
   * R7 判据补强（R6 独立 review `web-round6-grok.md` §4 · M1）。
   *
   * 上面那条只断言**纯函数**的字节计数：把 `parseHostFrame` 内部两处 `utf8ByteLength`
   * 换成 `String.length`、函数本体不动时，4096 套件仍然全绿——所以说不动 parser 真的
   * 消费了这个计数。
   *
   * 这里补一条 parser 级运行时可判别的用例：用**合法字段值**造出「字符数 ≤ 4096
   * 但字节数 > 4096」的帧。`apiOrigin` 取 IDN 主机（`http://中…`）——`isOriginValue`
   * 接受它（pathname 就是 `/`，与「带 path 的非法值」不是一回事），`JSON.stringify`
   * 又保留原始多字节字符，于是 `String.length` 与 UTF-8 字节数在这帧上分岔：
   *   · 正确实现（按字节）→ 体积超限，整帧丢弃；
   *   · 退化成 `String.length` → 体积「没超」，帧被接受。
   * 反向对照用同一个 IDN origin 的短帧，证明这不是「拒绝一切多字节」。
   */
  it('M1：字符数未超但字节数超限的多字节合法帧必须被丢弃（parser 真的按字节计数）', () => {
    const makeFrame = (idnChars: number) => ({
      v: 1,
      type: 'host.state',
      requestId: 'req-m1-1',
      clientNonce: 'nonce_m1_8',
      handshakeId: HANDSHAKE_ID,
      product: 'pim-host-windows',
      apiOrigin: `http://${'中'.repeat(idnChars)}`,
      authenticated: true,
    })

    // 反向对照：短 IDN origin 是合法字段值，parser 必须接受（防止判据恒假）
    expect(
      parseHostFrame(makeFrame(3)),
      'IDN 主机的 apiOrigin 是合法 origin 值（pathname = "/"），不该被字段校验拒绝',
    ).not.toBeNull()

    const oversized = JSON.stringify(makeFrame(1366))
    expect(
      oversized.length,
      '前置：字符数必须仍在 4096 以内——String.length 判据会放行这帧',
    ).toBeLessThanOrEqual(MAX_FRAME_BYTES)
    expect(utf8ByteLength(oversized), '前置：UTF-8 字节数必须超过 4096').toBeGreaterThan(MAX_FRAME_BYTES)
    expect(
      parseHostFrame(makeFrame(1366)),
      '字节数超限的帧被接受了：parser 的 4096 上限退化成了 String.length（M1 判据洞）',
    ).toBeNull()
  })

  it('4096 字节整（字段值全部合法 + 只有 ASCII JSON 空白）必须被接受，不因判据过严被误杀', async () => {
    installHost({ silent: true, authenticated: true })
    meSucceeds()
    renderAuth()
    await waitFor(() => expect(transport.typeCount('page.ready')).toBe(1))
    const exact = paddedState(MAX_FRAME_BYTES)
    expect(utf8ByteLength(exact), '前置：构造出的帧必须正好 4096 字节').toBe(MAX_FRAME_BYTES)
    transport.send(exact)
    await flushUntil(isHostUser)
    expect(userText(), '恰好 4096 字节的合法帧被拒绝了：上限比规格更严').toBe('host-user')
  })

  it('4097 字节（同一合法帧只多一个 ASCII 空白）必须被丢弃', async () => {
    installHost({ silent: true, authenticated: true })
    meSucceeds()
    renderAuth()
    await waitFor(() => expect(transport.typeCount('page.ready')).toBe(1))
    const over = paddedState(MAX_FRAME_BYTES + 1)
    expect(utf8ByteLength(over), '前置：构造出的帧必须正好 4097 字节').toBe(MAX_FRAME_BYTES + 1)
    transport.send(over)
    await flush(4)
    expect(meCalls(), '4097 字节的帧仍然建立了会话').toHaveLength(0)
    expect(userText()).toBe('none')
    // 反向对照：同一 ready 上的合法帧必须建立会话（防止判据恒假）
    transport.send(validState())
    await flushUntil(isHostUser)
    expect(userText()).toBe('host-user')
  })

  it('真实 object 形态（PostWebMessageAsJson → event.data 是对象）同样能配对并建立会话', async () => {
    /*
     * 真实 WebView2 的宿主→页面消息是对象；测试夹具的 `send()` 发的是 JSON 字符串。
     * 只用字符串形态自证，就证明不了「页面在真实事件形态下也认得这帧」。
     * 平台本身仍未实跑（NOT-VERIFIED），这里只钉住页面的解析分支。
     */
    installHost({ silent: true, authenticated: true })
    meSucceeds()
    renderAuth()
    await waitFor(() => expect(transport.typeCount('page.ready')).toBe(1))
    transport.sendObject(validState())
    await flushUntil(isHostUser)
    expect(userText(), '对象形态的 host.state 没有建立会话').toBe('host-user')
    expect(meCalls().length).toBeGreaterThan(0)
    expect(screen.getByTestId('channel').textContent).toBe('host')
  })

  it('object 形态的 host.state 同样受白名单与配对约束（多一个字段仍整帧丢弃）', async () => {
    installHost({ silent: true, authenticated: true })
    meSucceeds()
    renderAuth()
    await waitFor(() => expect(transport.typeCount('page.ready')).toBe(1))
    transport.sendObject(validState({ token: 'canary-token' }))
    await flush(4)
    expect(meCalls(), '对象形态带契约外字段的帧被接受了').toHaveLength(0)
    expect(userText()).toBe('none')
    transport.sendObject(validState({ clientNonce: 'nonce_WRONG_12chars' }))
    await flush(4)
    expect(meCalls(), '对象形态 nonce 不匹配的帧被接受了').toHaveLength(0)
    // 反向对照：同一 ready 的对象形态合法帧必须建立会话
    transport.sendObject(validState())
    await flushUntil(isHostUser)
    expect(userText()).toBe('host-user')
  })

  it('apiOrigin 必须与文档 origin 精确一致才进入 ready（不用子字符串比较）', async () => {
    const port = new URL(DOC_ORIGIN).port || (DOC_ORIGIN.startsWith('https') ? '443' : '80')
    const vectors: [string, string][] = [
      ['端口前缀陷阱', `${DOC_ORIGIN.replace(new RegExp(`:${port}$`), '')}:${port}0`],
      ['scheme 不同', DOC_ORIGIN.replace(/^http:/, 'https:')],
      ['主机不同', 'http://evil.example.com'],
      ['尾部点', `${DOC_ORIGIN}.`],
    ]
    installHost({ silent: true, authenticated: true })
    meSucceeds()
    renderAuth()
    await waitFor(() => expect(transport.typeCount('page.ready')).toBe(1))
    for (const [label, origin] of vectors) {
      expect(origin, `${label} 的向量与文档 origin 相同了，对照失效`).not.toBe(DOC_ORIGIN)
      transport.send(validState({ apiOrigin: origin }))
      await flush(2)
      expect(meCalls(), `apiOrigin=${origin}（${label}）竟然进入了 ready`).toHaveLength(0)
      expect(userText()).toBe('none')
    }
    transport.send(validState({ apiOrigin: DOC_ORIGIN }))
    await flushUntil(isHostUser)
    expect(userText(), 'apiOrigin 与文档 origin 一致时仍未进入 ready').toBe('host-user')
  })

  it('有标记但 500ms 内没有合法 host.state：保持 host（不退回 browser），账密表单不出现，500ms 出现可重试入口', async () => {
    vi.useFakeTimers()
    installHost({ silent: true })
    renderHostRoute()
    // 假定时器下不能用 waitFor（它内部等真实 setTimeout，会挂到超时），改为显式推进
    await flush(4)
    expect(
      transport.typeCount('page.ready'),
      'host 通道没有发 page.ready：超时用例连入口都到不了',
    ).toBe(1)
    // 499ms：还没到 500ms，仍在 pending，不该出现任何「回到浏览器」的痕迹
    await act(async () => {
      await vi.advanceTimersByTimeAsync(499)
    })
    expect(screen.getByTestId('channel').textContent, 'host 通道退回了 browser').toBe('host')
    expect(credentialFormVisible(), '499ms 就出现了账密表单（还在 pending）').toBe(false)
    expect(retryButton(), '499ms 就出现了重试入口（超时常量不是 500ms）').toBeNull()

    // 500ms：进入 host/unavailable —— 仍是 host，仍不显示账密表单，出现可重试入口
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1)
    })
    await flush(2)
    expect(screen.getByTestId('channel').textContent, 'host 通道退回了 browser').toBe('host')
    expect(credentialFormVisible(), 'host/unavailable 显示了账密表单（退回浏览器登录）').toBe(false)
    expect(tokenStorageTouched(), 'host 通道不得写令牌 storage').toBe(false)
    const retry = retryButton()
    expect(retry, '500ms 超时后没有可重试入口（规格 §1 的 host/unavailable）').not.toBeNull()

    // 重试只再发一条新的 page.ready
    await act(async () => {
      fireEvent.click(retry!)
    })
    await flush(2)
    expect(transport.typeCount('page.ready'), '重试必须只再发一条新的 page.ready').toBe(2)
  })

  it('/auth/me 的非 401 错误：bootError、不写令牌、不退出宿主会话；重试后能恢复', async () => {
    installHost({ authenticated: true })
    fetchImpl = (url) => (url.endsWith('/api/v1/auth/me') ? statusOnly(500) : envelope(null))
    renderAuth()
    await waitFor(
      () =>
        expect(
          meCalls().length,
          'host.state.authenticated=true 时没有调用 /auth/me：非 401 分支到不了',
        ).toBeGreaterThan(0),
    )
    await waitFor(() => expect(screen.getByTestId('boot-error').textContent).toBe('true'))
    expect(userText(), '非 401 失败不得把用户设成已登录').toBe('none')
    expect(tokenStorageTouched(), '非 401 失败不得写令牌 storage').toBe(false)
    expect(screen.getByTestId('channel').textContent, '非 401 失败不得退出宿主会话').toBe('host')

    // 宿主会话保持：重试后 me 成功即可恢复（不因为一次 500 丢掉会话）
    const before = fetchCalls.length
    meSucceeds()
    fireEvent.click(screen.getByRole('button', { name: 'do-retry' }))
    await waitFor(() => expect(userText()).toBe('host-user'))
    expect(fetchCalls.length).toBeGreaterThan(before)
  })

  it('host 通道下 login()/register() 不得写令牌 storage', async () => {
    installHost({ authenticated: false })
    fetchImpl = () => envelope({ accessToken: 'a1', refreshToken: 'r1', user: { username: 'x' } })
    const user = userEvent.setup()
    renderAuth()
    await waitFor(() => expect(screen.getByTestId('channel').textContent).toBe('host'))
    const before = tokenIO()
    await user.click(screen.getByRole('button', { name: 'do-login' }))
    await user.click(screen.getByRole('button', { name: 'do-register' }))
    await tick()
    const after = tokenIO()
    expect(
      after.writes,
      'host 通道下 login/register 把令牌写进了 storage：WebView 里会出现令牌（B5 违反）',
    ).toBe(before.writes)
  })

  it('host 通道下服务器地址表单不能保存，也不清令牌（规格 §6.1）', async () => {
    /*
     * host 通道的基址是文档 origin；页面里的「服务器地址」既不可信也不该被保存。
     * 更关键的是：保存路径原来会 clearTokens()（浏览器里那是「换服务器要重新登录」），
     * 在宿主嵌入页里等于让页面去动令牌 storage —— 规格 §6.1 明令不许。
     */
    installHost({ authenticated: false })
    setTokens('canary-access', 'canary-refresh')
    const user = userEvent.setup()
    const qc = new QueryClient()
    render(
      <QueryClientProvider client={qc}>
        <AuthProvider>
          <MemoryRouter initialEntries={['/settings/server']}>
            <Routes>
              <Route path="/settings/server" element={<ServerForm mode="settings" />} />
            </Routes>
          </MemoryRouter>
        </AuthProvider>
      </QueryClientProvider>,
    )
    const before = tokenIO()
    await user.click(await screen.findByRole('button', { name: '保存并重新登录' }))
    await tick()
    expect(
      tokenIO().writes - before.writes,
      'host 通道下保存服务器地址触发了 clearTokens（页面动了令牌 storage）',
    ).toBe(0)
    expect(getApiBase(), 'host 通道下服务器地址被保存了').toBe(API_BASE)
  })
})

/* ══ 4. host 通道：401 / 刷新 / 退出（RED，规格 §6.2） ═══════ */

describe('host 通道：401 / 刷新 / 退出（RED，规格 §6.2）', () => {
  it('三次并发 401：恰好一条 page.refresh，每条请求恰好重放一次（每请求自己的首 401、重放 200）', async () => {
    installHost()
    const statuses: number[] = []
    fetchImpl = () => {
      // 顺序台账：前 3 次 = 三条请求各自的首次尝试（都 401），
      // 之后 3 次 = 三份重放（都 200）。不是全局奇偶。
      const status = statuses.length < 3 ? 401 : 200
      statuses.push(status)
      return status === 200 ? envelope({ ok: true }) : statusOnly(401)
    }
    const results = await Promise.allSettled([
      apiFetch(API_PATH),
      apiFetch(API_PATH),
      apiFetch(API_PATH),
    ])
    expect(
      transport.typeCount('page.refresh'),
      'host 通道的 401 没有走 page.refresh 单飞：并发 401 各自重试会打死宿主刷新',
    ).toBe(1)
    expect(statuses, `每条请求应恰好两次尝试（首 401 + 重放 200），实际 ${statuses.join(',')}`).toEqual(
      [401, 401, 401, 200, 200, 200],
    )
    expect(results.every((r) => r.status === 'fulfilled'), '三次并发里有的请求没有成功').toBe(true)
    expect(dataCalls()).toHaveLength(6)
  })

  it('重放再一次 401 时不得发第二条 page.refresh，请求失败', async () => {
    installHost()
    fetchImpl = () => statusOnly(401)
    const raw = apiFetch(API_PATH)
    void raw.catch(() => {})
    await expect(raw).rejects.toThrow()
    expect(
      transport.typeCount('page.refresh'),
      `本次请求应恰好刷新一次（重放再次 401 不得再刷新），实际 ${transport.typeCount('page.refresh')} 次`,
    ).toBe(1)
    expect(dataCalls(), '每条请求最多两次尝试（首 + 一次重放）').toHaveLength(2)
  })

  it('host 通道出站不带 Authorization，且调用期间令牌 storage 读写为 0', async () => {
    installHost()
    // 故意留下浏览器通道的令牌：host 通道必须完全无视它
    setTokens('canary-access', 'canary-refresh')
    fetchImpl = () => envelope({ ok: true })
    const before = tokenIO()
    await apiFetch(API_PATH)
    await fetchBlob(API_PATH)
    const after = tokenIO()
    expect(
      fetchCalls.every((c) => c.auth === null),
      `host 通道出站带了 Authorization：${fetchCalls.map((c) => c.auth).join(',')}`,
    ).toBe(true)
    expect(
      after.reads - before.reads,
      'host 通道调用期间读取了 pim.accessToken / pim.refreshToken',
    ).toBe(0)
    expect(
      after.writes - before.writes,
      'host 通道调用期间写入了 pim.accessToken / pim.refreshToken',
    ).toBe(0)
  })

  it('host 通道 fetchBlob 默认（未开 refreshOn401）也必须走同一套宿主刷新并重放', async () => {
    installHost()
    let hit = 0
    fetchImpl = () => {
      hit += 1
      if (hit === 1) return statusOnly(401)
      return new Response('BEGIN:VCALENDAR', { status: 200 })
    }
    let blob: Blob | null = null
    let failure: unknown = null
    try {
      blob = await fetchBlob('/api/v1/calendar/export-ics')
    } catch (err) {
      failure = err
    }
    expect(
      failure,
      `fetchBlob 在 host 通道遇到 401 直接失败，没有走宿主刷新重放：${
        failure instanceof Error ? failure.message : ''
      }`,
    ).toBeNull()
    expect(await blob!.text()).toContain('BEGIN:VCALENDAR')
    expect(transport.typeCount('page.refresh'), 'fetchBlob 的 401 没有走宿主刷新').toBe(1)
    expect(hit, 'fetchBlob 必须恰好重放一次').toBe(2)
  })

  it('host.refresh.result(ok:false,reason:invalid)：抛错、不 clearTokens、不发 pim:unauthorized', async () => {
    const t = installHost()
    t.refreshResult = { v: 1, type: 'host.refresh.result', ok: false, reason: 'invalid' }
    fetchImpl = () => statusOnly(401)
    const before = tokenIO()
    await expect(apiFetch(API_PATH)).rejects.toThrow()
    expect(unauthorizedEvents, 'host 通道不得广播浏览器登出').toBe(0)
    expect(tokenIO().writes - before.writes, 'host 通道不得写令牌 storage').toBe(0)
  })

  it('host.refresh.result(ok:false,reason:transient)：请求失败但会话保持（不清令牌/不广播）', async () => {
    const t = installHost()
    t.refreshResult = { v: 1, type: 'host.refresh.result', ok: false, reason: 'transient' }
    fetchImpl = () => statusOnly(401)
    const before = tokenIO()
    await expect(apiFetch(API_PATH)).rejects.toThrow()
    expect(unauthorizedEvents).toBe(0)
    expect(tokenIO().writes - before.writes).toBe(0)
  })

  it('8 秒没有匹配的 host.refresh.result：这一次请求失败，不 clearTokens、不广播、宿主会话保持', async () => {
    vi.useFakeTimers()
    installHost()
    meSucceeds()
    const t = transport
    t.refreshResult = null // 永不回复
    renderAuth()
    await flushUntil(isHostUser)
    /*
     * 不把「用户必须是 host-user」当成前置断言（那是握手实现的 RED，不是本条的场景）。
     * 这里记录调用前的用户状态，要求这次超时**不改变**它 —— 一旦宿主实现起来，
     * `userBefore` 就是 host-user，"超时广播/清令牌" 会立刻把它打红。
     */
    const userBefore = userText()

    fetchImpl = () => statusOnly(401)
    const raw = apiFetch(API_PATH)
    void raw.catch(() => {})
    const settled: Promise<'fulfilled' | 'rejected'> = raw.then(
      () => 'fulfilled' as const,
      () => 'rejected' as const,
    )
    const state = (): Promise<string> => Promise.race([settled, Promise.resolve('pending')])
    await flush(4)
    expect(t.typeCount('page.refresh'), 'host 通道的 401 没有发 page.refresh').toBe(1)

    const writesBefore = tokenIO().writes
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7999)
    })
    expect(
      await state(),
      '不到 8 秒请求就失败了：宿主刷新超时不是 8000ms（规格 §6.2）',
    ).toBe('pending')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2)
    })
    expect(await state(), '8 秒后没有匹配的 host.refresh.result 时请求必须失败').toBe('rejected')
    expect(
      fetchCalls.some((c) => c.url.includes('/api/v1/auth/refresh')),
      'host 通道不得回退到浏览器刷新端点',
    ).toBe(false)
    expect(unauthorizedEvents, '超时不得广播浏览器登出').toBe(0)
    expect(tokenIO().writes - writesBefore, '超时不得 clearTokens / 写 storage').toBe(0)
    expect(userText(), '超时不得改变宿主会话中的用户状态').toBe(userBefore)
  })

  it('object 形态的 host.refresh.result（真实 PostWebMessageAsJson）同样生效', async () => {
    // 只证明字符串形态 = 只证明了一半：真实 WebView2 到页面的是对象。
    const t = installHost({ silent: true })
    fetchImpl = () => statusOnly(401)
    const raw = apiFetch(API_PATH)
    void raw.catch(() => {})
    await flush(4)
    const refresh = t.first('page.refresh')
    t.sendObject({
      v: 1,
      type: 'host.refresh.result',
      requestId: String(refresh.requestId),
      ok: false,
      reason: 'invalid',
    })
    await expect(raw).rejects.toThrow()
    expect(t.typeCount('page.refresh'), '对象形态的结果没有解掉这次刷新等待').toBe(1)
    expect(unauthorizedEvents, 'host 通道不得广播浏览器登出').toBe(0)
  })

  it('refresh.result invalid 本身不清用户；随后匹配的 session.ended(expired) 才清；transient 不清不广播', async () => {
    const t = installHost({ authenticated: true })
    meSucceeds()
    renderAuth()
    await flushUntil(isHostUser)
    // 入口断言（今天的 RED）：authenticated:true 必须真的去调 /auth/me
    expect(meCalls().length, 'host 通道没有调用 /auth/me：会话入口尚未实现').toBeGreaterThan(0)
    const userBefore = userText()

    // transient：不清用户、不广播
    t.refreshResult = { v: 1, type: 'host.refresh.result', ok: false, reason: 'transient' }
    fetchImpl = () => statusOnly(401)
    await expect(apiFetch(API_PATH)).rejects.toThrow()
    await tick()
    expect(unauthorizedEvents, 'transient 不得广播').toBe(0)
    expect(userText(), 'transient 不得清用户').toBe(userBefore)

    // invalid：本身不清用户
    t.refreshResult = { v: 1, type: 'host.refresh.result', ok: false, reason: 'invalid' }
    await expect(apiFetch(API_PATH)).rejects.toThrow()
    await tick()
    expect(userText(), 'invalid 结果本身不得清用户（只有 session.ended 结束会话）').toBe(userBefore)
    expect(unauthorizedEvents).toBe(0)

    // 只有匹配当前 handshakeId 的 session.ended(expired) 才清内存用户
    t.send({ v: 1, type: 'host.session.ended', handshakeId: HANDSHAKE_ID, reason: 'expired' })
    await flushUntil(() => userText() === 'none')
    expect(userText(), '匹配的 session.ended(expired) 没有清内存用户').toBe('none')
    expect(tokenStorageTouched(), 'host 通道不得写令牌 storage').toBe(false)
    expect(unauthorizedEvents, 'host 通道不得广播浏览器登出').toBe(0)
  })

  it('session.ended 只有匹配当前 handshakeId 才清用户：旧 handshakeId 不清', async () => {
    const t = installHost({ authenticated: true })
    meSucceeds()
    renderAuth()
    await flushUntil(isHostUser)
    expect(meCalls().length, 'host 通道没有调用 /auth/me：会话入口尚未实现').toBeGreaterThan(0)
    const userBefore = userText()
    t.send({ v: 1, type: 'host.session.ended', handshakeId: OLD_HANDSHAKE_ID, reason: 'logout' })
    await flush(2)
    expect(userText(), '旧 handshakeId 的 session.ended 把用户清了（导航代次失效）').toBe(userBefore)
    t.send({ v: 1, type: 'host.session.ended', handshakeId: HANDSHAKE_ID, reason: 'logout' })
    await flushUntil(() => userText() === 'none')
    expect(userText(), '匹配当前 handshakeId 的 session.ended 没有清内存用户').toBe('none')
    expect(tokenStorageTouched()).toBe(false)
    expect(unauthorizedEvents).toBe(0)
  })

  it('page.logout：2 秒内没有匹配的 session.ended 时用户与会话保持、不 clearTokens，且可以重试', async () => {
    vi.useFakeTimers()
    const t = installHost({ authenticated: true })
    meSucceeds()
    renderAuth()
    await flushUntil(isHostUser)
    const userBefore = userText()
    const logoutError = (): string => screen.getByTestId('logout-error').textContent ?? ''

    const writesBefore = tokenIO().writes
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'do-logout' }))
    })
    await flush(2)
    expect(t.typeCount('page.logout'), 'page.logout 没有发出：退出请求到不了宿主').toBe(1)

    // 2 秒内没有匹配当前 handshakeId 的 session.ended
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999)
    })
    expect(userText(), '还没到 2 秒就把用户清了').toBe(userBefore)
    /*
     * 1999ms 时**还没有**可重试错误：这条把「2 秒」这个常量真正钉住——
     * 只看「用户还在」是钉不住的（更短的超时同样保留用户）。故障对照里
     * 把 2000 改成 200 时，就是这一条先打红。
     */
    expect(logoutError(), '还没到 2 秒就报退出失败（退出超时常量不是 2000ms）').toBe('false')
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2)
    })
    expect(userText(), '2 秒无匹配回复后用户与会话必须保持').toBe(userBefore)
    expect(logoutError(), '2 秒超时后必须显示可重试的退出错误').toBe('true')
    expect(unauthorizedEvents, '退出超时不得广播浏览器登出').toBe(0)
    expect(tokenIO().writes - writesBefore, '退出超时不得 clearTokens').toBe(0)

    // 可重试：再点一次又发一条 page.logout
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'do-logout' }))
    })
    await flush(2)
    expect(t.typeCount('page.logout'), '退出超时后无法重试（应能再发一条 page.logout）').toBe(2)

    // 匹配的 session.ended 才清用户
    t.send({
      v: 1,
      type: 'host.session.ended',
      handshakeId: HANDSHAKE_ID,
      reason: 'logout',
      requestId: t.posted.filter((f) => f.type === 'page.logout').slice(-1)[0]?.requestId,
    })
    await flushUntil(() => userText() === 'none')
    expect(userText(), '匹配的 session.ended 没有清内存用户').toBe('none')
    expect(tokenStorageTouched(), 'host 通道不得写令牌 storage').toBe(false)
  })
})
