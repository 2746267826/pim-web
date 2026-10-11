// @vitest-environment jsdom
/*
 * PW-08：日程数据管理页的 ICS 导出/导入必须走统一传输（配置的 apiBase、
 * 401 刷新、非 2xx/解析失败不得提示成功）。
 *
 * 这是**组件级用户动作**测试：真的渲染页面、真的点「导出」/ 真的选文件，
 * 观察页面实际发出的请求与实际的提示。旧版用「源码派生规则 + 封装行为」
 * 两条间接证据，会放过「相对路径 + 无条件成功提示」的错误修法。
 *
 * ⚠️ 证据等级：组件 + mock fetch（证明页面装配与分支），不是真实后端往返。
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
import { clearTokens, setTokens } from '@/api/client'

const API_BASE = 'http://192.0.2.10:5858'

/** 一个「真的含事件」的成功导出结果（0 个 VEVENT 的外壳不再代表成功） */
const OK_ICS =
  'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:audit-ok@pim\r\nSUMMARY:ok\r\n' +
  'DTSTART:20261005T050000Z\r\nDTEND:20261005T060000Z\r\nEND:VEVENT\r\nEND:VCALENDAR\r\n'

function envelope(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ code: status === 200 ? 0 : 50001, message: 'x', data }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface Harness {
  calls: { url: string; method: string; auth: string | null }[]
  exportResponses: (() => Response)[]
  importResponses: (() => Response)[]
}

