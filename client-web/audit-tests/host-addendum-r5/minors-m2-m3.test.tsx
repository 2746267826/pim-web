// @vitest-environment jsdom
/*
 * Grok R5 Minor M2 / M3 的回归补齐（独立 reviewer 指出：行为已对，但作者的套件钉不住）。
 *
 * M2：host 通道的**出站请求 URL** 必须忽略 `pim.apiBase`（规格 §6.1：基址=文档 origin）。
 *     原套件只断言「出站没有 Authorization」——把 `apiUrl` 的 host 分支去掉后那条仍然绿
 *     （请求照样不带 Bearer），所以它证明不了基址。这里直接**捕获真实请求 URL**，
 *     入口是完整的 `apiFetch` / `fetchBlob`（不是只调 `apiUrl` 这个纯函数）。
 *
 * M3：退出超时的可重试错误必须是**用户能看到的东西**。原套件读的是 `hostLogoutError`
 *     这个内存 flag，把 `notifyError` 去掉那条仍然绿。这里挂真实 `Toaster`（sonner），
 *     断言 1999ms 还没有文案、2001ms 出现文案。
 *
 * 唯一规格：`remediation/host-session/reviewed-spec.md`
 * （sha256 8964935021f69ff2e44c6d8932fa7a5f00645ddc5f249661b88f93694312ccf8）。
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { Toaster } from 'sonner'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { apiFetch, clearTokens, fetchBlob, resetRefreshState } from '@/api/client'
import { AuthProvider, useAuth } from '@/features/auth/auth-context'
import { getApiBase, setApiBase } from '@/lib/apiBase'
import { HOST_CHANNEL_MARKER_SCRIPT } from '@/lib/host-channel'
import { resetHostSession } from '@/lib/host-session'

/** browser 通道的基址（localStorage `pim.apiBase`）：host 通道必须完全不使用它 */
const API_BASE = 'http://192.0.2.10:5858'
const HANDSHAKE_ID = '6f1e8c0a-1b2c-4d3e-8f90-123456789abc'
const API_PATH = '/api/v1/today/sections'
const BLOB_PATH = '/api/v1/files/items/f-1/thumbnail'
const LOGOUT_TIMEOUT_MESSAGE = '退出登录未完成：桌面宿主没有确认，请重试'

interface Frame {
  type?: string
  requestId?: string
  clientNonce?: string
  [key: string]: unknown
}

/* ── faithful fake host transport（只实现规格 §2 的书面 wire） ── */

let posted: Frame[] = []
let listeners = new Set<(ev: MessageEvent) => void>()
let capturedUrls: string[] = []

function installTransport(withMarker: boolean): void {
  posted = []
  listeners = new Set()
  if (withMarker) {
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
          let frame: Frame
          try {
            frame = JSON.parse(msg) as Frame
          } catch {
            return
          }
          posted.push(frame)
          if (frame.type === 'page.ready') {
            send({
              v: 1,
              type: 'host.state',
              requestId: frame.requestId,
              clientNonce: frame.clientNonce,
              handshakeId: HANDSHAKE_ID,
              product: 'pim-host-windows',
              apiOrigin: window.location.origin,
              authenticated: true,
            })
          }
          // page.logout 刻意不回：这条用例要的是 2 秒超时路径
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

function send(frame: Frame): void {
  const data = JSON.stringify(frame)
  for (const l of [...listeners]) l(new MessageEvent('message', { data }))
}

function uninstallTransport(): void {
  delete (window as unknown as { chrome?: unknown }).chrome
  delete (window as unknown as { __PIM_HOST_CHANNEL__?: unknown }).__PIM_HOST_CHANNEL__
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: 'x', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

function Probe() {
  const a = useAuth()
  return (
    <div>
      <span data-testid="user">{a.user?.username ?? 'none'}</span>
      <button onClick={() => a.logout()}>do-logout</button>
    </div>
  )
}

const flush = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
      else await new Promise((r) => setTimeout(r, 0))
    })
  }
}

