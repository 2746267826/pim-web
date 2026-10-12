// @vitest-environment jsdom
/*
 * PW-07a §12.3 Web 行为 RED（唯一规格 remediation/native-embed/reviewed-spec.md §8）。
 *
 * 证据等级：真实 `AndroidTodayEmbedPage` / `AndroidTracksEmbedPage` / `bridge.ts` /
 * `client.ts` + jsdom + fake `pimAndroid` / `Capacitor` 桥面 + fake `fetch`。
 * **不改任何产品源码**：失败必须来自「今天页面发出的信封缺 version/id」「今天页面不读原生
 * v1 回复」「今天先取 pimAndroid 而不是 Capacitor」这类真实行为。
 *
 * 用假定时器 + 手工 `act` 推进，避免 5 秒桥超时把失败变成“没有业务断言的超时”。
 * 期望帧在测试里手写，不导入被测序列化器生成期望值。
 *
 * 平台边界：jsdom 里的 `pimAndroid`/`Capacitor` 是**测试注入的桥面**。系统 WebView 是否
 * 会在真实设备上调用 `shouldInterceptRequest`、`onmessage` 的投递时机、502 投递都是规格
 * §11 的 NOT-VERIFIED，本文件不声称已覆盖。
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { act, cleanup, render } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { AndroidTodayEmbedPage, AndroidTracksEmbedPage } from '@/embed/android/android-embed-pages'
import * as bridgeModule from '@/embed/android/bridge'
import { setApiBase } from '@/lib/apiBase'
import { clearTokens, setTokens } from '@/api/client'

const API_BASE = 'http://127.0.0.1:5859'
/** 原生会话令牌 canary：任何页面可见面都不得出现（G1）。 */
const CANARY = 'canary-native-access-token-1'
const BROWSER_TOKEN = 'browser-access-token-1'
const BASE_MILLIS = Date.parse('2026-10-11T00:00:00.000Z')

/* ── fake 桥面（手写，不导入被测实现） ───────────────────────── */

type BridgeEvent =
  | { kind: 'post'; raw: string }
  | { kind: 'onmessage-assign' }
  | { kind: 'onmessage-call' }

class FakePimAndroid {
  readonly log: BridgeEvent[] = []
  private handler: ((event: { data: string }) => void) | null = null

  get onmessage(): ((event: { data: string }) => void) | null {
    return this.handler
  }

  set onmessage(value: ((event: { data: string }) => void) | null) {
    this.log.push({ kind: 'onmessage-assign' })
    this.handler = value
  }

  postMessage(raw: string): void {
    this.log.push({ kind: 'post', raw })
  }

  posts(): string[] {
    return this.log.filter((e): e is { kind: 'post'; raw: string } => e.kind === 'post').map((e) => e.raw)
  }

  messages(): Record<string, unknown>[] {
    return this.posts().map((raw) => JSON.parse(raw) as Record<string, unknown>)
  }

  /** 按规格 §8.2 的原生 v1 回复通道回送。 */
  reply(message: Record<string, unknown>): void {
    this.log.push({ kind: 'onmessage-call' })
    this.handler?.({ data: JSON.stringify(message) })
  }
}

class FakeCapacitor {
  readonly raw: string[] = []
  readonly handleMessage = (options: { raw: string }): void => {
    this.raw.push(options.raw)
  }

  messages(): Record<string, unknown>[] {
    return this.raw.map((raw) => JSON.parse(raw) as Record<string, unknown>)
  }
}

let native: FakePimAndroid
let capacitor: FakeCapacitor

function installNative(bridge: FakePimAndroid | null): void {
  if (bridge) {
    ;(globalThis as { pimAndroid?: unknown }).pimAndroid = bridge
  } else {
    delete (globalThis as { pimAndroid?: unknown }).pimAndroid
  }
}

function installCapacitor(instance: FakeCapacitor | null): void {
  if (instance) {
    ;(globalThis as { Capacitor?: unknown }).Capacitor = {
      Plugins: { PimBridge: { handleMessage: instance.handleMessage } },
    }
  } else {
    delete (globalThis as { Capacitor?: unknown }).Capacitor
  }
}

