/*
 * 合法用例（必须通过真实 tsc）：
 *   - 契约内 path + 正确 method；
 *   - 请求体是**具名生成类型**（components['schemas'][...]）；
 *   - 可选字段省略（不能要求属性集合全等）。
 */
import type { components } from '../../../src/api/generated'
import { typedJsonRequest } from '../../_lib/typed-client'

type CreateCalendarRequest = components['schemas']['CreateCalendarRequest']

// 可选字段省略：只有 name 也要能过
const minimal: CreateCalendarRequest = { name: '工作' }
export const okMinimal = typedJsonRequest('/api/v1/calendar/calendars', 'post', minimal)

// 多写一个已声明字段同样要能过
const filled: CreateCalendarRequest = { name: '工作', kind: 'calendar', color: '#3B82F6' }
export const okFilled = typedJsonRequest('/api/v1/calendar/calendars', 'post', filled)

// 内联字面量（合法字段）也要能过
export const okInline = typedJsonRequest('/api/v1/calendar/calendars', 'post', { name: 'x' })
