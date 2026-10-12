// @vitest-environment jsdom
/*
 * PW-05 / I-1：日程重复规则（`rRule`）的读写。
 *
 * 权威依据（只读 pim-api 源码 + .NET 默认命名策略，见 requirements.md §4）：
 * 契约字段名是 `rRule`；客户端 `features/calendar/types.ts` 声明的是 `rrule`。
 * 因此在「响应 JSON 只有 rRule」这个前提下，编辑器回填与列表「重复」标记都会丢。
 *
 * 本文件覆盖三条真实用户可见行为（组件/真实函数入口，不是字符串镜像）：
 *   1. 响应只有 `rRule`（线上形状）时，编辑器的「重复」必须回填出来；
 *   2. 响应只有旧写法 `rrule` 时也不能丢（兼容旧数据形状）；
 *   3. 保存请求体里的键必须是契约的 `rRule`。
 *
 * ⚠️ 真实 `GET /calendar/events` 的 HTTP 正文本轮**未测**，保持 NOT-VERIFIED：
 * 这里证明的是「给定该 JSON 形状时的客户端行为」，不是已部署服务端的实际响应。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'

vi.mock('@/lib/notify', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  shouldMuteError: () => false,
}))

import { EventEditorDialog } from '@/features/calendar/components/event-editor-dialog'
import { buildEventListSections } from '@/features/calendar/components/event-list-model'
import type { CalendarBook, EventResponse } from '@/features/calendar/types'
import { setApiBase } from '@/lib/apiBase'
import { clearTokens } from '@/api/client'

const CALENDARS = [
  { id: 'cal-1', name: '工作', kind: 'calendar', color: '#3B82F6', canEdit: true, isDefault: true },
] as unknown as CalendarBook[]

const BASE_EVENT = {
  id: 'ev-1',
  calendarId: 'cal-1',
  uid: 'uid-1',
  title: '审计事件',
  description: null,
  location: null,
  dtStart: '2026-10-11T01:00:00Z',
  dtEnd: '2026-10-11T02:00:00Z',
  status: 'Confirmed',
  source: 'local',
  originalEventId: null,
  isAllDay: false,
  timeZoneId: null,
  sourceTimeZoneId: null,
  sourceUid: null,
  recurrenceId: null,
  descriptionFormat: null,
  showAs: null,
  importance: null,
  sensitivity: null,
  categories: null,
  isReminderOn: false,
  reminderMinutesBeforeStart: null,
  organizer: null,
  attendees: null,
  isOnlineMeeting: false,
  onlineMeetingProvider: null,
  onlineMeetingUrl: null,
  externalLink: null,
  isSeriesMaster: false,
  isException: false,
  seriesMasterId: null,
  isCancelled: false,
  outlookCalendarBindingId: null,
  outlookEventId: null,
  outlookEtag: null,
  outlookEventType: null,
}

/** 线上形状：契约字段名是 `rRule`（TS 接口写的是 rrule，所以这里显式断言成线上 JSON） */
function wireEvent(over: Record<string, unknown>): EventResponse {
  return { ...BASE_EVENT, ...over } as unknown as EventResponse
}

let calls: { url: string; method: string; body: unknown }[] = []

beforeEach(() => {
  clearTokens()
  setApiBase('http://192.0.2.10:5858')
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      })
      return new Response(JSON.stringify({ code: 0, message: 'ok', data: { id: 'ev-1' } }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setApiBase('')
  clearTokens()
})

function renderEditor(event: EventResponse) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <EventEditorDialog open onOpenChange={() => {}} calendars={CALENDARS} event={event} />
    </QueryClientProvider>,
  )
}

function rruleTrigger(): HTMLElement {
  const el = document.getElementById('event-rrule')
  if (!el) throw new Error('找不到「重复」选择器（event-rrule）')
  return el
}

