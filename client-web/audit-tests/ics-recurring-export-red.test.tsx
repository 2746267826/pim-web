// @vitest-environment jsdom
/*
 * 独立 RED · PW-08 用户流程：日程数据管理页「导出选中」对**重复事件 occurrence 行**
 *
 * 依据（真实链路实测，见 `remediation/reviews/ics-recurring-export-red-deepseek.md` §3）：
 *   1) `GET /api/v1/calendar/events` 返回的是**展开后的 occurrence**：
 *      `id` 是服务端派生的合成 id（MD5(masterId|occurrenceStart)），**不是**库中 `events.id`；
 *      occurrence 行另带 `originalEventId` / `seriesMasterId` = 库中主存储事件 id。
 *   2) `GET /api/v1/calendar/export-ics?ids=…` 按**存储事件 id**（`events.id`）过滤：
 *      传库中 id → 1 个 VEVENT（含 UID 与 RRULE）；传 occurrence 合成 id → HTTP 200 但 **0 个 VEVENT** 的 195 B 空日历。
 *   3) 页面 `exportIcs()` 只判 `blob.size === 0`，而空日历不是 0 字节 → 假成功「ICS 已导出」。
 *
 * 因此页面的两个目标行为（本文件即它们的有效 RED）：
 *   · 选中重复事件的 occurrence 行导出时，必须把该行的 `originalEventId`（库中主事件 id）交给导出端点，
 *     从而导出可重导入的系列记录（含 UID / RRULE）——与「选中普通事件导出该事件记录」一致；
 *   · 服务端返回**没有任何 VEVENT** 的日历（命中 0 条）时不得提示导出成功
 *     ——这是既有明确语义（现有代码已有 `blob.size === 0 → 抛「导出内容为空」`）。
 *
 * ⚠️ 证据等级：组件 + mock fetch（此处 mock **忠实复刻真实端点语义**，由上面第 1/2 条实测确定），
 *    不是真实后端往返；真实后端往返由 browser RED 单独覆盖。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

vi.mock('@/lib/notify', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  shouldMuteError: () => false,
}))

import { notifyError, notifySuccess } from '@/lib/notify'
import { CalendarDataManagerPage } from '@/features/settings/pages/settings-pages'
import { setApiBase } from '@/lib/apiBase'
import { clearTokens } from '@/api/client'

const API_BASE = 'http://192.0.2.10:5858'

/* ── 忠实复刻真实后端语义所需的最小事实 ─────────────────────── */

/** 库中主存储事件（普通） */
const PLAIN = {
  id: '11111111-1111-4111-8111-111111111111',
  uid: 'plain-uid@pim',
  title: 'DS-RED 普通事件',
}
/** 库中主存储事件（每周重复）；列表返回的 occurrence 行 id 与它不同 */
const SERIES = {
  id: '22222222-2222-4222-8222-222222222222',
  uid: 'series-uid@pim',
  title: 'DS-RED 重复事件',
  rRule: 'FREQ=WEEKLY',
}
/** 服务端派生的 occurrence 合成 id：**不在** events 表里 */
const OCCURRENCE_ID = '33333333-3333-4333-8333-333333333333'

/** 与真实 `IcsService` 对空集合的输出同形（VCALENDAR + VTIMEZONE，无 VEVENT） */
const EMPTY_CALENDAR =
  'BEGIN:VCALENDAR\r\nPRODID:-//github.com/ical-org/ical.net//NONSGML ical.net 5.2.2//EN\r\nVERSION:2.0\r\n' +
  'BEGIN:VTIMEZONE\r\nTZID:Asia/Shanghai\r\nX-LIC-LOCATION:Asia/Shanghai\r\nEND:VTIMEZONE\r\nEND:VCALENDAR\r\n'