function installFetch(h: Harness): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      const auth = new Headers(init?.headers).get('authorization')
      h.calls.push({ url, method, auth })
      if (url.includes('/api/v1/auth/refresh')) {
        return envelope({ accessToken: 'new-access', refreshToken: 'refresh-2' })
      }
      if (url.includes('/api/v1/calendar/export-ics')) {
        return (h.exportResponses.shift() ?? (() => new Response('BEGIN:VCALENDAR', { status: 200 })))()
      }
      if (url.includes('/api/v1/calendar/import-ics')) {
        return (h.importResponses.shift() ?? (() => envelope({ imported: 1, skipped: 0 })))()
      }
      if (url.includes('/api/v1/calendar/calendars')) return envelope([])
      if (url.includes('/api/v1/calendar/events')) {
        return envelope({ items: [], totalCount: 0, totalPages: 0 })
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
/** 页面交给 URL.createObjectURL 的 Blob（用来核对用户真正拿到的下载内容） */
let exportedBlobs: Blob[] = []
const realCreateObjectURL = URL.createObjectURL
const realRevokeObjectURL = URL.revokeObjectURL

beforeEach(() => {
  clearTokens()
  setApiBase(API_BASE)
  harness = { calls: [], exportResponses: [], importResponses: [] }
  installFetch(harness)
  exportedBlobs = []
  URL.createObjectURL = ((blob: Blob) => {
    exportedBlobs.push(blob)
    return 'blob:audit'
  }) as typeof URL.createObjectURL
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL
  vi.mocked(notifySuccess).mockClear()
  vi.mocked(notifyError).mockClear()
})

afterEach(() => {
  // vitest 没开 globals，@testing-library/react 不会自动注册 cleanup；
  // 不卸载会让下一次 findByRole 命中多个挂载点。
  cleanup()
  URL.createObjectURL = realCreateObjectURL
  URL.revokeObjectURL = realRevokeObjectURL
  vi.unstubAllGlobals()
  setApiBase('')
  clearTokens()
})

async function clickExport() {
  const user = userEvent.setup()
  renderPage()
  const btn = await screen.findByRole('button', { name: /导出/ })
  await user.click(btn)
}

function exportCalls(): { url: string; auth: string | null }[] {
  return harness.calls.filter((c) => c.url.includes('export-ics'))
}

describe('前置：页面真的渲染出来了，控件可用', () => {
  it('渲染出「导出」「导入 ICS」按钮与文件输入框', async () => {
    const { container } = renderPage()
    expect(await screen.findByRole('button', { name: /导出/ })).toBeTruthy()
    await waitFor(() => {
      expect(container.querySelector('input[type="file"]')).not.toBeNull()
    })
  })
})

describe('PW-08 导出：走统一传输 + 失败不得报成功', () => {
  it('导出请求必须打到配置的 apiBase（不是相对路径直连 WebView origin）', async () => {
    await clickExport()
    await waitFor(() => expect(exportCalls().length).toBeGreaterThan(0))
    const url = exportCalls()[0]!.url
    expect(
      url.startsWith(API_BASE),
      `导出请求打到了 "${url}"：相对路径在原生壳/远端 apiBase 下会打到页面自身 origin`,
    ).toBe(true)
  })

  it('401 时由统一传输刷新一次并重放（页面不得自己拿着旧令牌静默失败）', async () => {
    setTokens('old-access', 'refresh-1')
    harness.exportResponses = [
      () => envelope({ code: 40101, message: '过期', data: null }, 401),
      () => new Response('BEGIN:VCALENDAR', { status: 200 }),
    ]
    await clickExport()
    await waitFor(() => expect(exportCalls().length).toBeGreaterThan(0))
    const refreshes = harness.calls.filter((c) => c.url.includes('/api/v1/auth/refresh'))
    expect(
      refreshes.length,
      '导出没有经过统一传输：401 时没有刷新、没有重放',
    ).toBe(1)
  })

  it('非 2xx（500）不得提示「ICS 已导出」', async () => {
    harness.exportResponses = [() => envelope(null, 500)]
    await clickExport()
    await waitFor(() => expect(exportCalls().length).toBeGreaterThan(0))
    await waitFor(() => {
      expect(
        vi.mocked(notifySuccess).mock.calls.map((c) => String(c[0])).join('|'),
        '导出失败（HTTP 500）却提示了成功',
      ).not.toMatch(/导出/)
    })
    await waitFor(() => expect(vi.mocked(notifyError)).toHaveBeenCalled())
  })

  it('成功（200）时必须提示导出完成（防止把错误修法写成「永不提示」）', async () => {
    // 成功的 ICS 必须真的含事件：只有 VCALENDAR 外壳、0 个 VEVENT 的空日历按目标行为不算成功
    harness.exportResponses = [() => new Response(OK_ICS, { status: 200 })]
    await clickExport()
    await waitFor(() => expect(vi.mocked(notifySuccess)).toHaveBeenCalled())
    expect(vi.mocked(notifySuccess).mock.calls.map((c) => String(c[0])).join('|')).toMatch(/导出/)
  })

  it('成功（200）时用户拿到的下载内容必须是含事件的 ICS，不是错误页/空文件', async () => {
    harness.exportResponses = [() => new Response(OK_ICS, { status: 200 })]
    await clickExport()
    await waitFor(() => expect(exportedBlobs.length).toBeGreaterThan(0))
    const text = await exportedBlobs[0]!.text()
    expect(
      text,
      `导出成功的提示下，用户拿到的下载内容不是 ICS：${text.slice(0, 80)}`,
    ).toContain('BEGIN:VCALENDAR')
    expect(
      text,
      '「导出成功」时下载内容里必须有事件：0 个 VEVENT 的空日历不得算成功',
    ).toContain('BEGIN:VEVENT')
  })
})

describe('PW-08 导入：走统一传输 + 失败不得报成功', () => {
  async function uploadIcs() {
    const user = userEvent.setup()
    const { container } = renderPage()
    await screen.findByRole('button', { name: /导入 ICS/ })
    const input = container.querySelector('input[type="file"]') as HTMLInputElement
    const file = new File(['BEGIN:VCALENDAR'], 'audit.ics', { type: 'text/calendar' })
    await user.upload(input, file)
    await waitFor(() => {
      expect(harness.calls.some((c) => c.url.includes('import-ics'))).toBe(true)
    })
  }

  it('导入请求必须打到配置的 apiBase', async () => {
    await uploadIcs()
    const url = harness.calls.find((c) => c.url.includes('import-ics'))!.url
    expect(
      url.startsWith(API_BASE),
      `导入请求打到了 "${url}"：相对路径绕开了配置的服务端地址`,
    ).toBe(true)
  })

  it('非 2xx（500）不得提示「导入完成」', async () => {
    harness.importResponses = [() => envelope({ imported: 0, skipped: 0 }, 500)]
    await uploadIcs()
    await waitFor(() => {
      expect(
        vi.mocked(notifySuccess).mock.calls.map((c) => String(c[0])).join('|'),
        '导入失败（HTTP 500）却提示了「导入完成」',
      ).not.toMatch(/导入完成/)
    })
    await waitFor(() => expect(vi.mocked(notifyError)).toHaveBeenCalled())
  })

  it('响应不是合法 JSON 时不得提示成功', async () => {
    harness.importResponses = [
      () => new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }),
    ]
    await uploadIcs()
    await waitFor(() => expect(vi.mocked(notifyError)).toHaveBeenCalled())
    expect(vi.mocked(notifySuccess)).not.toHaveBeenCalled()
  })

  it('导入 401 时必须由统一传输刷新一次并重放（真实用户动作：选文件上传）', async () => {
    setTokens('old-access', 'refresh-1')
    harness.importResponses = [
      () => envelope({ code: 40101, message: '过期', data: null }, 401),
      () => envelope({ imported: 2, skipped: 1 }),
    ]
    await uploadIcs()
    await waitFor(() =>
      expect(
        harness.calls.filter((c) => c.url.includes('/api/v1/auth/refresh')).length,
        '导入没有经过统一传输：401 时没有刷新',
      ).toBe(1),
    )
    await waitFor(() =>
      expect(
        harness.calls.filter((c) => c.url.includes('import-ics')).length,
        '刷新成功之后必须重放一次导入请求',
      ).toBe(2),
    )
    await waitFor(() => expect(vi.mocked(notifySuccess)).toHaveBeenCalled())
  })

  it('成功（200）时必须提示导入结果（防止把错误修法写成「永不提示」）', async () => {
    harness.importResponses = [() => envelope({ imported: 2, skipped: 1 })]
    await uploadIcs()
    await waitFor(() => expect(vi.mocked(notifySuccess)).toHaveBeenCalled())
    const message = vi.mocked(notifySuccess).mock.calls.map((c) => String(c[0])).join('|')
    expect(message).toMatch(/导入完成/)
    expect(message, '成功提示必须报服务端返回的实际条数（成功 2、跳过 1）').toMatch(/成功 2/)
    expect(message).toMatch(/跳过 1/)
  })
})
