/*
 * 请求边界校验：一份会**展开 $ref** 的 OpenAPI (JSON Schema 子集) 校验器。
 *
 * 为什么需要它（而不是继续加厚自写的 AST 判定）：
 *   `callsites/conformance` 只按语法形式看顶层字面量，看不懂
 *   `$ref`（EventPersonDto / DaemonSourceState 等）、嵌套对象、非 nullable 的 null。
 *   这些维度在**真实的序列化请求体**上做一次机械校验更可靠，也更接近真实边界。
 *
 * 只支持本项目契约实际用到的子集：$ref / type / nullable / enum / required /
 * properties / additionalProperties / items / allOf。不做属性集合全等要求——
 * 可选字段省略必须通过。
 */
import type { ContractRaw } from './contract'

export interface SchemaProblem {
  /** JSON 路径，如 `$['organizer']['evil']` */
  path: string
  message: string
}

type JsonSchema = {
  $ref?: string
  type?: string
  nullable?: boolean
  enum?: string[]
  required?: string[]
  properties?: Record<string, JsonSchema>
  additionalProperties?: boolean | JsonSchema
  items?: JsonSchema
  allOf?: JsonSchema[]
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

function refName(ref: string): string {
  return ref.split('/').pop() ?? ref
}

/** 展开 $ref（带环保护：重复遇到同一个 ref 就不再展开） */
export function resolveSchema(
  raw: ContractRaw,
  schema: JsonSchema | undefined,
  seen: Set<string> = new Set(),
): JsonSchema {
  if (!schema) return {}
  if (schema.$ref) {
    const name = refName(schema.$ref)
    if (seen.has(name)) return {}
    const target = (raw.components?.schemas ?? {})[name] as JsonSchema | undefined
    if (!target) return {}
    return resolveSchema(raw, target, new Set([...seen, name]))
  }
  return schema
}

function typeMatches(type: string, value: unknown): boolean {
  switch (type) {
    case 'string':
      return typeof value === 'string'
    case 'integer':
      return typeof value === 'number' && Number.isInteger(value)
    case 'number':
      return typeof value === 'number' && Number.isFinite(value)
    case 'boolean':
      return typeof value === 'boolean'
    case 'array':
      return Array.isArray(value)
    case 'object':
      return isPlainObject(value)
    default:
      return true
  }
}

/**
 * 用契约 schema 校验一个**已经序列化/反序列化过的 JSON 值**。
 * 返回问题清单；空数组 = 通过。
 */
export function validateJson(
  raw: ContractRaw,
  schema: JsonSchema | undefined,
  value: unknown,
  path = '$',
  seen: Set<string> = new Set(),
): SchemaProblem[] {
  const problems: SchemaProblem[] = []
  if (!schema) return problems

  if (schema.$ref) {
    const name = refName(schema.$ref)
    if (seen.has(name)) return problems
    const target = (raw.components?.schemas ?? {})[name]
    if (!target) {
      problems.push({ path, message: `契约里没有 $ref 指向的 schema ${schema.$ref}` })
      return problems
    }
    return validateJson(raw, target as JsonSchema, value, path, new Set([...seen, name]))
  }

  for (const sub of schema.allOf ?? []) {
    problems.push(...validateJson(raw, sub, value, path, seen))
  }

  if (value === null) {
    if (schema.nullable !== true) {
      problems.push({
        path,
        message: `值是 null，但 schema 未声明 nullable（type=${schema.type ?? '<无>'}${
          schema.enum ? `, enum=[${schema.enum.join(', ')}]` : ''
        }）`,
      })
    }
    return problems
  }

  if (schema.type && !typeMatches(schema.type, value)) {
    problems.push({
      path,
      message: `类型不符：期望 ${schema.type}，实际 ${Array.isArray(value) ? 'array' : typeof value}`,
    })
    return problems
  }

  if (schema.enum && typeof value === 'string' && !schema.enum.includes(value)) {
    problems.push({
      path,
      message: `枚举值 "${value}" 不在 [${schema.enum.join(', ')}] 内`,
    })
    return problems
  }

  if (isPlainObject(value)) {
    for (const req of schema.required ?? []) {
      if (!(req in value)) {
        problems.push({ path: `${path}.${req}`, message: `缺少 required 字段 "${req}"` })
      }
    }
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`
      const prop = schema.properties?.[key]
      if (prop) {
        problems.push(...validateJson(raw, prop, child, childPath, seen))
        continue
      }
      if (schema.additionalProperties === false) {
        problems.push({
          path: childPath,
          message: `契约外字段 "${key}"（additionalProperties: false）`,
        })
        continue
      }
      if (isPlainObject(schema.additionalProperties)) {
        problems.push(...validateJson(raw, schema.additionalProperties, child, childPath, seen))
      }
    }
    return problems
  }

  if (Array.isArray(value) && schema.items) {
    value.slice(0, 50).forEach((item, i) => {
      problems.push(...validateJson(raw, schema.items, item, `${path}[${i}]`, seen))
    })
  }

  return problems
}

/** 取某个 operation 的 application/json 请求体 schema（没有则 null） */
export function operationRequestSchema(
  raw: ContractRaw,
  method: string,
  path: string,
): JsonSchema | null {
  const item = raw.paths?.[path] as Record<string, { requestBody?: { content?: Record<string, { schema?: JsonSchema }> } }> | undefined
  const op = item?.[method.toLowerCase()]
  return op?.requestBody?.content?.['application/json']?.schema ?? null
}

/** 便捷入口：校验「某 operation 的请求体 JSON」 */
export function validateOperationBody(
  raw: ContractRaw,
  method: string,
  path: string,
  body: unknown,
): SchemaProblem[] {
  const schema = operationRequestSchema(raw, method, path)
  if (!schema) return [{ path: '$', message: `契约 ${method} ${path} 没有 application/json 请求体 schema` }]
  return validateJson(raw, schema, body)
}
