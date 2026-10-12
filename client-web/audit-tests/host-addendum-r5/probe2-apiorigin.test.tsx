// @vitest-environment jsdom
/*
 * Web R5 addendum · 疑点 2（独立 reviewer 探针 → 按 freeze 裁决并入有效 RED）
 *
 * 问题：`host.state.apiOrigin` 是 wire 的 **origin 字段**（规格 §2：「值是文档 origin：
 * `scheme://host`，默认端口不写」）。原实现只要求它是非空字符串，值形态不校验。
 *
 * 裁决（`remediation/coordination-round5.md`「Web 宿主字段解释」）：
 *   - 该字段的**值定义**要求拒绝 path/query/hash；「必须拒绝」清单不是字段定义的
 *     穷尽授权，负例清单之外的值形态同样按定义判；
 *   - `originOf()` 用于**来源 URL 解析**时允许带 path，这是对的，不改它（C2）；
 *   - freeze §3.4 允许缺省端口判等，所以不额外要求字节形态规范化（T3）。
 *
 * 判定只按 freeze：`remediation/host-session/reviewed-spec.md`
 * sha256 8964935021f69ff2e44c6d8932fa7a5f00645ddc5f249661b88f93694312ccf8
 *
 * 注意：本文件的 4096 字节敏感度**不在这里**证明。合法字段组合构造不出接近 4096 的
 * host.state（见文末事实记录），所以「多字节 → 超字节上限」的判据放在
 * `audit-tests/host-session.test.tsx` 的 `utf8ByteLength` 纯函数接缝上，
 * 不靠「apiOrigin 带非法 path 才被拒」冒充字节计数（那会假绿）。
 */
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AuthProvider, useAuth } from '@/features/auth/auth-context'
import { MAX_FRAME_BYTES, originOf, parseHostFrame } from '@/lib/host-wire'

const HANDSHAKE_ID = '6f1e8c0a-1b2c-4d3e-8f90-123456789abc'
const DOC = window.location.origin

/** 手写 wire：合法 canonical 字段 + 指定 apiOrigin（不经过被测序列化器生成期望值） */
function stateJson(apiOrigin: string, over: Partial<Record<string, unknown>> = {}): string {
  return JSON.stringify({
    v: 1,
    type: 'host.state',
    requestId: 'req-ready-1',
    clientNonce: 'nonce_12chars',
    handshakeId: HANDSHAKE_ID,
    product: 'pim-host-windows',
    apiOrigin,
    authenticated: true,
    ...over,
  })
}

/* ── 业务级：真实 AuthProvider 是否因该 apiOrigin 进入 ready ── */

function Probe() {
  const a = useAuth()
  return (
    <div>
      <span data-testid="user">{a.user?.username ?? 'none'}</span>
      <span data-testid="host-status">{a.hostStatus}</span>
    </div>
  )
}

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: 'x', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

let listeners: Set<(ev: MessageEvent) => void>
let posted: Record<string, unknown>[]
let meRequests: number

function installTransport(): void {
  ;(window as unknown as { __PIM_HOST_CHANNEL__?: unknown }).__PIM_HOST_CHANNEL__ = {
    v: 1,
    product: 'pim-host-windows',
  }
  posted = []
  meRequests = 0
  listeners = new Set()
  Object.defineProperty(window, 'chrome', {
    configurable: true,
    value: {
      webview: {
        postMessage: (msg: string) => {
          try {
            posted.push(JSON.parse(msg) as Record<string, unknown>)
          } catch {
            /* 忽略 */
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

const flush = async (n = 8): Promise<void> => {
  for (let i = 0; i < n; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 0))
    })
  }
}

async function readyPair(): Promise<{ requestId: string; clientNonce: string }> {
  await waitFor(() => expect(posted.filter((f) => f['type'] === 'page.ready')).toHaveLength(1))
  const ready = posted.find((f) => f['type'] === 'page.ready')!
  return { requestId: String(ready['requestId']), clientNonce: String(ready['clientNonce']) }
}

beforeEach(() => {
  installTransport()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith('/api/v1/auth/me')) {
        meRequests += 1
        return envelope({ username: 'host-user' })
      }
      return envelope(null)
    }),
  )
})

afterEach(() => {
  cleanup()
  delete (window as unknown as { chrome?: unknown }).chrome
  delete (window as unknown as { __PIM_HOST_CHANNEL__?: unknown }).__PIM_HOST_CHANNEL__
  vi.unstubAllGlobals()
})

