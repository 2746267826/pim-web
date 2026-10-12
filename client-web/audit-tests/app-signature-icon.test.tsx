// @vitest-environment jsdom
/*
 * PW-02 / I-3：应用签名的 icon 字段。
 *
 * 权威依据（只读 pim-api 源码）：`SaveAppSignatureRequest` 只有
 * processName/displayName/categoryPath/productivity/description，`SaveAsync` 从不写
 * `Icon`；响应 `AppSignatureDto` 有 `Icon`，值来自在线查询。
 * 结论：该输入框经此端点**永远无法持久化**，但展示必须保留。
 *
 * 本文件覆盖三条真实用户可见行为：
 *   1. 保存请求体不得包含契约外的 `icon` 字段；
 *   2. 响应里的 `icon` 仍然要展示（反向对照：修复不能靠删掉图标显示）；
 *   3. 保存成功后不能继续宣称这个 emoji「已保存」（除非明确说明不会持久化）。
 *
 * ⚠️ 证据等级：组件 + mock fetch。真实保存→读回的往返未测。
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

import { notifySuccess } from '@/lib/notify'
import { AppKnowledgeBasePage } from '@/features/knowledge/pages/app-knowledge-page'
import { setApiBase } from '@/lib/apiBase'
import { clearTokens } from '@/api/client'
import { loadContract } from './_lib/contract'

const API_BASE = 'http://192.0.2.10:5858'

const APP_ROW = {
  id: 'a1',
  processName: 'code',
  displayName: 'VS Code',
  categoryPath: '开发工具',
  productivity: 'productive',
  icon: '🧪',
  source: 'learned',
  updatedAt: '2026-10-11T00:00:00Z',
}

interface RecordedCall {
  url: string
  method: string
  body: Record<string, unknown> | null
}

let calls: RecordedCall[] = []

function envelope(data: unknown): Response {
  return new Response(JSON.stringify({ code: 0, message: 'ok', data }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

beforeEach(() => {
  clearTokens()
  setApiBase(API_BASE)
  calls = []
  vi.mocked(notifySuccess).mockClear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      calls.push({
        url,
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
      })
      if (url.includes('/api/v1/pc/app-knowledge/apps')) return envelope([APP_ROW])
      return envelope(null)
    }),
  )
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setApiBase('')
  clearTokens()
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <AppKnowledgeBasePage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

function inputByLabel(labelText: string): HTMLInputElement {
  const label = [...document.querySelectorAll('label')].find(
    (l) => l.textContent?.trim() === labelText,
  )
  const input = label?.parentElement?.querySelector('input')
  if (!input) throw new Error(`找不到「${labelText}」输入框`)
  return input as HTMLInputElement
}

/** 允许的修法之一是**去掉**这个输入框（emoji 无法持久化）；存在时才填 */
function maybeInputByLabel(labelText: string): HTMLInputElement | null {
  const label = [...document.querySelectorAll('label')].find(
    (l) => l.textContent?.trim() === labelText,
  )
  return (label?.parentElement?.querySelector('input') as HTMLInputElement | undefined) ?? null
}

async function openAddFormAndFill(icon: string, opts: { submit?: boolean } = {}) {
  const user = userEvent.setup()
  renderPage()
  await screen.findByText('VS Code')
  await user.click(screen.getByRole('button', { name: /添加应用/ }))
  await waitFor(() => expect(inputByLabel('进程名')).toBeTruthy())
  await user.type(inputByLabel('进程名'), 'audit-proc')
  await user.type(inputByLabel('显示名'), '审计应用')
  const iconInput = maybeInputByLabel('图标 emoji')
  if (icon && iconInput) await user.type(iconInput, icon)
  if (opts.submit === false) return user
  await user.click(screen.getByRole('button', { name: /^保存$/ }))
  await waitFor(() => {
    expect(calls.some((c) => c.url.includes('/api/v1/pc/app-signatures'))).toBe(true)
  })
  return user
}

describe('前置与反向对照：响应的 icon 必须继续展示', () => {
  it('列表渲染服务端返回的 icon（修复不得靠删掉图标列）', async () => {
    renderPage()
    await screen.findByText('VS Code')
    expect(
      screen.getByText('🧪'),
      '响应里的 icon 是契约内字段，必须继续展示',
    ).toBeTruthy()
  })
})

describe('I-3 保存请求体不得带契约外的 icon', () => {
  it('保存体的键必须是 SaveAppSignatureRequest 声明的属性子集', async () => {
    const contract = loadContract()
    const properties = contract.operations.get('POST /api/v1/pc/app-signatures')!.requestSchema!
      .properties!
    await openAddFormAndFill('🧪')
    const body = calls.find((c) => c.url.includes('/api/v1/pc/app-signatures'))!.body!
    const extra = Object.keys(body).filter((k) => !properties.has(k))
    expect(
      extra,
      `保存请求体发送了契约外的字段 ${extra.join(', ')}；服务端会忽略它们（图标永远无法持久化）`,
    ).toEqual([])
  })

  it('即使没有填 emoji，也不得发送 icon: null（additionalProperties:false 下仍是契约外字段）', async () => {
    await openAddFormAndFill('')
    const body = calls.find((c) => c.url.includes('/api/v1/pc/app-signatures'))!.body!
    expect(Object.keys(body)).not.toContain('icon')
  })
})

describe('I-3 不得对无法持久化的 emoji 宣称「已保存」', () => {
  it('要么不提供这个输入框，要么明确说明它不会持久化（不能默默丢掉用户输入）', async () => {
    await openAddFormAndFill('🧪', { submit: false })
    const labels = [...document.querySelectorAll('label')].map((l) => l.textContent?.trim())
    const offersIconInput = labels.includes('图标 emoji')
    const explained = /不.{0,6}持久化|仅.{0,6}展示|不会保存|无法保存/.test(
      document.body.textContent ?? '',
    )
    expect(
      !offersIconInput || explained,
      '表单提供「图标 emoji」输入框，却没有任何「不会保存到服务端」的说明：' +
        '保存成功后用户会以为 emoji 已经存进去了（实际 SaveAsync 从不写 Icon）',
    ).toBe(true)
  })

  it('成功提示本身不得出现「图标…已保存」这类断言', async () => {
    await openAddFormAndFill('🧪')
    const messages = vi.mocked(notifySuccess).mock.calls.map((c) => String(c[0])).join('|')
    expect(messages, '成功提示不许声称图标已经保存').not.toMatch(/图标.{0,6}(已保存|已添加)/)
    expect(messages, '保存成功本身仍要有成功提示（防止改成永不提示）').toMatch(/已添加|已保存/)
  })
})
