/*
 * 契约一致性判定（审计整改测试设施，非产品代码）。
 * 单独成模块，是为了让测试可以对「合成调用点」跑同一套判定做故障对照
 * —— 证明判定不是恒真、不是「白名单现有字符串」。
 */
import {
  loadContract,
  normalizePathTemplate,
  resolveOperation,
  splitQuery,
  type ContractIndex,
  type Operation,
  type PropertyInfo,
} from './contract'
import type { CallSite } from './callsites'

export type Finding =
  | {
      kind: 'path-absent'
      file: string
      line: number
      method: string
      path: string
      message: string
    }
  | {
      kind: 'invalid-path-segment'
      file: string
      line: number
      method: string
      path: string
      segment: string
      message: string
    }
  | {
      kind: 'trailing-slash-unevidenced'
      file: string
      line: number
      method: string
      path: string
      message: string
    }
  | {
      kind: 'undeclared-body-field'
      file: string
      line: number
      method: string
      path: string
      field: string
      schema: string
      message: string
    }
  | {
      kind: 'missing-required-body-field'
      file: string
      line: number
      method: string
      path: string
      field: string
      schema: string
      message: string
    }
  | {
      kind: 'body-field-type-mismatch'
      file: string
      line: number
      method: string
      path: string
      field: string
      schema: string
      expected: string
      actual: string
      message: string
    }
  | {
      kind: 'body-field-enum-mismatch'
      file: string
      line: number
      method: string
      path: string
      field: string
      schema: string
      allowed: string[]
      actual: string
      message: string
    }
  | {
      /** 请求体存在但字段集合无法静态核对 —— fail-closed，算违规（无法核对 ≠ 通过） */
      kind: 'unverifiable-body'
      file: string
      line: number
      method: string
      path: string
      message: string
    }
  | {
      kind: 'undeclared-query-param'
      file: string
      line: number
      method: string
      path: string
      param: string
      message: string
    }
  | {
      kind: 'body-not-declared'
      file: string
      line: number
      method: string
      path: string
      fields: string[]
      message: string
    }
  | {
      kind: 'contract-gap'
      file: string
      line: number
      method: string
      path: string
      detail: string
      message: string
    }
  | {
      kind: 'unverifiable-response'
      file: string
      line: number
      method: string
      path: string
      message: string
    }

/** 会让契约一致性检查变红的判定 */
export const VIOLATION_KINDS = new Set<Finding['kind']>([
  'path-absent',
  'invalid-path-segment',
  'trailing-slash-unevidenced',
  'undeclared-body-field',
  'missing-required-body-field',
  'body-field-type-mismatch',
  'body-field-enum-mismatch',
  'unverifiable-body',
  'body-not-declared',
  'undeclared-query-param',
])

const JSON_TYPE_OF_VALUE_KIND: Record<string, string[]> = {
  string: ['string'],
  number: ['number', 'integer'],
  boolean: ['boolean'],
  array: ['array'],
  object: ['object'],
}

export function isViolation(f: Finding): boolean {
  return VIOLATION_KINDS.has(f.kind)
}