function eventIcs(uid: string, title: string, rrule?: string): string {
  return [
    'BEGIN:VCALENDAR',
    'PRODID:-//github.com/ical-org/ical.net//NONSGML ical.net 5.2.2//EN',
    'VERSION:2.0',
    'BEGIN:VTIMEZONE',
    'TZID:Asia/Shanghai',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    'DTSTART:20261005T050000Z',
    'DTEND:20261005T060000Z',
    `SUMMARY:${title}`,
    `UID:${uid}`,
    ...(rrule ? [`RRULE:${rrule}`] : []),
    'END:VEVENT',
    'END:VCALENDAR',
    '',
  ].join('\r\n')
}

/** 列表行：普通事件 + 一条重复事件的 occurrence 行（字段名与真实响应一致） */
function listEnvelope() {
  return envelope({
    items: [
      {
        id: PLAIN.id,
        calendarId: 'cal-1',
        uid: PLAIN.uid,
        title: PLAIN.title,
        dtStart: '2026-10-05T05:00:00+00:00',
        dtEnd: '2026-10-05T06:00:00+00:00',
        rRule: null,
        isCancelled: false,
        originalEventId: PLAIN.id,
      },
      {
        // occurrence 行：id 是合成 id，originalEventId / seriesMasterId 才是库里那一行
        id: OCCURRENCE_ID,
        calendarId: 'cal-1',
        uid: SERIES.uid,
        title: SERIES.title,
        dtStart: '2026-10-05T05:00:00+00:00',
        dtEnd: '2026-10-05T06:00:00+00:00',
        rRule: SERIES.rRule,
        isCancelled: false,
        recurrenceId: '2026-10-05T05:00:00.0000000+00:00',
        originalEventId: SERIES.id,
        seriesMasterId: SERIES.id,
      },
    ],
    totalCount: 2,
    totalPages: 1,
  })
}

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: status === 200 ? 0 : 50001, message: 'x', data }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface Harness {
  calls: { url: string; method: string }[]
  /** 覆盖导出端点行为；默认按真实语义：命中库中 id → 有 VEVENT；否则 → 空日历 */
  exportOverride?: () => Response
  /** 覆盖列表 items（用于「同一系列的两条 occurrence」这类形状） */
  listItems?: unknown[]
}

function exportIds(url: string): string[] {
  const ids = new URL(url).searchParams.get('ids')
  return ids ? ids.split(',') : []
}

function installFetch(h: Harness): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      h.calls.push({ url, method: init?.method ?? 'GET' })
      if (url.includes('/api/v1/auth/refresh')) {
        return envelope({ accessToken: 'new-access', refreshToken: 'refresh-2' })
      }
      if (url.includes('/api/v1/calendar/export-ics')) {
        if (h.exportOverride) return h.exportOverride()
        // —— 复刻真实端点：按存储事件 id 过滤
        const ids = exportIds(url)
        if (ids.includes(PLAIN.id)) {
          return new Response(eventIcs(PLAIN.uid, PLAIN.title), { status: 200, headers: { 'content-type': 'text/calendar' } })
        }
        if (ids.includes(SERIES.id)) {
          return new Response(eventIcs(SERIES.uid, SERIES.title, SERIES.rRule), { status: 200, headers: { 'content-type': 'text/calendar' } })
        }
        return new Response(EMPTY_CALENDAR, { status: 200, headers: { 'content-type': 'text/calendar' } })
      }
      if (url.includes('/api/v1/calendar/calendars')) return envelope([{ id: 'cal-1', name: '日历', color: '#000', kind: 'calendar' }])
      if (url.includes('/api/v1/calendar/events')) {
        if (h.listItems) {
          return envelope({ items: h.listItems, totalCount: h.listItems.length, totalPages: 1 })
        }
        return listEnvelope()
      }
      return envelope(null)
    }),
  )
}

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <CalendarDataManagerPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

let harness: Harness
let exportedBlobs: Blob[] = []
const realCreateObjectURL = URL.createObjectURL
const realRevokeObjectURL = URL.revokeObjectURL