/* ── fake fetch ─────────────────────────────────────────────── */

interface FetchCall {
  url: string
  method: string
  headers: Record<string, string>
}

type Responder = () => Response | Promise<Response>

let calls: FetchCall[] = []
let routes: { test: RegExp; respond: Responder }[] = []

function route(pattern: RegExp, respond: Responder): void {
  routes.push({ test: pattern, respond })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: 0, message: 'ok', data }), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

function defaultBody(url: string): unknown {
  if (url.includes('/mobile/summary')) return USAGE
  if (url.includes('/location/analytics/overview')) return OVERVIEW
  if (url.includes('/location/analytics/tracks')) return TRACKS
  return {}
}

function installFetch(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: unknown, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : String((input as Request).url ?? input)
      const headers = Object.fromEntries(new Headers(init?.headers ?? {}).entries())
      calls.push({ url, method: init?.method ?? 'GET', headers })
      const match = routes.find((r) => r.test.test(url))
      if (!match) return json(defaultBody(url))
      return match.respond()
    }),
  )
}

function headerOf(call: FetchCall, name: string): string | undefined {
  const key = Object.keys(call.headers).find((k) => k.toLowerCase() === name.toLowerCase())
  return key ? call.headers[key] : undefined
}

/* ── render helpers（假定时器 + 手工 act） ───────────────────── */

function newQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity, refetchOnWindowFocus: false },
    },
  })
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await Promise.resolve()
    })
  }
}

async function advance(ms: number): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms)
  })
  await flush(2)
}

function renderToday(): HTMLElement {
  const { container } = render(
    <QueryClientProvider client={newQueryClient()}>
      <MemoryRouter initialEntries={['/embed/android/today']}>
        <AndroidTodayEmbedPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return container
}

function renderTracks(): HTMLElement {
  const { container } = render(
    <QueryClientProvider client={newQueryClient()}>
      <MemoryRouter initialEntries={['/embed/android/tracks']}>
        <AndroidTracksEmbedPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return container
}

function textOf(container: HTMLElement): string {
  return (container.textContent ?? '').replace(/\s+/g, ' ')
}

function stateRequestId(messages: Record<string, unknown>[]): string | undefined {
  const msg = messages.filter((m) => m.type === 'native.state.request').pop()
  if (!msg) return undefined
  if (typeof msg.id === 'string') return msg.id
  if (typeof msg.requestId === 'string') return msg.requestId
  return undefined
}

function pageReports(bridge: FakePimAndroid): Record<string, unknown>[] {
  return bridge.messages().filter((m) => m.type === 'page.report')
}

function storageValues(): string[] {
  return [window.localStorage, window.sessionStorage].flatMap((store) =>
    Object.keys(store).map((key) => store.getItem(key) ?? ''),
  )
}

const OVERVIEW = { pointCount: 3, distanceMeters: 1234, usablePointCount: 3 }
const USAGE = { totalForegroundSeconds: 3600, appSwitchCount: 12, completeness: 1, appRanking: [] }
const TRACKS: unknown[] = []

function installDefaultRoutes(): void {
  route(/\/api\/v1\/mobile\/location\/analytics\/overview/, () => json(OVERVIEW))
  route(/\/api\/v1\/mobile\/location\/analytics\/tracks/, () => json(TRACKS))
  route(/\/api\/v1\/mobile\/summary/, () => json(USAGE))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(BASE_MILLIS))
  calls = []
  routes = []
  native = new FakePimAndroid()
  capacitor = new FakeCapacitor()
  installNative(native)
  installCapacitor(null)
  delete (globalThis as { __pimBridgeInstalled?: unknown }).__pimBridgeInstalled
  delete (globalThis as { __pimBridgeReceive?: unknown }).__pimBridgeReceive
  window.localStorage.clear()
  window.sessionStorage.clear()
  clearTokens()
  setApiBase(API_BASE)
  installFetch()
})

