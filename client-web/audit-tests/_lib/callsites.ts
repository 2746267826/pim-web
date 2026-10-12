/*
 * 生产网络调用点提取器（审计整改测试设施，非产品代码）。
 *
 * 用 TypeScript 自己的 AST 而不是正则，理由是可验证的：
 * - 正则版会把「对象方法声明」`async fetch(pageDelta)` 误判成网络调用；
 * - 正则版会漏掉路径实参换行书写的调用（审计 raw3 抽取器在 calendar/api.ts
 *   漏了 6 处、files/api.ts 漏了 7 处，共 50 处，见 round2/requirements-update.md）。
 *
 * 解析能力（每一层都做了保守处理）：
 * - 作用域感知的 const/let 绑定解析（同名变量在别的函数里复用时不会被张冠李戴）；
 * - `const q = new URLSearchParams({...})` + 后续 `q.set('k', …)` → query 键可枚举；
 * - 模板里的字面量片段（`${'../admin'}`）与字符串常量同样被代入，避免「用字面量
 *   就能绕过路径检查」；
 * - `const [form, setForm] = useState({...})` → 解出 `{...form, x: 1}` 的字段名；
 * - 请求体字段的值形状（string/number/boolean/array/object/null）也会带出来，
 *   供判定层做「可判定时」的类型/枚举检查；
 * - **fail-closed**：`Record<string, unknown>` 这类显式宽类型绑定、无绑定的标识符
 *   请求体、解不出的 spread，都不当作「字段已核对」，而是标成 bodyOpaque，
 *   由判定层判成违规（无法核对 ≠ 通过）。
 *
 * 无法判定的表达式一律标成哨兵（$TAIL / $DYNAMIC），由判定层记为 UNVERIFIED，
 * 既不算 PASS 也不算违规。
 */
import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'
import ts from 'typescript'
import { CLIENT_WEB } from './contract'

export type CallLevel = 'business' | 'transport' | 'wrapper-definition' | 'test'
/** 内部用：client.ts 整体（再按 wrapper 细分），不对外暴露 */
type BaseLevel = CallLevel | 'wrapper-boundary'

/** 路径尾部由无法静态判定的表达式拼接（可能落在路径段或 query 上，UNKNOWN） */
export const TAIL_SENTINEL = '$TAIL'
/** query 由动态构造器拼出，参数名不可静态枚举 */
export const DYNAMIC_QUERY_SENTINEL = '$DYNAMIC'

/** 请求体字段值的 JSON 形状（静态可判定时） */
export type ValueKind =
  | 'string'
  | 'number'
  | 'boolean'
  | 'null'
  | 'array'
  | 'object'
  | 'unknown'

export interface BodyField {
  name: string
  valueKind: ValueKind
  /** 字面量的源码文本（string/number/boolean 才非空），用于枚举检查 */
  literal: string | null
}

export interface CallSite {
  /** 相对被测根的路径 */
  file: string
  line: number
  /**
   * **稳定身份**（I-R6）：包住这次调用的最近一个函数/方法的源码名；
   * 模块顶层调用为 `'<module>'`。行号下面的 `occurrence` 一起用，
   * 使「哪一处调用」不随上下插入代码而改变（行号会变，身份不变）。
   */
  enclosingFunction: string
  /** 同一文件 + 同一 `enclosingFunction` + 同一 wrapper 下的第几次调用（从 0 起） */
  occurrence: number
  level: CallLevel
  /** apiGet / apiPost / fetch ... */
  wrapper: string
  method: string
  /** 解析出的路径模板（动态段写作 ${...}）；解析不出为 null */
  pathTemplate: string | null
  resolution: 'string-literal' | 'template' | 'local-const' | 'unresolved' | 'partial'
  rawPathText: string
  /** 请求体顶层字段名；null = 无请求体或有请求体但无法静态枚举 */
  bodyKeys: string[] | null
  bodyKind: 'object-literal' | 'formdata' | 'identifier' | 'typed-request' | 'none'
  /** 请求体字段的值形状（键与 bodyKeys 一致）；无法枚举时为 null */
  bodyFields: BodyField[] | null
  /** 请求体存在但无法完整核对（未绑定的标识符 / 宽类型 / 解不出的 spread） */
  bodyOpaque: boolean
  /** bodyOpaque 的可读原因（用于违规信息） */
  bodyOpaqueReason: string | null
  /**
   * 请求体的**声明类型**就是 generated 的具名 schema 时，记下该 schema 名
   * （PW-01/PW-13 的接受判据：参数或变量的类型注解 = 该 operation 的 generated
   * 请求类型 ⇒ 不再算「字段无法核对」）。判定层仍要求它等于该 operation 的
   * requestBody schema，否则保持 fail-closed。
   */
  bodySchemaType: string | null
}

