// @vitest-environment jsdom
/*
 * PW-18（登录页侧）：429 锁定提示必须显示**服务端给出的**真实等待时长。
 *
 * 旧实现把等待时长写死成「15 分钟」，与 `ApiError.retryAfterMs` 脱钩；
 * 这里用真实组件 + 真实提交动作验证页面确实按服务端数值显示。
 *
 * ⚠️ 证据等级：组件 + mock 认证上下文。不是真实后端往返；登录成功后的跳转流程未验证。
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router'

/** 让页面在提交时抛出指定的 429 错误 */
let nextError: { message: string; code: number; status: number; retryAfterMs: number | null } | null =
  null

vi.mock('@/features/auth/auth-context', () => ({
  useAuth: () => ({
    user: null,
    login: async () => {
      const { ApiError } = await import('@/api/client')
      const e = nextError ?? { message: 'x', code: -1, status: 0, retryAfterMs: null }
      throw new ApiError(e.message, e.code, e.status, e.retryAfterMs)
    },
    register: async () => {},
  }),
}))

vi.mock('@/lib/notify', () => ({
  notifySuccess: vi.fn(),
  notifyError: vi.fn(),
  shouldMuteError: () => false,
}))

import { LoginPage } from '@/features/auth/pages/login-page'

afterEach(() => {
  cleanup()
  nextError = null
})

async function submitLogin() {
  const user = userEvent.setup()
  render(
    <MemoryRouter>
      <LoginPage />
    </MemoryRouter>,
  )
  await user.type(screen.getByLabelText('用户名或邮箱'), 'audit-user')
  await user.type(screen.getByLabelText('密码'), 'audit-pass')
  await user.click(screen.getByRole('button', { name: /^登录$/ }))
}

describe('PW-18：登录页必须显示服务端给出的等待时长', () => {
  it('Retry-After: 900（15 分钟）→ 页面显示 15 分钟', async () => {
    nextError = { message: 'too many attempts', code: 42901, status: 429, retryAfterMs: 900_000 }
    await submitLogin()
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/15\s*分钟/)
    })
  })

  it('Retry-After: 60 → 页面显示 1 分钟，而不是写死的 15 分钟', async () => {
    nextError = { message: 'too many attempts', code: 42901, status: 429, retryAfterMs: 60_000 }
    await submitLogin()
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/1\s*分钟/)
    })
    expect(document.body.textContent, '页面仍在显示写死的 15 分钟').not.toMatch(/15\s*分钟/)
  })

  it('没有 Retry-After 时不猜时长（只说稍后再试）', async () => {
    nextError = { message: 'too many attempts', code: 42901, status: 429, retryAfterMs: null }
    await submitLogin()
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/尝试次数过多/)
    })
    expect(document.body.textContent).not.toMatch(/15\s*分钟/)
  })

  it('反向对照：非 429 的业务错误仍然显示服务端消息', async () => {
    nextError = { message: '用户名或密码错误', code: 40001, status: 400, retryAfterMs: null }
    await submitLogin()
    await waitFor(() => {
      expect(document.body.textContent).toMatch(/用户名或密码错误/)
    })
  })
})
