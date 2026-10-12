/*
 * 契约访问层（审计整改测试设施，非产品代码）。
 *
 * 目的：让「真实业务调用点 ↔ 权威契约」成为可机械判定的对象，而不是靠人工对照。
 * 权威来源是 contract/openapi.json（AGENTS.md 指定），本文件只读它。
 *
 * 关于尾斜杠：契约快照里 0 条 path 以 "/" 结尾，而 pim-api 源码确实注册了
 * `MapX("/")` 形态的路由（见 evidence.json 的逐条来源行号）。因此本文件提供
 * 「带证据的尾斜杠等价」判定：只有 evidence.json 里逐条登记、且带 pim-api
 * 源码位置与 DTO 字段清单的路径才被接受，且请求体仍按登记的 DTO 字段校验。
 * 这不是「白名单现有字符串」——任何未登记的新路径/新字段依然会被判为违规。
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
/** client-web/ 目录 */
export const CLIENT_WEB = path.resolve(HERE, '..', '..')
/** 仓库根 */
export const REPO_ROOT = path.resolve(CLIENT_WEB, '..')

export const CONTRACT_PATH = path.join(REPO_ROOT, 'contract', 'openapi.json')

export const HTTP_METHODS = ['get', 'post', 'put', 'delete', 'patch', 'head', 'options'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export interface PropertyInfo {
  /** OpenAPI 声明的 JSON 类型（string/number/integer/boolean/array/object）；未声明为 null */
  type: string | null
  /** 声明的枚举值（字符串/数字的源码文本）；未声明为 null */
  enumValues: string[] | null
  nullable: boolean
}

export interface RequestSchema {
  /** schema 名（components.schemas 的键） */
  name: string
  /** 允许的字段名集合；null 表示契约里该 schema 不是对象或无 properties */
  properties: Set<string> | null
  /** 字段 → 类型/枚举/nullable（可判定时用于类型与枚举检查） */
  propertyInfo: Map<string, PropertyInfo>
  /** 契约声明的必填字段 */
  required: Set<string>
}

export interface Operation {
  method: HttpMethod
  /** 契约里的字面 path */
  path: string
  /** 归一化（动态段 → {param}）后的 path，用于与调用点比对 */
  normalizedPath: string
  /** 契约声明的 query 参数名集合（in: query） */
  queryParams: Set<string>
  /** 契约声明的 path 参数名集合（in: path） */
  pathParams: Set<string>
  /** 契约是否声明了 requestBody */
  hasRequestBody: boolean
  /** 请求体引用的 schema；无则为 null */
  requestSchema: RequestSchema | null
  /** 契约是否声明了 2xx 响应体 schema */
  hasResponseSchema: boolean
}

export interface ContractIndex {
  /** "METHOD /path" → operation（字面 path） */
  operations: Map<string, Operation>
  /** "METHOD /normalized" → operations（动态段已归一） */
  byNormalized: Map<string, Operation[]>
  /** 仅 path 去重 */
  paths: Set<string>
  raw: {
    paths: Record<string, Record<string, unknown>>
    components?: { schemas?: Record<string, unknown> }
  }
}

/**
 * 把 `${...}` 与 `{name}` 统一成 `{param}`，使调用点与契约可比较。
 * 只处理 path 部分：query string 里的 `?date=${x}` 不是路径段，
 * 混进来会把 `/a/b?x=1` 归一成 `/a/b{param}` 从而永远匹配不上契约（早期版本的缺陷）。
 */
export function splitQuery(p: string): { path: string; query: string | null } {
  const i = p.indexOf('?')
  if (i === -1) return { path: p, query: null }
  return { path: p.slice(0, i), query: p.slice(i + 1) }
}

export function normalizePathTemplate(p: string): string {
  const { path } = splitQuery(p)
  return path.replace(/\$\{[^}]*\}/g, '{param}').replace(/\{[^}]*\}/g, '{param}')
}