/**
 * 调用点的稳定身份（I-R6）：`file::函数!wrapper[第几次]`。
 *
 * 为什么不用 `file:line`：宿主会话实现会在 `client.ts` 里插入代码，
 * 行号一移动，正确修复就会把「未解析清单」打红。身份只随
 * 「文件 / 所在函数 / 调用哪个 wrapper / 该函数里的第几次」变化——
 * 新调用出现或旧调用消失仍然是可检出的（这正是清单要锁的东西）。
 */
export function callSiteIdentity(site: Pick<CallSite, 'file' | 'enclosingFunction' | 'wrapper' | 'occurrence'>): string {
  return `${site.file}::${site.enclosingFunction}!${site.wrapper}[${site.occurrence}]`
}

const WRAPPERS = new Set([
  'apiGet',
  'apiPost',
  'apiPut',
  'apiDelete',
  'apiUpload',
  'apiFetch',
  'fetchBlob',
  'fetch',
])

const WRAPPER_METHOD: Record<string, string> = {
  apiGet: 'GET',
  apiPost: 'POST',
  apiPut: 'PUT',
  apiDelete: 'DELETE',
  apiUpload: 'POST',
  fetchBlob: 'GET',
}

/** 已知的「配置地址拼接器」：取路径实参（candidateUrl 的第 2 个） */
const URL_BUILDERS = new Set(['apiUrl', 'candidateUrl'])

/**
 * 显式「宽类型」注解：`Record<…>` / `unknown` / `any` / `object` / 索引签名。
 * 带这种注解的变量，其初始化字面量并不能代表实际发送的字段集合
 * （可以在别处被赋值、展开、透传）→ 一律 fail-closed。
 */
const OPAQUE_TYPE_RE =
  /^\s*(Record\s*<|Partial\s*<Record|Readonly\s*<Record|unknown\b|any\b|object\b|\{\s*\[)/

/** 表达式源码里出现紧跟引号的 '?' → 它拼的是查询串而不是路径段 */
const QUERY_CONSTRUCTOR_RE = /["'`]\?/

export const WRAPPER_DEFINITION_FILE = 'src/api/client.ts'

function collectFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry)
    if (statSync(full).isDirectory()) {
      if (entry === 'node_modules') continue
      collectFiles(full, out)
      continue
    }
    if (!/\.tsx?$/.test(entry)) continue
    out.push(full)
  }
  return out
}

/* ── 作用域与绑定 ──────────────────────────────────────────── */

type Binding =
  | { kind: 'string'; value: string }
  /** `const path = \`/api/v1/x/${id}/y\`` → 已解析的路径模板 */
  | { kind: 'template-path'; text: string }
  | { kind: 'object'; keys: string[]; fields: BodyField[]; complete: boolean }
  /** 显式宽类型/无字面量：字段集合不可信 → fail-closed */
  | { kind: 'opaque'; reason: string }
  /** 声明类型 = generated 的具名请求类型（`components['schemas']['X']` 或其本地别名） */
  | { kind: 'typed-body'; schemaName: string }
  | { kind: 'formdata' }
  | { kind: 'query-string' }
  | { kind: 'url-params'; keys: Set<string> }

class Scope {
  private readonly vars = new Map<string, Binding>()
  constructor(private readonly parent: Scope | null) {}

  child(): Scope {
    return new Scope(this)
  }

  define(name: string, binding: Binding): void {
    this.vars.set(name, binding)
  }

  lookup(name: string): Binding | null {
    // 递归向上查，避免把 `this` 赋给局部变量（oxlint no-this-alias）
    const own = this.vars.get(name)
    if (own) return own
    return this.parent === null ? null : this.parent.lookup(name)
  }
}

/**
 * 静态求值一个「字符串字面量 / 字符串常量 / encodeURIComponent(字面量)」表达式。
 * 返回 null 表示无法静态判定。
 *
 * 为什么需要它：`${encodeURIComponent('../')}` 与 `?${k}=1`（k 是字符串常量）
 * 都是可静态求值的，不能让它们以「动态」为名绕过路径段/query 检查。
 */
function literalTextOf(expr: ts.Expression, scope: Scope): string | null {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) return expr.text
  if (ts.isIdentifier(expr)) {
    const b = scope.lookup(expr.text)
    return b?.kind === 'string' ? b.value : null
  }
  if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) {
    const fn = expr.expression.text
    if (fn === 'encodeURIComponent' || fn === 'decodeURIComponent') {
      const arg = expr.arguments[0]
      if (!arg) return null
      const inner = literalTextOf(arg, scope)
      if (inner === null) return null
      if (fn === 'encodeURIComponent') return encodeURIComponent(inner)
      try {
        return decodeURIComponent(inner)
      } catch {
        return null
      }
    }
  }
  return null
}