afterEach(() => {
  // 让桥的 5 秒超时先跑完，避免 pending 残留跨用例
  act(() => {
    vi.advanceTimersByTime(10_000)
  })
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
  installNative(null)
  installCapacitor(null)
})

/* ── W：行为 RED ────────────────────────────────────────────── */

describe('PW-07a W 行为 RED（打在今天的产品入口上）', () => {
  it('W1 今日页发给原生的状态请求是 v1 信封 {version,id,type}', async () => {
    renderToday()
    await flush()

    const requests = native.messages().filter((m) => m.type === 'native.state.request')
    expect(requests.length).toBeGreaterThan(0)
    const message = requests[0]!
    expect(message.version).toBe(1)
    expect(typeof message.id).toBe('string')
    expect(String(message.id).length).toBeGreaterThan(0)
    expect(message.requestId).toBeUndefined()
    expect(message.payload).toBeUndefined()
  })

  it('W2 onmessage 必须在第一次 postMessage 之前注册，且 v1 回复能把卡片带到「状态未知」', async () => {
    const container = renderToday()
    await flush()

    expect(typeof native.onmessage).toBe('function')
    expect(native.log[0]?.kind).toBe('onmessage-assign')

    const id = stateRequestId(native.messages())
    expect(typeof id).toBe('string')
    native.reply({ version: 1, id, ok: true, nativeState: {} })
    await flush()
    await advance(6_000)

    const text = textOf(container)
    expect(text).toContain('状态未知')
    expect(text).not.toContain('采集已中断')
    expect(text).not.toContain('原生未返回采集状态')
  })

  it('W3a collectionMode === false 才显示「采集已中断」', async () => {
    const container = renderToday()
    await flush()

    native.reply({
      version: 1,
      id: stateRequestId(native.messages()),
      ok: true,
      nativeState: { collectionMode: false },
    })
    await flush()
    await advance(6_000)

    expect(textOf(container)).toContain('采集已中断')
  })

  it('W3b 缺失 collectionMode 不得显示「采集已中断」', async () => {
    const container = renderToday()
    await flush()

    native.reply({
      version: 1,
      id: stateRequestId(native.messages()),
      ok: true,
      nativeState: { pending: 4, triggerReason: 'schedule' },
    })
    await flush()
    await advance(6_000)

    const text = textOf(container)
    expect(text).not.toContain('采集已中断')
    expect(text).not.toContain('持续采集中')
  })

  it('W4 上报要等 location 与 usage 都结束：usage 仍在加载时不得上报空数据', async () => {
    const usageGate = deferred<Response>()
    /*
     * 规格 §8.4 的三态表：只有「两者都成功，且 pointCount 与 totalForegroundSeconds 都是数字 0」
     * 才是 hasServerData:false。所以这条用例必须把两个计数都置 0 才配得上 false 的期望；
     * 若沿用默认 OVERVIEW 的 pointCount:3，按规格应报 true，正确实现反而被这条期望判红。
     */
    route(/\/api\/v1\/mobile\/location\/analytics\/overview/, () => json({ ...OVERVIEW, pointCount: 0 }))
    route(/\/api\/v1\/mobile\/location\/analytics\/tracks/, () => json(TRACKS))
    route(/\/api\/v1\/mobile\/summary/, () => usageGate.promise)

    renderToday()
    await flush()
    await advance(1_000)

    expect(pageReports(native)).toEqual([])

    usageGate.resolve(json({ ...USAGE, totalForegroundSeconds: 0 }))
    await flush()
    await advance(1_000)

    const reports = pageReports(native)
    expect(reports.length).toBeGreaterThan(0)
    // pointCount=0 且 totalForegroundSeconds=0（两个都是数字 0）→ 规格 §8.4 的 false 分支
    expect(reports[reports.length - 1]!.report).toMatchObject({ hasServerData: false, error: null })
  })

  it('W4b 任一查询 isError 时 hasServerData 为 null，错误文案是安全文案', async () => {
    route(/\/api\/v1\/mobile\/location\/analytics\/overview/, () => json(OVERVIEW))
    route(/\/api\/v1\/mobile\/location\/analytics\/tracks/, () => json(TRACKS))
    route(
      /\/api\/v1\/mobile\/summary/,
      () =>
        new Response(JSON.stringify({ code: 500, message: '上游内部错误' }), {
          status: 500,
          headers: { 'Content-Type': 'application/json' },
        }),
    )

    renderToday()
    await flush()
    await advance(2_000)

    const reports = pageReports(native)
    expect(reports.length).toBeGreaterThan(0)
    const report = reports[reports.length - 1]!.report as Record<string, unknown> | undefined
    expect(report, '上报必须是 v1 信封 {version,id,type:page.report,report:{...}}').toBeDefined()
    expect(report!.hasServerData).toBeNull()
    /*
     * 规格 §8.4：`generatedAt` 是**成功查询**里 `dataUpdatedAt` 最大值的 ISO。
     * 本 fixture 只有 usage 失败，location/tracks 都成功（都在 t=BASE 解析），
     * 所以最大值是 BASE_MILLIS。原断言写成「没有成功查询时必须为 null」，与 fixture 自相矛盾
     * （合规实现反而被判红）；「没有任何成功查询 → null」改由新增的 W4c 覆盖。
     */
    expect(report!.generatedAt).toBe(new Date(BASE_MILLIS).toISOString())
    const error = String(report!.error ?? '')
    expect(error.length).toBeGreaterThan(0)
    expect(error).not.toContain('{"code"')
    expect(error).not.toContain('http://')
    expect(error).not.toContain('at ')
    expect(Array.from(error).length).toBeLessThanOrEqual(200)
  })

  it('W4c 三个查询全部失败时 generatedAt 为 null（没有成功查询）', async () => {
    const failing = () =>
      new Response(JSON.stringify({ code: 500, message: '上游内部错误' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      })
    route(/\/api\/v1\/mobile\/location\/analytics\/overview/, failing)
    route(/\/api\/v1\/mobile\/location\/analytics\/tracks/, failing)
    route(/\/api\/v1\/mobile\/summary/, failing)

    renderToday()
    await flush()
    await advance(2_000)

    const reports = pageReports(native)
    expect(reports.length).toBeGreaterThan(0)
    const report = reports[reports.length - 1]!.report as Record<string, unknown> | undefined
    expect(report, '上报必须是 v1 信封 {version,id,type:page.report,report:{...}}').toBeDefined()
    expect(report!.hasServerData).toBeNull()
    expect(report!.generatedAt, '没有成功查询时 generatedAt 必须为 null').toBeNull()
    expect(String(report!.error ?? '').length).toBeGreaterThan(0)
  })

  it('W4d 混合计数（pointCount 非 0、totalForegroundSeconds 为 0）仍上报 hasServerData:true', async () => {
    // 规格 §8.4「其他 → true」：只有两个计数**都是数字 0** 才是 false。
    route(/\/api\/v1\/mobile\/location\/analytics\/overview/, () => json(OVERVIEW))
    route(/\/api\/v1\/mobile\/location\/analytics\/tracks/, () => json(TRACKS))
    route(/\/api\/v1\/mobile\/summary/, () => json({ ...USAGE, totalForegroundSeconds: 0 }))

    renderToday()
    await flush()
    await advance(2_000)

    const reports = pageReports(native)
    expect(reports.length).toBeGreaterThan(0)
    const report = reports[reports.length - 1]!.report as Record<string, unknown> | undefined
    expect(
      report!.hasServerData,
      '把非 0 计数也当空数据的实现会被这条判红（review 指定的混合计数故障对照）',
    ).toBe(true)
  })

  it('W5 generatedAt 取今日页三个成功查询里最大的 dataUpdatedAt', async () => {
    const overviewGate = deferred<Response>()
    const tracksGate = deferred<Response>()
    const usageGate = deferred<Response>()
    route(/\/api\/v1\/mobile\/location\/analytics\/overview/, () => overviewGate.promise)
    route(/\/api\/v1\/mobile\/location\/analytics\/tracks/, () => tracksGate.promise)
    route(/\/api\/v1\/mobile\/summary/, () => usageGate.promise)

    renderToday()
    await flush()

    await advance(1_000)
    overviewGate.resolve(json(OVERVIEW))
    await flush()

    await advance(1_000)
    tracksGate.resolve(json(TRACKS))
    await flush()

    await advance(1_000)
    usageGate.resolve(json(USAGE))
    await flush()
    /*
     * 测试时序（不改任何期望）：React Query 解析后的那次渲染/副作用在假定时器下需要再走一个
     * 定时器 tick 才会 flush；原用例在这里直接读 `native.messages()`，于是永远看不到上报。
     */
    await advance(1_000)

    const reports = pageReports(native)
    expect(reports.length).toBeGreaterThan(0)
    const report = reports[reports.length - 1]!.report as Record<string, unknown> | undefined
    expect(report, '上报必须是 v1 信封 {version,id,type:page.report,report:{...}}').toBeDefined()
    expect(report!.hasServerData).toBe(true)
    expect(report!.generatedAt).toBe(new Date(BASE_MILLIS + 3_000).toISOString())
  })

  it('W6 batteryOptimized 只有严格 true 才出现电池文案，缺失不出现', async () => {
    const container = renderToday()
    await flush()

    native.reply({
      version: 1,
      id: stateRequestId(native.messages()),
      ok: true,
      nativeState: { collectionMode: true },
    })
    await flush()
    await advance(6_000)
    expect(textOf(container)).toContain('持续采集中')
    expect(textOf(container)).not.toContain('电池优化')

    /*
     * 只推进到「30 秒轮询刚好触发」那一刻：`advance(30_000)` 会一并跨过第二个请求自己的
     * 5 秒桥超时，随后的手工 v1 回复必然落在超时之后被丢掉。这是测试时序问题（假定时器
     * 把新请求的超时一并快进），不是产品行为；期望与断言一字未改。
     */
    await advance(24_000)
    const secondId = stateRequestId(native.messages())
    native.reply({
      version: 1,
      id: secondId,
      ok: true,
      nativeState: { collectionMode: true, batteryOptimized: true },
    })
    await flush()
    await advance(1_000)

    expect(textOf(container)).toContain('电池优化可能影响采集')
  })

  it('W8 ok:false 不映射成采集状态，保持「原生未返回采集状态」', async () => {
    const container = renderToday()
    await flush()

    native.reply({
      version: 1,
      id: stateRequestId(native.messages()),
      ok: false,
      errorCode: 'native_state_unavailable',
    })
    await flush()
    await advance(6_000)

    const text = textOf(container)
    expect(text).toContain('原生未返回采集状态')
    expect(text).not.toContain('采集已中断')
  })

  it('W9 同时存在 Capacitor 与 pimAndroid 时只用 Capacitor，且不把合成桥写回全局', async () => {
    installCapacitor(capacitor)

    renderToday()
    await flush()

    const capacitorMessage = capacitor.messages().find((m) => m.type === 'native.state.request')
    expect(capacitorMessage, '两者同时存在时消息必须进 Capacitor').toBeDefined()
    expect(native.posts(), '两者同时存在时不得走 pimAndroid').toEqual([])
    expect((globalThis as { pimAndroid?: unknown }).pimAndroid).toBe(native)
    // 规格 §8.1：Capacitor 走旧信封 {type, requestId, payload}，回复仍走 __pimBridgeReceive
    expect(capacitorMessage!.type).toBe('native.state.request')
    expect(typeof capacitorMessage!.requestId).toBe('string')
  })
})

/* ── 守护与控制组 ───────────────────────────────────────────── */

describe('PW-07a 守护与控制组（实现前后都应绿）', () => {
  it('W9b 只有 Capacitor 时不得把合成桥写回 globalThis.pimAndroid', async () => {
    installNative(null)
    installCapacitor(capacitor)

    renderToday()
    await flush()

    expect(capacitor.messages().length).toBeGreaterThan(0)
    expect(
      (globalThis as { pimAndroid?: unknown }).pimAndroid,
      '规格 §8.1：不把合成对象写进 globalThis.pimAndroid',
    ).toBeUndefined()
  })

  it('W10 通道每次发送现判：晚到的桥也必须被用上（不在模块加载时缓存）', async () => {
    installNative(null)
    installCapacitor(null)
    installDefaultRoutes()

    renderToday()
    await flush()
    expect(native.posts()).toEqual([])

    installNative(native)
    await advance(30_000)

    const requests = native.messages().filter((m) => m.type === 'native.state.request')
    expect(requests.length).toBeGreaterThan(0)
  })

  it('W7 轨迹页渲染状态卡且不发送 page.report', async () => {
    installDefaultRoutes()

    const container = renderTracks()
    await flush()
    await advance(1_000)

    expect(textOf(container)).toContain('采集状态')
    expect(native.messages().filter((m) => m.type === 'page.report')).toEqual([])
  })

  it('G1 未识别的原生状态字段不会把 canary 扩散到请求、DOM、storage、后续桥消息或 console', async () => {
    installDefaultRoutes()
    const consoleSpies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
    ]

    const today = renderToday()
    const tracks = renderTracks()
    await flush()
    await advance(2_000)
    native.reply({
      version: 1,
      id: stateRequestId(native.messages()),
      ok: true,
      /*
       * 规格 §8.3 要求 `triggerReason` 原样显示（missing/null 显示破折号）。把令牌 canary 放进
       * `triggerReason` 会让页面**合法**把它渲染到 DOM，`visible` 里的 innerHTML 必然命中 canary。
       * 因此 canary 改放进原生 v1 不认识的字段。这条用例只证明未知入站字段不向后扩散；
       * 它不把「入站桥消息本身没有令牌」算作已验证，原生生产者仍由 Android 测试单独约束。
       */
      nativeState: { collectionMode: true, triggerReason: 'schedule', pending: 1, pageToken: CANARY },
    })
    await flush()

    // 先证明流程真的跑过（否则“没有 canary”是空断言）
    expect(calls.filter((c) => c.url.includes('/api/v1/')).length).toBe(5)
    for (const call of calls) {
      expect(headerOf(call, 'authorization')).toBeUndefined()
    }

    const visible = [
      today.innerHTML,
      tracks.innerHTML,
      JSON.stringify(calls),
      native.posts().join('\n'),
      storageValues().join('\n'),
      consoleSpies.map((spy) => JSON.stringify(spy.mock.calls)).join('\n'),
    ].join('\n')
    expect(visible).not.toContain(CANARY)
    consoleSpies.forEach((spy) => spy.mockRestore())
  })

  it('G2 完整流程里没有 token.request / token.refresh', async () => {
    installDefaultRoutes()

    renderToday()
    renderTracks()
    await flush()
    await advance(2_000)

    const posted = native.posts().join('\n')
    expect(posted).not.toContain('token.request')
    expect(posted).not.toContain('token.refresh')
  })

  it('G2b bridge.ts 不再导出 requestNativeToken（单独不算有效 RED，与 W1/B1 同批）', () => {
    expect(Object.keys(bridgeModule)).not.toContain('requestNativeToken')
  })

  it('G2c client.ts 没有 token provider 接缝', () => {
    const source = readFileSync(path.resolve(import.meta.dirname, '../src/api/client.ts'), 'utf8')
    expect(source).not.toMatch(/pimAndroid|requestNativeToken|nativeTokenProvider/)
  })

  it('G3 源码（与已构建产物）不注册 Service Worker', () => {
    const root = path.resolve(import.meta.dirname, '..')
    const scan = (dir: string): string[] => {
      if (!existsSync(dir)) return []
      return readdirSync(dir).flatMap((entry) => {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) return scan(full)
        if (!/\.(ts|tsx|js|jsx|html|mjs)$/.test(entry)) return []
        return /navigator\.serviceWorker|serviceWorker\.register/.test(readFileSync(full, 'utf8'))
          ? [path.relative(root, full)]
          : []
      })
    }

    expect(scan(path.join(root, 'src'))).toEqual([])
    const indexHtml = readFileSync(path.join(root, 'index.html'), 'utf8')
    expect(/navigator\.serviceWorker|serviceWorker\.register/.test(indexHtml)).toBe(false)
    const dist = path.join(root, 'dist')
    if (existsSync(dist)) {
      expect(scan(dist)).toEqual([])
    }
  })

  it('C1 无桥但 localStorage 有令牌时，5 条 GET 仍带浏览器 Bearer（证明 client.ts 未被改）', async () => {
    installNative(null)
    installCapacitor(null)
    setTokens(BROWSER_TOKEN, `${BROWSER_TOKEN}-refresh`)
    installDefaultRoutes()

    renderToday()
    renderTracks()
    await flush()
    await advance(2_000)

    const apiCalls = calls.filter((c) => c.url.includes('/api/v1/'))
    expect(apiCalls.length).toBe(5)
    for (const call of apiCalls) {
      expect(headerOf(call, 'authorization')).toBe(`Bearer ${BROWSER_TOKEN}`)
    }
    const paths = apiCalls.map((c) => new URL(c.url).pathname).sort()
    expect(paths).toEqual([
      '/api/v1/mobile/location/analytics/overview',
      '/api/v1/mobile/location/analytics/overview',
      '/api/v1/mobile/location/analytics/tracks',
      '/api/v1/mobile/location/analytics/tracks',
      '/api/v1/mobile/summary',
    ])
  })

  it('C2 只有 Capacitor 时旧 __pimBridgeReceive 信封仍能驱动状态卡', async () => {
    installNative(null)
    installCapacitor(capacitor)

    const container = renderToday()
    await flush()

    const id = stateRequestId(capacitor.messages())
    expect(typeof id).toBe('string')
    const receive = (globalThis as { __pimBridgeReceive?: (raw: string) => void }).__pimBridgeReceive
    expect(typeof receive).toBe('function')
    act(() => {
      receive!(
        JSON.stringify({
          requestId: id,
          payload: {
            continuousCollection: true,
            triggerReason: 'schedule',
            nextLocationAt: null,
            pendingUpload: 3,
            batteryOptimized: false,
          },
        }),
      )
    })
    await flush()

    const text = textOf(container)
    expect(text).toContain('持续采集中')
    expect(text).toContain('schedule')
    expect(text).toContain('待上传 3')
  })

  it('C3 无桥时不发消息并显示预览模式', async () => {
    installNative(null)
    installCapacitor(null)

    const container = renderToday()
    await flush()
    await advance(2_000)

    expect(textOf(container)).toContain('预览模式')
    expect(native.posts()).toEqual([])
    expect(capacitor.raw).toEqual([])
  })

  it('C4 记录当前 client.ts 的 429 行为（不锁定重试次数，只证明 429 未被吞掉）', async () => {
    let attempts = 0
    route(/\/api\/v1\/mobile\/summary/, () => {
      attempts += 1
      return new Response(JSON.stringify({ code: 429, message: '限流' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json', 'Retry-After': '900' },
      })
    })

    const { apiGet } = await import('@/api/client')
    const outcome = apiGet('/api/v1/mobile/summary?date=2026-10-11').then(
      () => 'resolved' as const,
      (error: { status?: number }) => error.status ?? 'threw',
    )
    await flush()
    await advance(6_000)
    const result = await outcome

    // HEAD 的 client.ts 等待 Retry-After 截断值后重试一次；另一分支不重试。两者都必须看到 429。
    expect(attempts).toBeGreaterThanOrEqual(1)
    expect(result).toBe(429)
  })
})