export function opKey(method: string, p: string): string {
  return `${method.toUpperCase()} ${p}`
}

function collectRequestSchema(
  schemas: Record<string, unknown>,
  requestBody: unknown,
): RequestSchema | null {
  const content = (requestBody as { content?: Record<string, { schema?: unknown }> } | undefined)
    ?.content
  if (!content) return null
  const first = Object.values(content)[0]
  const ref = (first?.schema as { $ref?: string } | undefined)?.$ref
  if (!ref) return null
  const name = ref.split('/').pop() ?? ''
  const target = schemas[name] as
    | { properties?: Record<string, unknown>; required?: string[] }
    | undefined
  const propertyInfo = new Map<string, PropertyInfo>()
  for (const [propName, propRaw] of Object.entries(target?.properties ?? {})) {
    const p = propRaw as { type?: unknown; enum?: unknown; nullable?: unknown }
    const enumValues = Array.isArray(p.enum)
      ? p.enum.map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
      : null
    propertyInfo.set(propName, {
      type: typeof p.type === 'string' ? p.type : null,
      enumValues,
      nullable: p.nullable === true,
    })
  }
  return {
    name,
    properties: target?.properties ? new Set(Object.keys(target.properties)) : null,
    propertyInfo,
    required: new Set(target?.required ?? []),
  }
}

let cached: ContractIndex | null = null

export type ContractRaw = ContractIndex['raw']

/** 由原始 openapi.json 结构构建索引（也用于故障对照里的「契约变体」） */
export function buildContractIndex(raw: ContractIndex['raw']): ContractIndex {
  const schemas = raw.components?.schemas ?? {}
  const operations = new Map<string, Operation>()
  const byNormalized = new Map<string, Operation[]>()
  const paths = new Set<string>()

  for (const [p, item] of Object.entries(raw.paths)) {
    paths.add(p)
    for (const [method, opRaw] of Object.entries(item)) {
      if (!(HTTP_METHODS as readonly string[]).includes(method)) continue
      const op = opRaw as {
        requestBody?: unknown
        responses?: Record<string, unknown>
        parameters?: { name?: string; in?: string }[]
      }
      const responses = op.responses ?? {}
      const queryParams = new Set<string>()
      const pathParams = new Set<string>()
      const parameters = [
        ...((item as { parameters?: { name?: string; in?: string }[] }).parameters ?? []),
        ...(op.parameters ?? []),
      ]
      for (const param of parameters) {
        if (!param?.name) continue
        if (param.in === 'query') queryParams.add(param.name)
        if (param.in === 'path') pathParams.add(param.name)
      }
      const hasResponseSchema = Object.entries(responses).some(
        ([code, r]) => code.startsWith('2') && Boolean((r as { content?: unknown }).content),
      )
      const operation: Operation = {
        method: method as HttpMethod,
        path: p,
        normalizedPath: normalizePathTemplate(p),
        queryParams,
        pathParams,
        hasRequestBody: op.requestBody !== undefined,
        requestSchema: collectRequestSchema(schemas, op.requestBody),
        hasResponseSchema,
      }
      operations.set(opKey(method, p), operation)
      const nk = opKey(method, operation.normalizedPath)
      const bucket = byNormalized.get(nk)
      if (bucket) bucket.push(operation)
      else byNormalized.set(nk, [operation])
    }
  }
  return { operations, byNormalized, paths, raw }
}

/** 读取真实契约快照（带缓存） */
export function loadContract(): ContractIndex {
  if (cached) return cached
  cached = buildContractIndex(
    JSON.parse(readFileSync(CONTRACT_PATH, 'utf8')) as ContractIndex['raw'],
  )
  return cached
}

/* ── 尾斜杠等价的「带证据」登记 ──────────────────────────────── */