function propertyNameText(name: ts.PropertyName | undefined): string | null {
  if (!name) return null
  if (ts.isIdentifier(name)) return name.text
  if (ts.isStringLiteral(name)) return name.text
  return null
}

/** 静态判定一个表达式字面量的 JSON 形状 */
function valueKindOf(expr: ts.Expression): { valueKind: ValueKind; literal: string | null } {
  if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
    return { valueKind: 'string', literal: expr.text }
  }
  if (ts.isNumericLiteral(expr)) return { valueKind: 'number', literal: expr.text }
  if (expr.kind === ts.SyntaxKind.TrueKeyword) return { valueKind: 'boolean', literal: 'true' }
  if (expr.kind === ts.SyntaxKind.FalseKeyword) return { valueKind: 'boolean', literal: 'false' }
  if (expr.kind === ts.SyntaxKind.NullKeyword) return { valueKind: 'null', literal: null }
  if (ts.isObjectLiteralExpression(expr)) return { valueKind: 'object', literal: null }
  if (ts.isArrayLiteralExpression(expr)) return { valueKind: 'array', literal: null }
  if (
    ts.isPrefixUnaryExpression(expr) &&
    expr.operator === ts.SyntaxKind.MinusToken &&
    ts.isNumericLiteral(expr.operand)
  ) {
    return { valueKind: 'number', literal: `-${expr.operand.text}` }
  }
  return { valueKind: 'unknown', literal: null }
}

function objectLiteralFields(obj: ts.ObjectLiteralExpression): {
  fields: BodyField[]
  complete: boolean
} {
  const fields: BodyField[] = []
  let complete = true
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop)) {
      const n = propertyNameText(prop.name)
      if (!n) {
        complete = false
        continue
      }
      const { valueKind, literal } = valueKindOf(prop.initializer)
      if (!fields.some((f) => f.name === n)) fields.push({ name: n, valueKind, literal })
      continue
    }
    if (ts.isShorthandPropertyAssignment(prop)) {
      const n = prop.name.text
      if (!fields.some((f) => f.name === n)) {
        fields.push({ name: n, valueKind: 'unknown', literal: null })
      }
      continue
    }
    // spread / 方法 / 访问器：交给调用方按作用域展开，或标记不完整
    complete = false
  }
  return { fields, complete }
}

/** 函数体是否明显在拼查询串（`new URLSearchParams` / 以 '?' 开头的模板） */
function bodyLooksLikeQueryString(body: ts.Node | undefined): boolean {
  if (!body) return false
  const text = body.getText()
  return text.includes('URLSearchParams') || QUERY_CONSTRUCTOR_RE.test(text)
}

function findProp(obj: ts.ObjectLiteralExpression, name: string): ts.Expression | undefined {
  for (const prop of obj.properties) {
    if (ts.isPropertyAssignment(prop) && propertyNameText(prop.name) === name) {
      return prop.initializer
    }
  }
  return undefined
}

/* ── 路径实参分析 ──────────────────────────────────────────── */

interface PathAnalysis {
  text: string | null
  raw: string
  resolution: CallSite['resolution']
}

type TemplateAnalysis =
  | { kind: 'path'; text: string }
  | { kind: 'query'; text: string; enumerable: boolean }
  | { kind: 'ambiguous'; text: string }

/**
 * 模板字面量分两段：路径段与 query 段。判定必须状态化，否则会把
 * `/a/b/${id}` 这种正常路径参数误判成「未知尾部」，或把 query 拼进路径。
 *   - 累积的路径里一旦出现 '?' → 已进入 query 段（字面量 query 的常见写法）；
 *   - 路径段里前一个片段以 '/' 结尾 → 该表达式是路径参数；
 *   - 绑定是字符串/已解析模板 → 直接替换成字面量；
 *   - 绑定是 URLSearchParams → 键名可枚举，转入 query；
 *   - 绑定或表达式是查询串构造器 → 转入 query，键名不可枚举；
 *   - 其余（如 `/a/b${x}` 且 x 无法判定）→ UNKNOWN（$TAIL），不当成违规也不当成 PASS。
 */