beforeEach(() => {
  clearTokens()
  setApiBase(API_BASE)
  harness = { calls: [] }
  installFetch(harness)
  exportedBlobs = []
  URL.createObjectURL = ((blob: Blob) => {
    exportedBlobs.push(blob)
    return 'blob:red'
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  vi.mocked(notifySuccess).mockClear()
  vi.mocked(notifyError).mockClear()
})

afterEach(() => {
  cleanup()
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
  vi.unstubAllGlobals()
  setApiBase('')
  clearTokens()
})

/** 真实用户动作：等列表渲染 → 勾选标题所在行 → 点「导出选中」→ 接住 download */
async function selectRowAndExport(title: string) {
  const user = userEvent.setup()
  renderPage()
  const checkbox = await screen.findByLabelText(`选择 ${title}`, {}, { timeout: 5000 })
  await user.click(checkbox)
  const btn = await screen.findByRole('button', { name: /导出选中/ })
  await user.click(btn)
  await waitFor(() => expect(harness.calls.some((c) => c.url.includes('export-ics'))).toBe(true))
}

function exportCalls() {
  return harness.calls.filter((c) => c.url.includes('export-ics'))
}

function successText() {
  return vi.mocked(notifySuccess).mock.calls.map((c) => String(c[0])).join('|')
}

describe('前置：列表与行控件真的渲染出来了', () => {
  it('渲染出普通事件与重复事件 occurrence 两行，且各自可勾选', async () => {
    const { container } = renderPage()
    await waitFor(() => {
      expect(container.querySelector(`input[aria-label="选择 ${PLAIN.title}"]`)).not.toBeNull()
      expect(container.querySelector(`input[aria-label="选择 ${SERIES.title}"]`)).not.toBeNull()
    })
  })
})

describe('正控制：普通事件「导出选中」导出它自己的记录（本用例当前应已通过，修完必须仍通过）', () => {
  it('请求 ids = 该事件的存储 id，且下载内容含其 UID / SUMMARY', async () => {
    await selectRowAndExport(PLAIN.title)
    expect(exportIds(exportCalls()[0]!.url)).toEqual([PLAIN.id])
    await waitFor(() => expect(exportedBlobs.length).toBeGreaterThan(0))
    const text = await exportedBlobs[0]!.text()
    expect(text, '正控制：普通事件导出内容必须含该事件 UID').toContain(`UID:${PLAIN.uid}`)
    expect(text).toContain(`SUMMARY:${PLAIN.title}`)
    await waitFor(() => expect(successText()).toMatch(/ICS 已导出/))
  })
})

describe('目标 RED A：重复事件 occurrence 行「导出选中」必须导出对应系列记录', () => {
  it('请求 ids 必须是该行的 originalEventId（库中主事件 id），不是服务端合成的 occurrence id', async () => {
    await selectRowAndExport(SERIES.title)
    const ids = exportIds(exportCalls()[0]!.url)
    expect(
      ids.join(','),
      '页面把展开后的 occurrence 合成 id 直接当导出 id；该 id 在 events 表中不存在，'
        + '真实端点会返回 0 个 VEVENT 的空日历（真实链路实测 b32de2cf… / 库中主事件 84220f6a…）',
    ).toBe(SERIES.id)
  })

  it('下载内容必须含该系列的 UID 与 RRULE（可重导入），而不是空日历', async () => {
    await selectRowAndExport(SERIES.title)
    await waitFor(() => expect(exportedBlobs.length).toBeGreaterThan(0))
    const text = await exportedBlobs[0]!.text()
    expect(text, '选中的是重复事件，导出内容却没有该系列 UID：用户拿到的是空日历').toContain(`UID:${SERIES.uid}`)
    expect(text, '系列记录必须保留重复规则（RRULE）').toContain(`RRULE:${SERIES.rRule}`)
    expect(text, '导出的系列必须带标题').toContain(`SUMMARY:${SERIES.title}`)
  })
})

describe('目标 RED B：服务端命中 0 条（VEVENT=0 的空日历）不得提示导出成功', () => {
  it('空日历 + HTTP 200 时：不弹「ICS 已导出」，且要报错', async () => {
    // 复刻"选中的事件已不存在"——真实端点对 0 命中同样返回 200 + 195 B 空日历
    harness.exportOverride = () =>
      new Response(EMPTY_CALENDAR, { status: 200, headers: { 'content-type': 'text/calendar' } })
    await selectRowAndExport(PLAIN.title)
    await waitFor(() => expect(exportCalls().length).toBeGreaterThan(0))
    await waitFor(() => {
      expect(
        successText(),
        '导出得到 0 个 VEVENT 的空日历（命中 0 条）却提示成功——这是假成功',
      ).not.toMatch(/ICS 已导出/)
    })
    await waitFor(() => expect(vi.mocked(notifyError)).toHaveBeenCalled())
  })

  it('空日历不得被当成可下载文件推给用户（不许把空日历交给 URL.createObjectURL）', async () => {
    harness.exportOverride = () =>
      new Response(EMPTY_CALENDAR, { status: 200, headers: { 'content-type': 'text/calendar' } })
    await selectRowAndExport(PLAIN.title)
    // 等页面给出任一反馈（成功或失败），再断言"没有把空日历当成下载"
    await waitFor(() => {
      expect(
        vi.mocked(notifyError).mock.calls.length + vi.mocked(notifySuccess).mock.calls.length,
      ).toBeGreaterThan(0)
    })
    expect(
      exportedBlobs.length,
      '空日历仍被触发了下载：用户会拿到一个没有任何事件的 .ics 并以为导出成功',
    ).toBe(0)
    expect(successText()).not.toMatch(/ICS 已导出/)
  })
})

/*
 * R7 补强（依据 376 已审范围 §3.1 / §3.3，不含新设计）：
 *   · §3.1：多个 occurrence 落到同一存储 id 时必须去重——否则端点收到重复 id；
 *   · §3.3：未选中任何行时仍走「导出全部」（不传 ids），不得改成忽略选择或永久导出全部。
 * 这两条把实施里 `new Set(...)` 与 `selected.size ? … : undefined` 两处分支钉住。
 */
describe('R7 补强：同一系列多条 occurrence 去重 / 未选中仍导出全部', () => {
  function occurrenceRow(recurrenceId: string, syntheticId: string) {
    return {
      id: syntheticId,
      calendarId: 'cal-1',
      uid: SERIES.uid,
      title: SERIES.title,
      dtStart: recurrenceId,
      dtEnd: recurrenceId,
      rRule: SERIES.rRule,
      isCancelled: false,
      recurrenceId,
      originalEventId: SERIES.id,
      seriesMasterId: SERIES.id,
    }
  }

  it('同一系列的两条 occurrence 都选中时，导出请求里该存储 id 只出现一次', async () => {
    harness.listItems = [
      occurrenceRow('2026-10-05T05:00:00+00:00', 'syn-1'),
      occurrenceRow('2026-10-12T05:00:00+00:00', 'syn-2'),
    ]
    const user = userEvent.setup()
    renderPage()
    const boxes = await screen.findAllByLabelText(`选择 ${SERIES.title}`, {}, { timeout: 5000 })
    expect(boxes, '前置：两条 occurrence 行都要渲染出来').toHaveLength(2)
    await user.click(boxes[0]!)
    await user.click(boxes[1]!)
    await user.click(await screen.findByRole('button', { name: /导出选中/ }))
    await waitFor(() => expect(exportCalls().length).toBeGreaterThan(0))
    expect(
      exportIds(exportCalls()[0]!.url),
      '两条 occurrence 映射到同一存储 id 后必须去重，否则端点收到重复 id',
    ).toEqual([SERIES.id])
  })

  it('未选中任何行时仍走「导出全部」：请求不得带 ids', async () => {
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByRole('button', { name: /导出全部/ }))
    await waitFor(() => expect(exportCalls().length).toBeGreaterThan(0))
    expect(
      exportCalls()[0]!.url,
      '未选中时不应传 ids（仍必须是「导出全部」，不能改成忽略选择）',
    ).not.toContain('ids=')
  })
})