export interface TrailingSlashEvidence {
  /** 客户端使用的带斜杠路径（动态段已归一） */
  trailingSlashPath: string
  method: HttpMethod
  /** 契约里记录的无斜杠 path */
  contractPath: string
  /** pim-api 源码位置（文件:行，只读核对所得，非猜测） */
  serverRegistration: string
  /** 服务端该注册绑定的请求 DTO 名；null = 无请求体 */
  requestDto: string | null
  /** 该 DTO 的字段清单（来自 pim-api 权威源码） */
  requestDtoFields: string[] | null
  /** 该 DTO 是否出现在契约 components.schemas 中 */
  dtoPresentInContract: boolean
  /** upstream-contract-gap = 客户端正确、契约漏登记（客户端不得改动） */
  upstreamStatus: 'upstream-contract-gap' | 'contract-complete'
  note: string
}

export function loadTrailingSlashEvidence(): Record<string, TrailingSlashEvidence> {
  const file = path.join(HERE, 'evidence.json')
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as {
    trailingSlashEvidence: Record<string, TrailingSlashEvidence>
  }
  return parsed.trailingSlashEvidence
}

export interface RouteProbeEvidence {
  what: string
  notWhat: string
  howToReproduce: string
  probePort: string
  observations: string[]
}

export interface EvidenceFile {
  referenceRepo: string
  referenceSha: string
  contractSnapshotSha256: string
  routeProbeEvidence: RouteProbeEvidence
  trailingSlashEvidence: Record<string, TrailingSlashEvidence>
}

/** 读取 evidence.json 全文（含路由探针与快照 sha 登记） */
export function loadEvidenceFile(): EvidenceFile {
  const file = path.join(HERE, 'evidence.json')
  return JSON.parse(readFileSync(file, 'utf8')) as EvidenceFile
}

export type PathResolution =
  | { kind: 'exact'; operation: Operation }
  | { kind: 'trailing-slash-evidenced'; operation: Operation; evidence: TrailingSlashEvidence }
  | { kind: 'trailing-slash-unevidenced'; operation: Operation | null }
  | { kind: 'absent' }

/**
 * 把调用点（方法 + 路径模板）解析到契约 operation。
 * 依次尝试：字面精确 → 归一化精确 → 带证据的尾斜杠等价。
 */
export function resolveOperation(
  method: string,
  callPath: string,
  contract: ContractIndex = loadContract(),
): PathResolution {
  const m = method.toLowerCase()
  const normalizedCall = normalizePathTemplate(callPath)
  const canonical: HttpMethod = (
    (HTTP_METHODS as readonly string[]).includes(m) ? m : 'get'
  ) as HttpMethod

  const exact = contract.operations.get(opKey(m, callPath))
  if (exact) return { kind: 'exact', operation: exact }

  // callPath 里通常带 query string；normalizePathTemplate 已剥掉 query，
  // 因此这里既处理动态段命名差异，也处理 `?a=1` 这类查询串。
  const normMatches = contract.byNormalized.get(opKey(m, normalizedCall)) ?? []
  if (normMatches.length === 1) {
    const operation = normMatches[0]!
    if (normalizedCall !== normalizePathTemplate(operation.path)) {
      // 仅动态段命名不同：属于同一 operation
      return { kind: 'exact', operation }
    }
    return { kind: 'exact', operation }
  }

  // 尾斜杠等价：只有带证据才接受
  const evidence = loadTrailingSlashEvidence()[opKey(canonical, normalizedCall)]
  const trimmed = normalizedCall.replace(/\/+$/, '')
  const fallback =
    contract.byNormalized.get(opKey(m, trimmed))?.[0] ??
    contract.byNormalized.get(opKey(m, `${trimmed}/`))?.[0] ??
    null
  if (evidence) {
    if (!fallback) return { kind: 'absent' }
    return { kind: 'trailing-slash-evidenced', operation: fallback, evidence }
  }
  if (normalizedCall.endsWith('/') && fallback) {
    return { kind: 'trailing-slash-unevidenced', operation: fallback }
  }
  return { kind: 'absent' }
}
