/*
 * 非法用例（每一条都必须被真实 tsc 拒绝）。
 *
 * 用 `@ts-expect-error`：如果某条**没有**报错，tsc 会报
 * "Unused '@ts-expect-error' directive"，本文件就编译不过——
 * 因此「编译通过」= 每一条都真的被拒绝了。不用任何探针字符串特判。
 */
import { typedJsonRequest } from '../../_lib/typed-client'

// @ts-expect-error 契约外路径必须失败
export const badPath = typedJsonRequest('/api/v1/audit-not-in-contract-probe', 'post', {})

// @ts-expect-error 契约外的 method 必须失败
export const badMethod = typedJsonRequest('/api/v1/calendar/calendars', 'patch', {})

// @ts-expect-error GET 没有 requestBody，传 body 必须失败
export const badMethodWithBody = typedJsonRequest('/api/v1/calendar/calendars', 'get', {})

// @ts-expect-error 契约外多余字段必须失败
export const extraField = typedJsonRequest('/api/v1/calendar/calendars', 'post', { name: 'x', extraField: 1 })

// SiteImportRequest.content 是 required：宽 Record 无法满足必填字段的具体类型
const wide: Record<string, unknown> = { content: 'x' }
// @ts-expect-error 宽 Record 请求体必须失败（不得用宽类型绕过契约约束）
export const wideBody = typedJsonRequest('/api/v1/pc/browser-tt/import', 'post', wide)

// @ts-expect-error 字段类型不符必须失败（name 声明为 string）
export const wrongType = typedJsonRequest('/api/v1/calendar/calendars', 'post', { name: 123 })