describe('I-1 编辑器回填：重复规则必须按契约字段名读出来', () => {
  it('响应只有 rRule（线上形状）时，「重复」必须显示为每天', async () => {
    renderEditor(wireEvent({ rRule: 'FREQ=DAILY' }))
    await waitFor(() => expect(rruleTrigger()).toBeTruthy())
    expect(
      rruleTrigger().textContent,
      '响应 JSON 用的是契约字段 rRule，编辑器读的是 rrule，重复规则被读成空',
    ).toContain('每天')
  })

  it('反向对照：响应只有旧写法 rrule 时也不能丢（兼容旧数据形状）', async () => {
    renderEditor(wireEvent({ rrule: 'FREQ=WEEKLY' }))
    await waitFor(() => expect(rruleTrigger()).toBeTruthy())
    expect(rruleTrigger().textContent).toContain('每周')
  })
})

describe('I-1 列表标记：重复事件必须被标成 repeated', () => {
  it('响应只有 rRule 时，列表行必须标记为重复', () => {
    const sections = buildEventListSections([wireEvent({ rRule: 'FREQ=DAILY' })], [])
    const row = sections.flatMap((s) => s.items).find((r) => r.kind === 'event')
    expect(row?.repeated, '只有 rRule 的响应没有把事件标成重复').toBe(true)
  })

  it('反向对照：只有旧写法 rrule 时同样标记为重复', () => {
    const sections = buildEventListSections([wireEvent({ rrule: 'FREQ=DAILY' })], [])
    const row = sections.flatMap((s) => s.items).find((r) => r.kind === 'event')
    expect(row?.repeated).toBe(true)
  })

  it('没有重复规则的事件不得被误标', () => {
    const sections = buildEventListSections([wireEvent({})], [])
    const row = sections.flatMap((s) => s.items).find((r) => r.kind === 'event')
    expect(row?.repeated).toBe(false)
  })
})

describe('I-1 保存：请求体必须用契约字段名 rRule', () => {
  it('保存请求体的键是 rRule（不是 rrule）', async () => {
    const user = userEvent.setup()
    renderEditor(wireEvent({ rrule: 'FREQ=DAILY' }))
    await screen.findByRole('button', { name: /保存/ })
    await user.click(screen.getByRole('button', { name: /^保存/ }))
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/v1/calendar/events'))).toBe(true))
    const body = calls.find((c) => c.url.includes('/api/v1/calendar/events'))!.body as Record<
      string,
      unknown
    >
    expect(Object.keys(body)).toContain('rRule')
    expect(
      Object.keys(body),
      '保存请求体仍然发送小写 rrule：服务端虽然大小写不敏感，但客户端门禁与契约字段名不一致',
    ).not.toContain('rrule')
  })

  it('反向对照：不清空已有的重复规则（保存体里的值就是当前规则）', async () => {
    const user = userEvent.setup()
    renderEditor(wireEvent({ rrule: 'FREQ=DAILY' }))
    await screen.findByRole('button', { name: /保存/ })
    await user.click(screen.getByRole('button', { name: /^保存/ }))
    await waitFor(() => expect(calls.length).toBeGreaterThan(0))
    const body = calls.find((c) => c.url.includes('/api/v1/calendar/events'))!.body as Record<
      string,
      unknown
    >
    /*
     * 这里**不允许**再写 `expect(['FREQ=DAILY', undefined]).toContain(...)`：
     * 坏实现的 body.rRule 恰好是 undefined，那种断言在缺陷存在时也是绿的。
     */
    expect(body['rRule'], '保存体没有把当前重复规则写成 FREQ=DAILY').toBe('FREQ=DAILY')
  })

  it('线上形状（只有 rRule）回填后保存，保存体的值仍是 FREQ=DAILY', async () => {
    const user = userEvent.setup()
    renderEditor(wireEvent({ rRule: 'FREQ=DAILY' }))
    await screen.findByRole('button', { name: /保存/ })
    await user.click(screen.getByRole('button', { name: /^保存/ }))
    await waitFor(() => expect(calls.some((c) => c.url.includes('/api/v1/calendar/events'))).toBe(true))
    const body = calls.find((c) => c.url.includes('/api/v1/calendar/events'))!.body as Record<
      string,
      unknown
    >
    expect(body['rRule']).toBe('FREQ=DAILY')
  })
})