function analyzeTemplate(tpl: ts.TemplateExpression, scope: Scope): TemplateAnalysis {
  let pathPart = ''
  let queryPart: string | null = null
  let queryEnumerable = true

  const head = tpl.head.text
  const headQ = head.indexOf('?')
  if (headQ === -1) pathPart = head
  else {
    pathPart = head.slice(0, headQ)
    queryPart = head.slice(headQ + 1)
  }

  let ambiguousTail = false

  for (const span of tpl.templateSpans) {
    const lit = span.literal.text
    const expr = span.expression
    const binding = ts.isIdentifier(expr) ? scope.lookup(expr.text) : null
    /** 表达式是本地查询串构造函数的调用（如 locQ(params)）→ 键名不可枚举 */
    const callsQueryStringFn =
      ts.isCallExpression(expr) &&
      ts.isIdentifier(expr.expression) &&
      scope.lookup(expr.expression.text)?.kind === 'query-string'

    if (queryPart === null && pathPart.includes('?')) {
      const qi = pathPart.indexOf('?')
      queryPart = pathPart.slice(qi + 1)
      pathPart = pathPart.slice(0, qi)
    }

    if (queryPart !== null) {
      // 字面量片段进 query：参数名可以静态看到（`?${'auditProbe'}=1`）
      if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
        queryPart = `${queryPart ?? ''}${expr.text}${lit}`
        continue
      }
      // 字符串常量 / encodeURIComponent(字面量) 同样可以静态求值：
      // `const k = 'auditProbe'` 的 `?${k}=1` 不能被当成「动态 query」放过去。
      const qLit = literalTextOf(expr, scope)
      if (qLit !== null) {
        queryPart = `${queryPart ?? ''}${qLit}${lit}`
        continue
      }
      if (queryEnumerable) {
        if (binding?.kind === 'url-params' && binding.keys.size > 0) {
          const extra = [...binding.keys].map((k) => `${k}=$V`).join('&')
          queryPart = queryPart ? `${queryPart}&${extra}` : extra
        } else if (!queryPart) {
          queryEnumerable = false
        }
      }
      if (lit) queryPart = `${queryPart ?? ''}$V${lit}`
      else if (!queryEnumerable) queryPart = `${queryPart ?? ''}$V`
      continue
    }

    if (binding?.kind === 'string') {
      pathPart += binding.value + lit
      continue
    }
    if (binding?.kind === 'template-path') {
      pathPart += binding.text + lit
      continue
    }
    // 字面量片段（`${'../admin'}` / `${'a?b'}`）：直接代入，避免「用字面量就能绕过检查」
    if (ts.isStringLiteral(expr) || ts.isNoSubstitutionTemplateLiteral(expr)) {
      pathPart += expr.text + lit
      continue
    }
    if (ts.isNumericLiteral(expr)) {
      pathPart += expr.text + lit
      continue
    }
    // `encodeURIComponent('../')` 这类可静态求值的表达式：代入真实文本，
    // 由判定层按「解码后的段」判非法遍历（不能收成 `${...}` 就当没事）。
    const pLit = literalTextOf(expr, scope)
    if (pLit !== null) {
      pathPart += pLit + lit
      continue
    }
    if (binding?.kind === 'url-params' && binding.keys.size > 0) {
      queryPart = [...binding.keys].map((k) => `${k}=$V`).join('&')
      continue
    }
    if (binding?.kind === 'opaque') {
      // 宽类型绑定拼进路径：无法判定它落在路径段还是 query → UNKNOWN（不猜）
      pathPart += `${TAIL_SENTINEL}${lit}`
      ambiguousTail = true
      break
    }
    if (binding?.kind === 'query-string' || callsQueryStringFn || QUERY_CONSTRUCTOR_RE.test(expr.getText())) {
      queryPart = ''
      queryEnumerable = false
      continue
    }
    if (pathPart.endsWith('/')) {
      pathPart += '${...}' + lit
      continue
    }
    ambiguousTail = true
    break
  }

  if (ambiguousTail) return { kind: 'ambiguous', text: `${pathPart}${TAIL_SENTINEL}` }
  if (queryPart !== null) {
    const q = queryEnumerable ? queryPart : DYNAMIC_QUERY_SENTINEL
    return { kind: 'query', text: `${pathPart}?${q}`, enumerable: queryEnumerable }
  }
  return { kind: 'path', text: pathPart }
}

function analyzePathArg(arg: ts.Expression | undefined, scope: Scope): PathAnalysis {
  if (!arg) return { text: null, raw: '', resolution: 'unresolved' }

  // apiUrl('/x') / candidateUrl(base, '/x')
  if (ts.isCallExpression(arg)) {
    const callee = arg.expression
    const name = ts.isIdentifier(callee) ? callee.text : null
    if (name && URL_BUILDERS.has(name)) {
      const inner = name === 'candidateUrl' ? arg.arguments[1] : arg.arguments[0]
      const res = analyzePathArg(inner, scope)
      return { ...res, resolution: res.text ? 'local-const' : 'unresolved' }
    }
    return { text: null, raw: arg.getText(), resolution: 'unresolved' }
  }

  if (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg)) {
    return { text: arg.text, raw: arg.text, resolution: 'string-literal' }
  }

  if (ts.isTemplateExpression(arg)) {
    const r = analyzeTemplate(arg, scope)
    return {
      text: r.text,
      raw: arg.getText(),
      resolution: r.kind === 'ambiguous' ? 'partial' : 'template',
    }
  }

  if (ts.isIdentifier(arg)) {
    const b = scope.lookup(arg.text)
    if (b?.kind === 'string') {
      return { text: b.value, raw: arg.getText(), resolution: 'local-const' }
    }
    if (b?.kind === 'template-path') {
      return { text: b.text, raw: arg.getText(), resolution: 'local-const' }
    }
    if (b?.kind === 'url-params' && b.keys.size > 0) {
      // 形如 apiGet(path) 且 path 是查询串：路径无法判定
      return { text: `${TAIL_SENTINEL}`, raw: arg.getText(), resolution: 'partial' }
    }
    return { text: null, raw: arg.getText(), resolution: 'unresolved' }
  }

  return { text: null, raw: arg.getText(), resolution: 'unresolved' }
}

