// @vitest-environment jsdom
/*
 * 请求边界：真实序列化请求体 ↔ 会**展开 $ref** 的契约 schema 校验。
 *
 * 这是对自写 AST 判定的补齐，不是第二套 AST：
 *   - AST（contract-conformance.test.ts）看 method/path/顶层字段/query；
 *   - 这里把**真实用户动作发出的请求体**（经过 apiPost/apiFetch 的 JSON.stringify）
 *     交给 `_lib/request-schema.ts` 的 OpenAPI 校验，覆盖 AST 看不见的：
 *     `$ref`（EventPersonDto / DaemonSourceState…）、嵌套对象、数组元素、
 *     非 nullable 的 null、required。
 *
 * 判定口径：**不要求属性集合全等**——可选字段省略必须通过；只拒「契约外字段 /
 * 类型不符 / 枚举不符 / 缺 required / 非 nullable 的 null」。
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

import { EventEditorDialog } from '@/features/calendar/components/event-editor-dialog'
import { AppKnowledgeBasePage } from '@/features/knowledge/pages/app-knowledge-page'
import { apiPost, clearTokens } from '@/api/client'
import { setApiBase } from '@/lib/apiBase'
import type { CalendarBook, EventResponse } from '@/features/calendar/types'
import { loadContract, resolveOperation, splitQuery, type ContractRaw } from './_lib/contract'
import { validateOperationBody, type SchemaProblem } from './_lib/request-schema'

const API_BASE = 'http://192.0.2.10:5858'
const raw = loadContract().raw as ContractRaw

interface RecordedCall {
  url: string
  method: string
  body: unknown
}

let calls: RecordedCall[] = []

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: 'ok', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

const APP_ROW = {
  id: 'a1',
  processName: 'code',
  displayName: 'VS Code',
  categoryPath: '开发工具',
  productivity: 'productive',
  icon: '🧪',
  source: 'learned',
}

beforeEach(() => {
  clearTokens()
  setApiBase(API_BASE)
  calls = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      })
      if (String(input).includes('/api/v1/pc/app-knowledge/apps')) return envelope([APP_ROW])
      return envelope({ id: 'ev-1' })
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setApiBase('')
  clearTokens()
})

/**
 * 把真实抓到的请求（具体路径，如 /api/v1/calendar/events/ev-1）换算成契约
 * operation 的 canonical path：按段匹配，`{param}` 段接受任意非空真实段。
 */
function canonicalPath(call: RecordedCall): string | null {
  const rel = call.url.startsWith(API_BASE) ? call.url.slice(API_BASE.length) : call.url
  const { path } = splitQuery(rel)
  // 先试模板解析（调用点里就是模板字面量的情况）
  const resolved = resolveOperation(call.method, path)
  if (resolved.kind !== 'absent' && resolved.operation) return resolved.operation.path

  const wanted = call.method.toUpperCase()
  const actualSegments = path.replace(/\/+$/, '').split('/')
  for (const operation of loadContract().operations.values()) {
    if (operation.method.toUpperCase() !== wanted) continue
    const tplSegments = operation.path.replace(/\/+$/, '').split('/')
    if (tplSegments.length !== actualSegments.length) continue
    const matches = tplSegments.every((seg, i) =>
      /^\{[^}]+\}$/.test(seg) ? actualSegments[i]!.length > 0 : seg === actualSegments[i],
    )
    if (matches) return operation.path
  }
  return null
}

function validate(call: RecordedCall): SchemaProblem[] {
  const path = canonicalPath(call)
  if (!path) return [{ path: '$', message: `抓到的请求 ${call.method} ${call.url} 不在契约里` }]
  return validateOperationBody(raw, call.method, path, call.body)
}

function format(problems: SchemaProblem[]): string {
  return problems.map((p) => `${p.path}: ${p.message}`).join('\n')
}

/** 走产品真实的 apiPost（真 JSON.stringify）拿序列化后的请求体 */
async function serialized(path: string, body: unknown): Promise<RecordedCall> {
  await apiPost(path, body)
  const call = calls.at(-1)!
  expect(call.method, 'apiPost 必须是 POST').toBe('POST')
  return call
}

/* ── 真实组件入口：用户动作 → 请求体 ─────────────────────── */

const CALENDARS = [
  { id: 'cal-1', name: '工作', kind: 'calendar', color: '#3B82F6', canEdit: true, isDefault: true },
] as unknown as CalendarBook[]

const WIRE_EVENT = {
  id: 'ev-1',
  calendarId: 'cal-1',
  uid: 'uid-1',
  title: '审计事件',
  description: '描述',
  location: '会议室',
  dtStart: '2026-10-11T01:00:00Z',
  dtEnd: '2026-10-11T02:00:00Z',
  rRule: 'FREQ=DAILY',
  status: 'Confirmed',
  source: 'local',
  originalEventId: null,
  isAllDay: false,
  timeZoneId: null,
  sourceTimeZoneId: null,
  sourceUid: null,
  recurrenceId: null,
  descriptionFormat: null,
  showAs: 'busy',
  importance: 'normal',
  sensitivity: 'normal',
  categories: ['工作'],
  isReminderOn: false,
  reminderMinutesBeforeStart: null,
  organizer: { name: '张三', email: 'z@pim.local' },
  attendees: [{ name: '李四', email: 'l@pim.local', type: 'required' }],
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
} as unknown as EventResponse

