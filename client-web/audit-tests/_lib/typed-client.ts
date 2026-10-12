/*
 * 目标形态的类型封装（**下一轮才做进生产**，本轮只作为真实 tsc 判据）。
 *
 * PW-01/PW-13 的验收要求：业务封装的 path 收窄到 generated.ts 的 path 联合，
 * 请求体由 operation 的 schema 推导；契约外路径、错误 method、多余字段、
 * 宽 `Record<string, unknown>` 必须让真实 `tsc` 失败，而**合法具名生成类型**
 * 必须能通过。这里就是这个最小形态，供 fixtures 编译验证。
 *
 * 注意：这不是第二套 AST/解析器，只是把 generated.ts 已有的类型拼起来。
 */
import type { paths } from '../../src/api/generated'

export type ContractPath = keyof paths
export type MethodsOf<P extends ContractPath> = keyof paths[P]

type JsonContent<C> = C extends { content: { 'application/json': infer B } } ? B : never

/** operation 的 JSON 请求体类型；没有 requestBody 的 method → never */
export type RequestBodyOf<P extends ContractPath, M extends MethodsOf<P>> = paths[P][M] extends {
  requestBody: infer RB
}
  ? JsonContent<RB>
  : never

export function typedJsonRequest<P extends ContractPath, M extends MethodsOf<P>>(
  path: P,
  method: M,
  body: RequestBodyOf<P, M>,
): { path: P; method: M; body: RequestBodyOf<P, M> } {
  return { path, method, body }
}