describe('疑点 2 · 正控制（必须绿）', () => {
  it('C1：canonical origin（= 文档 origin）被 parse 接受且进入 ready（调 /auth/me）', async () => {
    const frame = parseHostFrame(stateJson(DOC))
    expect(frame, 'canonical origin 的合法 host.state 竟被 parse 拒绝').not.toBeNull()
    expect(frame && frame.type === 'host.state' ? frame.apiOrigin : null).toBe(DOC)

    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    const pair = await readyPair()
    sendRaw(stateJson(DOC, pair))
    await flush(10)
    expect(meRequests, 'canonical origin 没有建立会话').toBe(1)
    expect(screen.getByTestId('host-status').textContent).toBe('ready')
  })

  it('C2：`originOf` 用于「源 URL 解析」时可以含 path/query/hash（这不是缺陷）', () => {
    expect(originOf(`${DOC}/some/path?a=1#frag`)).toBe(DOC)
    expect(originOf(DOC)).toBe(DOC)
    // §3.4：缺省端口已被规范化 → :443 与不写端口相等（比较语义，不是字段值要求）
    expect(originOf('https://pim.example.com:443')).toBe(originOf('https://pim.example.com'))
    // §2：IPv6 主机带方括号
    expect(originOf('http://[::1]:8080')).toBe('http://[::1]:8080')
  })

  it('C3：userinfo 负例在 parse 级就被拒绝（§3.2：UserInfo 必须为空 ⇒ 不是合法字段值）', async () => {
    const userinfo = `http://user:pw@${new URL(DOC).host}`
    expect(originOf(userinfo)).toBeNull()
    // 值形态校验落地后：userinfo 连 parse 都过不了，不会走到握手比较
    expect(parseHostFrame(stateJson(userinfo)), 'userinfo 的 apiOrigin 被 parse 接受了').toBeNull()
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    const pair = await readyPair()
    sendRaw(stateJson(userinfo, pair))
    await flush(10)
    expect(meRequests, 'userinfo 的 apiOrigin 竟然建立了会话').toBe(0)
    expect(screen.getByTestId('host-status').textContent).toBe('pending')
  })
})

describe('疑点 2 · 目标断言（SPEC §2 值形态；失败 = parser 接纳非 origin 值）', () => {
  it('T1：apiOrigin 带 path / query / hash 不是 §2 的字段值，应被拒绝', () => {
    const vectors: [string, string][] = [
      ['path', `${DOC}/evil/path`],
      ['query', `${DOC}/?a=1`],
      ['hash', `${DOC}/#frag`],
      ['path+query+hash', `${DOC}/a/b?q=1#f`],
    ]
    const observed: Record<string, boolean> = {}
    for (const [label, v] of vectors) {
      expect(originOf(v), `${label} 的前置：originOf 仍等于文档 origin`).toBe(DOC)
      observed[label] = parseHostFrame(stateJson(v)) !== null
    }
    console.log('[probe2 T1 观测：parseHostFrame 是否接受]', JSON.stringify(observed))
    expect(observed, 'SPEC §2：apiOrigin 的值是文档 origin(scheme://host)，带路径/查询/片段不是字段值').toEqual(
      { path: false, query: false, hash: false, 'path+query+hash': false },
    )
  })

  it('T2：业务级——带 path 的 apiOrigin 不得让握手进入 ready', async () => {
    render(
      <AuthProvider>
        <Probe />
      </AuthProvider>,
    )
    const pair = await readyPair()
    sendRaw(stateJson(`${DOC}/evil/path`, pair))
    await flush(10)
    const observed = {
      meRequests,
      hostStatus: screen.getByTestId('host-status').textContent,
      user: screen.getByTestId('user').textContent,
    }
    console.log('[probe2 T2 观测]', JSON.stringify(observed))
    expect(observed, 'SPEC §2：非 origin 值不得建立会话').toEqual({
      meRequests: 0,
      hostStatus: 'pending',
      user: 'none',
    })
  })

  it('T3：缺省端口的比较语义（§3.4 判为相等，故接受；不额外要求规范化字节形态）', () => {
    // freeze §2 说「默认端口不写」（生产者侧串形态），§3.4 说比较时 https://host 与
    // https://host:443 相等。裁决明确：不额外规范化，也不把「写了缺省端口」判成非法值形态。
    expect(originOf('https://pim.example.com:443')).toBe('https://pim.example.com')
    expect(originOf('http://pim.example.com:80')).toBe('http://pim.example.com')
    expect(
      parseHostFrame(stateJson('https://pim.example.com:443')),
      '写了缺省端口的 origin 值形态被拒绝：超出的规范化要求',
    ).not.toBeNull()
    expect(parseHostFrame(stateJson('http://pim.example.com:80'))).not.toBeNull()
  })
})

describe('疑点 2 · 4096 字节测试的「合法字段组合」可行性（事实记录）', () => {
  it('用合法 canonical 字段能构造出的最大 host.state 帧远小于 4096 字节（如实结论）', () => {
    // 规格里每个字段的长度上限：requestId 1..64、clientNonce 8..64、handshakeId=UUID(36)、
    // product 常量(15)、apiOrigin=canonical origin（要建立会话就必须等于文档 origin）。
    const maxConforming = stateJson(DOC, {
      requestId: 'r'.repeat(64),
      clientNonce: 'n'.repeat(64),
    })
    const bytes = new TextEncoder().encode(maxConforming).length
    console.log('[probe2 4096 观测] 合法字段最大值字节数 =', bytes)
    expect(bytes).toBeLessThan(MAX_FRAME_BYTES)
    // 结论：合法字段组合**无法**接近 4096；不存在「字段值全部合法且接近 4096」的 host.state，
    // 因此 parser 级**不能**用合法多字节帧做字节上限正控制（不伪造这种正帧）。
    expect(bytes).toBeLessThan(700)
  })

  it('字段值全部合法的帧只加 JSON 前导空白就必被丢弃（体积判定本身有效）', () => {
    const canonical = stateJson(DOC)
    expect(parseHostFrame(canonical)).not.toBeNull()
    // JSON 文本允许前导空白；这里没有增加任何字段，也没有改任何字段值
    const padded = ' '.repeat(MAX_FRAME_BYTES) + canonical
    expect(parseHostFrame(padded), '超过 4096 字节的帧被接受了').toBeNull()
  })
})