describe('真实组件发出的请求体必须通过 $ref 展开后的契约校验', () => {
  it('日程编辑弹窗保存：抓到的请求体必须是合法的 Update/CreateEventRequest', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={qc}>
        <EventEditorDialog open onOpenChange={() => {}} calendars={CALENDARS} event={WIRE_EVENT} />
      </QueryClientProvider>,
    )
    await screen.findByRole('button', { name: /保存/ })
    await user.click(screen.getByRole('button', { name: /^保存/ }))
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/api/v1/calendar/events'))).toBe(true),
    )
    const call = calls.find((c) => c.url.includes('/api/v1/calendar/events'))!
    expect(format(validate(call)), '真实保存请求体与契约不一致').toBe('')
  })
})

describe('真实组件发出的请求体（应用签名）不得带契约外字段', () => {
  it('添加应用保存：请求体必须是合法的 SaveAppSignatureRequest', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const user = userEvent.setup()
    render(
      <QueryClientProvider client={qc}>
        <MemoryRouter>
          <AppKnowledgeBasePage />
        </MemoryRouter>
      </QueryClientProvider>,
    )
    await screen.findByText('VS Code')
    await user.click(screen.getByRole('button', { name: /添加应用/ }))
    const label = (t: string) =>
      [...document.querySelectorAll('label')].find((l) => l.textContent?.trim() === t)
    const input = (t: string) => label(t)?.parentElement?.querySelector('input') as HTMLInputElement
    await user.type(input('进程名'), 'audit-proc')
    await user.type(input('显示名'), '审计应用')
    await user.click(screen.getByRole('button', { name: /^保存$/ }))
    await waitFor(() =>
      expect(calls.some((c) => c.url.includes('/api/v1/pc/app-signatures'))).toBe(true),
    )
    const call = calls.find((c) => c.url.includes('/api/v1/pc/app-signatures'))!
    expect(format(validate(call)), '真实保存请求体与契约不一致').toBe('')
  })
})

/* ── 故障对照：校验器必须真的会拒 ─────────────────────────── */

describe('故障对照：$ref / 嵌套 / null / required / enum 必须能被拒', () => {
  it('$ref 目标里的嵌套契约外字段（organizer.evil）必须被拒', async () => {
    const call = await serialized('/api/v1/calendar/events', {
      title: 'x',
      organizer: { name: '张三', evil: 1 },
    })
    const problems = validate(call)
    expect(
      format(problems),
      'EventPersonDto 是 $ref（additionalProperties:false），嵌套的多余字段必须被发现',
    ).toMatch(/organizer\.evil/)
  })

  it('数组元素里的嵌套契约外字段（attendees[0].evil）必须被拒', async () => {
    const call = await serialized('/api/v1/calendar/events', {
      title: 'x',
      attendees: [{ name: '李四', evil: 1 }],
    })
    expect(format(validate(call))).toMatch(/attendees\[0\]\.evil/)
  })

  it('非 nullable 的 null（SiteImportRequest.content = null）必须被拒，且缺 required 也要被拒', async () => {
    const nullCall = await serialized('/api/v1/pc/browser-tt/import', { content: null })
    expect(format(validate(nullCall)), 'content 是 required 且非 nullable 的 string').toMatch(
      /content.*null/,
    )
    const missing = await serialized('/api/v1/pc/browser-tt/import', { mode: 'add' })
    expect(format(validate(missing)), '缺 required 字段 content').toMatch(/content/)
  })

  it('经 $ref 引用的 enum（DaemonSourceState）非法值必须被拒，合法值必须通过', async () => {
    // 契约有该 enum，但 Web 没有 POST /daemon/heartbeat 的生产调用——这里只校验判定器，
    // 不为这条新增任何心跳客户端功能。
    const bad = await serialized('/api/v1/daemon/heartbeat', {
      activityWatchState: 'Bogus',
      deviceId: 'd-1',
    })
    expect(format(validate(bad)), '$ref 指向的 enum 非法值必须被拒').toMatch(/activityWatchState/)
    const ok = await serialized('/api/v1/daemon/heartbeat', {
      activityWatchState: 'Available',
      keyStatsState: 'Paused',
      deviceId: 'd-1',
      collectionPaused: false,
    })
    expect(format(validate(ok)), '合法枚举值不得被误报').toBe('')
  })

  it('反向对照：可选字段省略必须通过（不得要求属性集合全等）', async () => {
    const call = await serialized('/api/v1/calendar/calendars', { name: 'x' })
    expect(format(validate(call)), '可选字段省略被误报：判定过严').toBe('')
  })

  it('反向对照：干净的合法请求体不得被误报为违规', async () => {
    const call = await serialized('/api/v1/pc/browser-tt/import', {
      content: '{"a":1}',
      mode: 'replace',
    })
    expect(format(validate(call))).toBe('')
  })
})