beforeEach(() => {
  clearTokens()
  resetRefreshState()
  resetHostSession()
  setApiBase(API_BASE)
  capturedUrls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)
      capturedUrls.push(url)
      if (url.endsWith('/api/v1/auth/me')) return envelope({ username: 'host-user' })
      if (url.includes(BLOB_PATH)) return new Response(new Uint8Array([120]), { status: 200 })
      return envelope(null)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  uninstallTransport()
  vi.unstubAllGlobals()
  resetHostSession()
  setApiBase('')
  resetRefreshState()
  clearTokens()
})

/* ── M2 ───────────────────────────────────────────────────── */

describe('Grok M2：host 出站请求 URL 必须忽略 pim.apiBase（真实 apiFetch / fetchBlob）', () => {
  it('host 通道：apiFetch 与 fetchBlob 的请求 URL 都是文档 origin 的相对路径', async () => {
    installTransport(true)
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await waitFor(() => expect(screen.getByTestId('user').textContent).toBe('host-user'))
    // 前置：browser 基址确实被配置过（否则「没用它」是空的）
    expect(getApiBase()).toBe(API_BASE)

    await apiFetch(API_PATH)
    await fetchBlob(BLOB_PATH)

    const urls = capturedUrls.filter((u) => u.includes(API_PATH) || u.includes(BLOB_PATH))
    expect(urls, '没有捕获到 host 通道的出站请求 URL').toHaveLength(2)
    for (const url of urls) {
      expect(url, `host 通道的出站 URL 用了 pim.apiBase：${url}`).not.toContain('192.0.2.10')
      expect(url, `host 通道的出站 URL 不是文档 origin 的相对路径：${url}`).toBe(
        url.startsWith('/api/') ? url : `<非相对路径> ${url}`,
      )
      expect(url.startsWith('/api/'), `host 通道的出站 URL 不是相对路径：${url}`).toBe(true)
    }
  })

  it('反向对照：browser 通道（无标记）仍然使用 pim.apiBase，证明上面的断言不是恒真', async () => {
    installTransport(false)
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    await flush(4)
    await apiFetch(API_PATH)
    const urls = capturedUrls.filter((u) => u.includes(API_PATH))
    expect(urls, '没有捕获到 browser 通道的出站请求 URL').toHaveLength(1)
    expect(
      urls[0],
      'browser 通道没有使用 pim.apiBase：这条对照证明不了 host 的断言',
    ).toBe(`${API_BASE}${API_PATH}`)
  })
})

/* ── M3 ───────────────────────────────────────────────────── */

describe('Grok M3：退出超时必须有用户可见的真实 toast（sonner），不只是内存 flag', () => {
  it('1999ms 还没有 toast，2001ms 出现可重试文案；用户与会话保持', async () => {
    vi.useFakeTimers()
    installTransport(true)
    render(
      <AuthProvider>
        <Probe />
        <Toaster />
      </AuthProvider>,
    )
    await flush(10)
    expect(screen.getByTestId('user').textContent, '前置：宿主会话没有建立').toBe('host-user')

    const toastVisible = (): boolean =>
      (document.body.textContent ?? '').includes(LOGOUT_TIMEOUT_MESSAGE)

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'do-logout' }))
    })
    await flush(2)
    expect(posted.filter((f) => f.type === 'page.logout'), 'page.logout 没有发出').toHaveLength(1)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999)
    })
    expect(toastVisible(), '还没到 2 秒就弹出了退出失败 toast（超时常量不是 2000ms）').toBe(false)

    await act(async () => {
      await vi.advanceTimersByTimeAsync(2)
    })
    await flush(2)
    expect(toastVisible(), '2 秒超时后没有出现用户可见的退出失败 toast').toBe(true)
    expect(screen.getByTestId('user').textContent, '退出超时后用户被清了').toBe('host-user')
  })
})

/* ── M1 的标记（文档常量，防止注释与实现对不上） ───────────── */

describe('Grok M1：生产标记脚本仍是同一份常量（注释已同步实现状态）', () => {
  it('常量脚本逐字节不变，且不含令牌/URL/用户信息', () => {
    expect(HOST_CHANNEL_MARKER_SCRIPT).toBe(
      'window.__PIM_HOST_CHANNEL__={v:1,product:"pim-host-windows"};',
    )
    expect(HOST_CHANNEL_MARKER_SCRIPT).not.toMatch(/token|authorization|https?:|refresh/i)
  })
})