/** 判定单个调用点。第二个参数可换成契约变体（仅用于判定器本身的故障对照）。 */
export function checkCallSite(site: CallSite, contract: ContractIndex = loadContract()): Finding[] {
  const findings: Finding[] = []
  const at = { file: site.file, line: site.line, method: site.method }

  if (site.pathTemplate === null) {
    // 无法解析的路径（服务端返回的 URL 等）不计入本判定，
    // 由 inventory 断言单独看住其集合，避免成为「藏违规的地方」。
    return findings
  }

  const callPath = normalizePathTemplate(site.pathTemplate)

  // 路径段本身必须合法：`.`/`..` 会改变真实路由目标（可以绕过契约模板匹配），
  // 中间的空段（`//`）同理。这类「注入字面量就能构造出来的路径」必须 fail-closed。
  const rawPath = splitQuery(site.pathTemplate).path
  const rawSegments = rawPath.split('/')
  /*
   * 非法段判定要看**解码后**的文本：`..%2F`（= 浏览器里写 encodeURIComponent('../')）
   * 解码后是 `../`，会引入新的路径段边界，是遍历向量，不能因为它是百分号编码就放过。
   */
  const illegal = rawSegments.filter((s) => {
    if (s === '.' || s === '..') return true
    let decoded = s
    try {
      decoded = decodeURIComponent(s)
    } catch {
      return false
    }
    return decoded === '.' || decoded === '..' || decoded.includes('/')
  })
  const hasInteriorEmpty = rawSegments.slice(1, -1).some((s) => s === '')
  if (illegal.length > 0 || hasInteriorEmpty) {
    const segment = illegal[0] ?? '//'
    findings.push({
      ...at,
      kind: 'invalid-path-segment',
      path: callPath,
      segment,
      message: `路径含非法段 "${segment}"（${rawPath}）：遍历段/空段会改变真实路由目标，不能与契约模板等价`,
    })
    return findings
  }

  // 路径尾部无法静态判定（可能是路径段也可能是 query）：记 UNVERIFIED，
  // 既不能当违规（会误报），也不能当 PASS（会漏报）。
  if (callPath.includes('$TAIL') || site.pathTemplate.includes('$TAIL')) {
    findings.push({
      ...at,
      kind: 'unverifiable-response',
      path: callPath,
      message: `路径尾部由无法静态判定的表达式拼接（${site.rawPathText.replace(/\s+/g, ' ').slice(0, 60)}），可能落在路径段或 query 上，无法机械核对`,
    })
    return findings
  }

  const resolved = resolveOperation(site.method, callPath, contract)

  if (resolved.kind === 'absent') {
    findings.push({
      ...at,
      kind: 'path-absent',
      path: callPath,
      message: `${site.method} ${callPath} 在契约 315 个 operation 中找不到对应项，也没有带证据的尾斜杠等价登记`,
    })
    return findings
  }

  if (resolved.kind === 'trailing-slash-unevidenced') {
    findings.push({
      ...at,
      kind: 'trailing-slash-unevidenced',
      path: callPath,
      message: `${site.method} ${callPath} 与契约 ${resolved.operation?.path ?? '<无>'} 仅差尾斜杠，但 evidence.json 中没有对应的权威来源登记`,
    })
    return findings
  }

  const operation: Operation = resolved.operation
  const evidence = resolved.kind === 'trailing-slash-evidenced' ? resolved.evidence : null

  // 尾斜杠导致的「契约漏登记」必须显式可见，不能算 PASS
  if (evidence && evidence.upstreamStatus === 'upstream-contract-gap') {
    findings.push({
      ...at,
      kind: 'contract-gap',
      path: callPath,
      detail: `${evidence.requestDto ?? '<无请求体>'} 未出现在契约 components.schemas；服务端注册位置 ${evidence.serverRegistration}`,
      message: `CONTRACT-GAP：${site.method} ${callPath} 对应的是 ${evidence.serverRegistration}，该注册的 DTO ${evidence.requestDto ?? '<无>'} 未进契约；客户端不得改动，需 pim-api 补齐契约`,
    })
  }

  /* ── query 参数校验（契约声明的 in:query 名称） ─────────── */

  const { query } = splitQuery(site.pathTemplate)
  if (query !== null && !query.includes('$DYNAMIC') && !query.includes('${')) {
    const declared = operation.queryParams
    for (const pair of query.split('&')) {
      if (!pair) continue
      const key = pair.split('=')[0] ?? ''
      if (!key) continue
      if (declared.size === 0) {
        findings.push({
          ...at,
          kind: 'undeclared-query-param',
          path: callPath,
          param: key,
          message: `调用点发送了 query 参数 "${key}"，但契约 ${site.method} ${operation.path} 未声明任何 query 参数`,
        })
      } else if (!declared.has(key)) {
        findings.push({
          ...at,
          kind: 'undeclared-query-param',
          path: callPath,
          param: key,
          message: `query 参数 "${key}" 不在契约声明的 query 参数里（契约：${[...declared].join(', ')}）`,
        })
      }
    }
  } else if (query !== null) {
    findings.push({
      ...at,
      kind: 'unverifiable-response',
      path: callPath,
      message: `query string 含动态构造，参数名无法静态核对（${query}）`,
    })
  }

  /* ── 请求体字段校验 ───────────────────────────────────── */

  const fields = site.bodyKeys
  const effectiveSchema =
    evidence && evidence.requestDtoFields
      ? {
          name: evidence.dtoPresentInContract
            ? `${evidence.requestDto}（契约已收录）`
            : `${evidence.requestDto}（pim-api 权威源码，未进契约）`,
          properties: new Set(evidence.requestDtoFields),
          propertyInfo: new Map<string, PropertyInfo>(),
          required: new Set<string>(),
        }
      : operation.requestSchema

  // fail-closed：发送了请求体但字段集合无法静态枚举（未绑定标识符 / Record<…> /
  // 解不开的 spread）→ 算违规。无法核对不等于通过。
  if (site.bodyOpaque) {
    findings.push({
      ...at,
      kind: 'unverifiable-body',
      path: callPath,
      message: `请求体无法核对：${site.bodyOpaqueReason ?? '字段清单不完整'}`,
    })
  }

  /*
   * PW-01/PW-13 的**接受**判据：参数/变量的声明类型就是该 operation 的 generated
   * 请求类型时，不再算「字段集合不可核对」——类型本身已经在 compile time 约束了字段。
   * 但接受是有条件的：声明的 schema 必须**正是**本次调用命中的 operation 的
   * requestBody schema；否则（类型对不上、或该 operation 根本没有 requestBody）
   * 仍然是 unverifiable-body（fail-closed），不能靠随便写个具名类型混过。
   */
  if (site.bodySchemaType !== null && !site.bodyOpaque) {
    const declared = site.bodySchemaType
    if (!effectiveSchema || effectiveSchema.name !== declared) {
      findings.push({
        ...at,
        kind: 'unverifiable-body',
        path: callPath,
        message: `请求体声明类型 ${declared} 不是 ${site.method} ${operation.path} 的 generated 请求类型（该 operation 的 requestBody schema：${
          effectiveSchema?.name ?? '<无>'
        }）`,
      })
    }
  }

  if (fields !== null) {
    if (!effectiveSchema) {
      // 空请求体（`{}`）打在没有 requestBody 的 operation 上：没有字段可违规，
      // 不作为违规（也不当作「字段已核对」——它本来就无字段）。
      if (fields.length > 0 && !operation.hasRequestBody) {
        findings.push({
          ...at,
          kind: 'body-not-declared',
          path: callPath,
          fields,
          message: `调用点发送了请求体字段 [${fields.join(', ')}]，但契约 ${site.method} ${operation.path} 未声明 requestBody`,
        })
      } else if (fields.length > 0 && operation.requestSchema === null) {
        // 声明了 requestBody 但 schema 不是对象（multipart 等）：不做字段判定，记录为不可核对
        findings.push({
          ...at,
          kind: 'unverifiable-response',
          path: callPath,
          message: `契约声明了 requestBody 但未给出对象 schema，字段无法机械核对`,
        })
      }
    } else if (effectiveSchema.properties) {
      for (const f of fields) {
        if (!effectiveSchema.properties.has(f)) {
          findings.push({
            ...at,
            kind: 'undeclared-body-field',
            path: callPath,
            field: f,
            schema: effectiveSchema.name,
            message: `请求体字段 "${f}" 不在 ${effectiveSchema.name} 的 properties 里`,
          })
        }
      }
      // 「可判定时」检查：契约写了 required 却没传 → 违规
      for (const r of effectiveSchema.required) {
        if (!fields.includes(r)) {
          findings.push({
            ...at,
            kind: 'missing-required-body-field',
            path: callPath,
            field: r,
            schema: effectiveSchema.name,
            message: `请求体缺少 ${effectiveSchema.name} 声明的必填字段 "${r}"`,
          })
        }
      }
      // 「可判定时」检查：字面量的 JSON 类型与 enum 与 schema 不一致 → 违规
      for (const f of site.bodyFields ?? []) {
        const info = effectiveSchema.propertyInfo.get(f.name)
        if (!info || f.valueKind === 'unknown') continue
        if (info.enumValues && f.literal !== null && !info.enumValues.includes(f.literal)) {
          findings.push({
            ...at,
            kind: 'body-field-enum-mismatch',
            path: callPath,
            field: f.name,
            schema: effectiveSchema.name,
            allowed: info.enumValues,
            actual: f.literal,
            message: `请求体字段 "${f.name}" 的值 ${f.literal} 不在 ${effectiveSchema.name} 声明的枚举 [${info.enumValues.join(', ')}] 内`,
          })
          continue
        }
        if (info.type) {
          // 非 nullable 的 null 必须报错：null 的「可用类型表」为空，旧写法会静默跳过。
          if (f.valueKind === 'null' && !info.nullable) {
            findings.push({
              ...at,
              kind: 'body-field-type-mismatch',
              path: callPath,
              field: f.name,
              schema: effectiveSchema.name,
              expected: info.type,
              actual: 'null',
              message: `请求体字段 "${f.name}" 是 null，而 ${effectiveSchema.name} 声明为 ${info.type} 且非 nullable`,
            })
            continue
          }
          const allowedKinds = JSON_TYPE_OF_VALUE_KIND[f.valueKind] ?? []
          const nullAllowed = f.valueKind === 'null' && info.nullable
          if (allowedKinds.length > 0 && !allowedKinds.includes(info.type) && !nullAllowed) {
            findings.push({
              ...at,
              kind: 'body-field-type-mismatch',
              path: callPath,
              field: f.name,
              schema: effectiveSchema.name,
              expected: info.type,
              actual: f.valueKind,
              message: `请求体字段 "${f.name}" 是 ${f.valueKind} 字面量，而 ${effectiveSchema.name} 声明为 ${info.type}`,
            })
          }
        }
      }
    } else {
      findings.push({
        ...at,
        kind: 'unverifiable-response',
        path: callPath,
        message: `${effectiveSchema.name} 在契约里没有 properties，字段无法机械核对`,
      })
    }
  }

  // 响应维度：契约 2xx 无 schema 时，明确记为不可核对（不是 PASS）
  if (!operation.hasResponseSchema) {
    findings.push({
      ...at,
      kind: 'unverifiable-response',
      path: callPath,
      message: `契约 ${site.method} ${operation.path} 的 2xx 响应没有 schema，响应字段/必填/枚举无法机械核对`,
    })
  }

  return findings
}

export function checkCallSites(sites: CallSite[], contract?: ContractIndex): Finding[] {
  return sites.flatMap((s) => checkCallSite(s, contract))
}

export function formatFindings(findings: Finding[]): string {
  return findings.map((f) => `${f.file}:${f.line} ${f.message}`).join('\n')
}