/* ── 请求体分析 ───────────────────────────────────────────── */

/**
 * generated 请求类型的引用形式：`components['schemas']['CreateEventRequest']`
 * （单/双引号都可以）。这是 openapi-typescript 生成的写法，不另立第二套协议。
 */
function generatedSchemaNameIn(typeText: string): string | null {
  const m =
    /components\s*\[\s*['"]schemas['"]\s*\]\s*\[\s*['"]([A-Za-z0-9_]+)['"]\s*\]/.exec(typeText)
  return m ? m[1]! : null
}

/** 收集文件内的本地类型别名：`type Body = components['schemas']['X']` */
function collectTypeAliases(text: string): Map<string, string> {
  const aliases = new Map<string, string>()
  for (const m of text.matchAll(/\btype\s+([A-Za-z_$][\w$]*)\s*=\s*([^\n;]+)/g)) {
    const name = m[1]!
    if (!aliases.has(name)) aliases.set(name, m[2]!.trim())
  }
  return aliases
}

/**
 * 把一段**类型注解文本**解析成 generated 的 schema 名；解析不出返回 null。
 * 只认「具名生成类型」（含一层到几层的本地别名），不猜结构化类型。
 */
function resolveGeneratedSchema(
  typeText: string,
  aliases: Map<string, string>,
  depth = 0,
): string | null {
  const direct = generatedSchemaNameIn(typeText)
  if (direct !== null) return direct
  const t = typeText.trim()
  if (depth > 4 || !/^[A-Za-z_$][\w$]*$/.test(t)) return null
  const rhs = aliases.get(t)
  if (rhs === undefined) return null
  return resolveGeneratedSchema(rhs, aliases, depth + 1)
}

const EMPTY_BODY = {
  bodyKeys: null,
  bodyKind: 'none' as const,
  bodyFields: null,
  bodyOpaque: false,
  bodyOpaqueReason: null,
  bodySchemaType: null,
}

function analyzeBody(
  body: ts.Expression | undefined,
  scope: Scope,
): Pick<
  CallSite,
  'bodyKeys' | 'bodyKind' | 'bodyFields' | 'bodyOpaque' | 'bodyOpaqueReason' | 'bodySchemaType'
> {
  if (!body) return EMPTY_BODY

  if (ts.isObjectLiteralExpression(body)) {
    const fields: BodyField[] = []
    let complete = true
    let opaqueReason: string | null = null
    for (const prop of body.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const n = propertyNameText(prop.name)
        if (!n) {
          complete = false
          opaqueReason ??= '请求体含无法静态求名的属性'
          continue
        }
        const { valueKind, literal } = valueKindOf(prop.initializer)
        if (!fields.some((f) => f.name === n)) fields.push({ name: n, valueKind, literal })
        continue
      }
      if (ts.isShorthandPropertyAssignment(prop)) {
        const n = prop.name.text
        if (!fields.some((f) => f.name === n)) {
          fields.push({ name: n, valueKind: 'unknown', literal: null })
        }
        continue
      }
      if (ts.isSpreadAssignment(prop)) {
        const src = prop.expression
        const b = ts.isIdentifier(src) ? scope.lookup(src.text) : null
        if (b?.kind === 'object') {
          for (const f of b.fields) {
            if (!fields.some((x) => x.name === f.name)) fields.push(f)
          }
          if (!b.complete) {
            complete = false
            opaqueReason ??= '展开的对象自身含无法解析的成员'
          }
        } else if (b?.kind === 'opaque') {
          complete = false
          opaqueReason ??= `展开的是宽类型绑定 ${src.getText()}（${b.reason}）`
        } else {
          complete = false
          opaqueReason ??= `展开的表达式 ${src.getText()} 无法静态展开`
        }
        continue
      }
      complete = false
      opaqueReason ??= `请求体含不受支持的成员（${ts.SyntaxKind[prop.kind]}）`
    }
    return {
      bodyKeys: fields.map((f) => f.name),
      bodyKind: 'object-literal',
      bodyFields: fields,
      bodyOpaque: !complete,
      bodyOpaqueReason: complete ? null : (opaqueReason ?? '请求体字段清单不完整'),
      bodySchemaType: null,
    }
  }

  if (ts.isIdentifier(body)) {
    const b = scope.lookup(body.text)
    if (b?.kind === 'formdata') {
      return {
        bodyKeys: null,
        bodyKind: 'formdata',
        bodyFields: null,
        bodyOpaque: false,
        bodyOpaqueReason: null,
        bodySchemaType: null,
      }
    }
    if (b?.kind === 'object') {
      return {
        bodyKeys: b.fields.map((f) => f.name),
        bodyKind: 'object-literal',
        bodyFields: b.fields,
        bodyOpaque: !b.complete,
        bodyOpaqueReason: b.complete ? null : `${body.text} 的字段清单不完整`,
        bodySchemaType: null,
      }
    }
    if (b?.kind === 'typed-body') {
      // 声明类型就是 generated 的具名请求类型：字段集合由类型约束，交给判定层
      // 核对「它必须正是该 operation 的 requestBody schema」。
      return {
        bodyKeys: null,
        bodyKind: 'typed-request',
        bodyFields: null,
        bodyOpaque: false,
        bodyOpaqueReason: null,
        bodySchemaType: b.schemaName,
      }
    }
    return {
      bodyKeys: null,
      bodyKind: 'identifier',
      bodyFields: null,
      bodyOpaque: true,
      bodyOpaqueReason:
        b?.kind === 'opaque'
          ? `请求体标识符 ${body.text} 是宽类型绑定（${b.reason}），字段集合不可静态核对`
          : `请求体标识符 ${body.text} 没有可静态解析的对象字面量绑定，字段集合不可核对`,
      bodySchemaType: null,
    }
  }

  if (ts.isNewExpression(body)) {
    const callee = body.expression
    if (ts.isIdentifier(callee) && callee.text === 'FormData') {
      // multipart 的表单字段是 append 出来的，契约侧也没有对象 schema 可对；
      // 记录为不可核对，但不当作字段违规（不是「对象/Record/展开」那一类）。
      return {
        bodyKeys: null,
        bodyKind: 'formdata',
        bodyFields: null,
        bodyOpaque: false,
        bodyOpaqueReason: null,
        bodySchemaType: null,
      }
    }
  }

  // `body: JSON.stringify({ … })`：字面量对象照样可以核对
  if (
    ts.isCallExpression(body) &&
    ts.isPropertyAccessExpression(body.expression) &&
    body.expression.name.text === 'stringify'
  ) {
    const arg = body.arguments[0]
    if (arg && ts.isObjectLiteralExpression(arg)) return analyzeBody(arg, scope)
  }
  return {
    bodyKeys: null,
    bodyKind: 'identifier',
    bodyFields: null,
    bodyOpaque: true,
    bodyOpaqueReason: `请求体表达式 ${body.getText().slice(0, 40)} 无法解析成字段清单`,
    bodySchemaType: null,
  }
}

function baseLevelFor(relFile: string): BaseLevel {
  if (/\.test\.tsx?$/.test(relFile) || relFile.includes('__tests__')) return 'test'
  if (relFile === WRAPPER_DEFINITION_FILE) return 'wrapper-boundary'
  return 'business'
}

/**
 * client-web/src/api/client.ts 同时含两类东西：
 * - 裸 `fetch(...)`：统一封装真正发请求的位置 → transport；
 * - `apiGet`/`apiPost`/… 的函数体里调用 `apiFetch(path, …)`：封装自身的定义 →
 *   wrapper-definition，不与业务调用点混计（否则同一次业务调用会被算两次）。
 */
function perCallLevel(base: BaseLevel, wrapper: string): CallLevel {
  if (base === 'wrapper-boundary') return wrapper === 'fetch' ? 'transport' : 'wrapper-definition'
  return base === 'business' ? 'business' : 'test'
}

function isFunctionLike(node: ts.Node): node is ts.FunctionLikeDeclaration {
  return (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  )
}

/**
 * 包住调用的函数名（稳定身份用）。函数声明/表达式取自己的名字，
 * 匿名函数取绑定它的变量名或属性名，都没有则 `'<anonymous>'`。
 */
function functionNameOf(node: ts.Node): string {
  const named = node as { name?: ts.Node }
  if (named.name && ts.isIdentifier(named.name)) return named.name.text
  const parent = node.parent as ts.Node | undefined
  if (parent) {
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return parent.name.text
    if (
      (ts.isPropertyAssignment(parent) || ts.isPropertyDeclaration(parent)) &&
      ts.isIdentifier(parent.name)
    ) {
      return parent.name.text
    }
  }
  return '<anonymous>'
}

export function extractCallSites(root = CLIENT_WEB): CallSite[] {
  const srcDir = path.join(root, 'src')
  const files = collectFiles(srcDir)
  const sites: CallSite[] = []

  for (const full of files) {
    const rel = path.relative(root, full).split(path.sep).join('/')
    const baseLevel = baseLevelFor(rel)
    const text = readFileSync(full, 'utf8')
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX)

    const rootScope = new Scope(null)
    let scope = rootScope
    /** 稳定身份用：包住当前节点的函数名栈（模块顶层为空 → '<module>'） */
    const fnStack: string[] = []
    /** 文件内的本地类型别名（`type Body = components['schemas']['X']`） */
    const typeAliases = collectTypeAliases(text)

    const walk = (node: ts.Node): void => {
      const pushScope =
        isFunctionLike(node) ||
        ts.isBlock(node) ||
        ts.isModuleBlock(node) ||
        ts.isCaseBlock(node) ||
        ts.isForStatement(node) ||
        ts.isForOfStatement(node) ||
        ts.isForInStatement(node) ||
        ts.isSourceFile(node)

      const pushesFn = isFunctionLike(node)
      if (pushesFn) fnStack.push(functionNameOf(node))

      const prev = scope
      // 函数声明要登记在**外层**作用域，否则调用点（在外层）查不到它
      if (ts.isFunctionDeclaration(node) && node.name && bodyLooksLikeQueryString(node.body)) {
        prev.define(node.name.text, { kind: 'query-string' })
      }
      if (pushScope) scope = prev.child()

      /*
       * 函数参数的类型注解同样决定请求体能不能核对（PW-01/PW-13 的接受判据）：
       * - 注解是 generated 的具名请求类型 → typed-body（判定层再要求它就是该
       *   operation 的 requestBody schema）；
       * - 注解是宽类型（Record/any/unknown/object/索引签名）→ opaque，fail-closed；
       * - 其他（解不开的结构化类型）→ 不登记，落回「没有可解析绑定」的 fail-closed。
       * 参数只登记在**本次函数作用域**里，不会污染外层同名变量。
       */
      if (pushesFn) {
        for (const param of (node as ts.FunctionLikeDeclaration).parameters) {
          if (!ts.isIdentifier(param.name)) continue
          const declared = param.type?.getText() ?? null
          if (declared === null) continue
          if (OPAQUE_TYPE_RE.test(declared)) {
            scope.define(param.name.text, { kind: 'opaque', reason: `显式类型注解 ${declared}` })
            continue
          }
          const schemaName = resolveGeneratedSchema(declared, typeAliases)
          if (schemaName !== null) {
            scope.define(param.name.text, { kind: 'typed-body', schemaName })
          }
        }
      }

      // 变量声明 → 绑定
      if (ts.isVariableDeclaration(node)) {
        const init = node.initializer
        const name = node.name
        // 显式宽类型注解（Record<string, unknown> / unknown / object / 索引签名）：
        // 初始化字面量不代表实际发送的字段集合 → fail-closed。
        const declaredType = node.type?.getText() ?? null
        const opaqueType = declaredType !== null && OPAQUE_TYPE_RE.test(declaredType)
        // `const body: CreateEventRequest = …`（或 `components['schemas']['X']`）→ 具名生成类型
        const typedSchema =
          declaredType !== null && !opaqueType
            ? resolveGeneratedSchema(declaredType, typeAliases)
            : null

        const defineNamed = (id: string, binding: Binding): void => scope.define(id, binding)

        const literalValue = init ? literalTextOf(init, scope) : null

        if (ts.isIdentifier(name)) {
          if (opaqueType) {
            defineNamed(name.text, { kind: 'opaque', reason: `显式类型注解 ${declaredType}` })
          } else if (typedSchema !== null) {
            /*
             * 声明类型 = generated 的具名请求类型：字段集合由类型约束，不再靠
             * 初始化字面量「猜」；判定层仍要求它等于该 operation 的 requestBody schema。
             * 注意这条在 literalValue 之前：带注解的绑定不该被当成普通字符串常量。
             */
            defineNamed(name.text, { kind: 'typed-body', schemaName: typedSchema })
          } else if (literalValue !== null) {
            // 字符串常量 / encodeURIComponent(字面量)：可静态求值
            defineNamed(name.text, { kind: 'string', value: literalValue })
          } else if (init && ts.isNewExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'FormData') {
            // `const form = new FormData()` 之后 append 的字段属于 multipart，
            // 契约侧没有对象 schema 可对；标记为 formdata，不当成字段违规。
            defineNamed(name.text, { kind: 'formdata' })
          } else if (init && ts.isNewExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'URLSearchParams') {
            const keys = new Set<string>()
            const first = init.arguments?.[0]
            if (first && ts.isObjectLiteralExpression(first)) {
              for (const f of objectLiteralFields(first).fields) keys.add(f.name)
            }
            defineNamed(name.text, { kind: 'url-params', keys })
          } else if (init && ts.isObjectLiteralExpression(init)) {
            const o = objectLiteralFields(init)
            defineNamed(name.text, { kind: 'object', keys: o.fields.map((f) => f.name), fields: o.fields, complete: o.complete })
          } else if (init && (ts.isStringLiteral(init) || ts.isNoSubstitutionTemplateLiteral(init))) {
            defineNamed(name.text, { kind: 'string', value: init.text })
          } else if (init && ts.isTemplateExpression(init)) {
            const inner = analyzeTemplate(init, scope)
            if (inner.kind === 'path') {
              defineNamed(name.text, { kind: 'template-path', text: inner.text })
            } else if (inner.kind === 'query') {
              defineNamed(name.text, { kind: 'query-string' })
            } else {
              defineNamed(name.text, { kind: 'opaque', reason: '初始化模板无法静态判定' })
            }
          } else if (init && isFunctionLike(init) && bodyLooksLikeQueryString(init.body)) {
            defineNamed(name.text, { kind: 'query-string' })
          } else if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression)) {
            const fn = scope.lookup(init.expression.text)
            if (fn?.kind === 'query-string') defineNamed(name.text, { kind: 'query-string' })
          } else if (init && QUERY_CONSTRUCTOR_RE.test(init.getText())) {
            defineNamed(name.text, { kind: 'query-string' })
          }
        }

        // const [form, setForm] = useState({...})
        if (init && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'useState') {
          const first = init.arguments[0]
          if (first && ts.isObjectLiteralExpression(first)) {
            const o = objectLiteralFields(first)
            const binding: Binding = { kind: 'object', keys: o.fields.map((f) => f.name), fields: o.fields, complete: o.complete }
            if (ts.isArrayBindingPattern(name)) {
              const el = name.elements[0]
              if (el && ts.isBindingElement(el) && ts.isIdentifier(el.name)) {
                scope.define(el.name.text, binding)
              }
            } else if (ts.isIdentifier(name)) {
              scope.define(name.text, binding)
            }
          }
        }
      }

      if (ts.isCallExpression(node)) {
        const callee = node.expression

        // `q.set('k', …)` → 补进 url-params 键集合
        if (
          ts.isPropertyAccessExpression(callee) &&
          callee.name.text === 'set' &&
          ts.isIdentifier(callee.expression)
        ) {
          const b = scope.lookup(callee.expression.text)
          const key = node.arguments[0]
          if (b?.kind === 'url-params' && key && ts.isStringLiteral(key)) b.keys.add(key.text)
        }

        const name = ts.isIdentifier(callee) ? callee.text : null
        if (name && WRAPPERS.has(name)) {
          const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
          const args = node.arguments
          let method = WRAPPER_METHOD[name] ?? 'GET'
          let pathArg: ts.Expression | undefined
          let body: ts.Expression | undefined

          if (name === 'apiFetch' || name === 'fetch') {
            pathArg = args[0]
            const init = args[1]
            if (init && ts.isObjectLiteralExpression(init)) {
              const m = findProp(init, 'method')
              if (m && ts.isStringLiteral(m)) method = m.text
              body = findProp(init, 'body')
              if (name === 'fetch' && !m && body) method = 'POST'
              if (name === 'apiFetch' && method === 'GET' && body) method = 'POST'
            }
          } else if (name === 'apiPost' || name === 'apiPut' || name === 'apiUpload') {
            pathArg = args[0]
            body = args[1]
          } else {
            pathArg = args[0]
          }

          const p = analyzePathArg(pathArg, scope)
          const b = analyzeBody(body, scope)
          sites.push({
            file: rel,
            line,
            enclosingFunction: fnStack.length > 0 ? fnStack[fnStack.length - 1]! : '<module>',
            occurrence: -1, // 下面按文件+函数+wrapper 统一编号
            level: perCallLevel(baseLevel, name),
            wrapper: name,
            method,
            pathTemplate: p.text,
            resolution: p.resolution,
            rawPathText: p.raw,
            ...b,
          })
        }
      }

      ts.forEachChild(node, walk)

      if (pushScope) scope = prev
      if (pushesFn) fnStack.pop()
    }

    walk(sf)
  }

  /*
   * 稳定身份的第二半：同一文件 + 同一函数 + 同一 wrapper 的第几次调用。
   * 按抽取顺序（源码顺序）编号，与行号无关。
   */
  const counters = new Map<string, number>()
  for (const s of sites) {
    const key = `${s.file}::${s.enclosingFunction}!${s.wrapper}`
    const n = counters.get(key) ?? 0
    s.occurrence = n
    counters.set(key, n + 1)
  }

  return sites.sort((a, b) => (a.file === b.file ? a.line - b.line : a.file < b.file ? -1 : 1))
}
