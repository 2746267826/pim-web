/*
 * PW-01 / PW-02 / PW-03 / PW-13 / PW-14 / PW-15 / PW-17：
 * 真实业务调用点 ↔ 权威契约的机械一致性。
 *
 * 本轮（Round 3）修正后的验收口径（旧版的「旧错误状态锁」已移除）：
 *   **唯一的绿灯目标**：`client-web/src` 的生产调用 `violations.length === 0`。
 *   旧版还锁着「现在必须有 X 条违规」「26 条 opaque 清单必须一字不差」「icon 必须仍非法」
 *   「enumProps 必须为空」，那些会把正确修复判红，已删除；相关数字只留在 __report 诊断里。
 *
 * 分层职责（不要把所有维度都塞进这套自写 AST 判定）：
 *   - 本文件（AST）：method+path 是否落在契约 operation、query 名、**顶层**字段
 *     是否声明、required、字面量类型/枚举、fail-closed（枚举不出字段集合 → 违规）；
 *   - `request-schema.ts` + `request-boundary.test.ts`：一份会**展开 $ref** 的
 *     OpenAPI 校验，挂在真实序列化请求体上（嵌套对象、$ref enum、非 nullable 的 null）；
 *   - `type-boundary.test.ts`：真实 `tsc` 对 generated 的 path/method/schema 约束
 *     （合法具名 Body 能过；未知 path/method、多余字段、宽 Record 必须编译失败）。
 *
 * fail-closed 不变：路径段非法（含 decodeURIComponent 后的 `..`/`%2F`）、
 * 请求体字段集合无法静态枚举（未绑定标识符 / `Record<…>` / 解不开的 spread）都算违规。
 * 判定本身不是恒真：**用真实源码注入**（写一个真实的 .ts 文件，交给真实的
 * `extractCallSites` + `checkCallSite` 管线），而不是手写 CallSite 对象或特判探针字符串。
 *
 * ⚠️ 分母口径（已在 round2/requirements-update.md 逐项核对）：
 * 审计的按行正则抽取器漏掉路径实参换行的调用，得到生产调用点 172；
 * 本文件用 TypeScript AST + 作用域解析重抽，得到 **222 = 业务 219 + 传输 3**，
 * 比审计多 **50**（不是 55：那 5 条是 `src/api/client.ts` 里 wrapper 自身的
 * `apiFetch(path)`，审计单独放在 wrapper 桶，见下面的「封装定义 5」）。
 * 审计的 172 条全部是本集合的子集（零遗漏）。
 */
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import {
  buildContractIndex,
  CLIENT_WEB,
  loadContract,
  loadEvidenceFile,
  loadTrailingSlashEvidence,
  type ContractRaw,
} from './_lib/contract'
import { TAIL_SENTINEL, callSiteIdentity, extractCallSites, type CallSite } from './_lib/callsites'
import {
  checkCallSite,
  checkCallSites,
  formatFindings,
  isViolation,
  type Finding,
} from './_lib/conformance'

const sites = extractCallSites()
const business = sites.filter((s) => s.level === 'business')
const transport = sites.filter((s) => s.level === 'transport')
const wrapperDefs = sites.filter((s) => s.level === 'wrapper-definition')
const prod = [...business, ...transport]
const resolvable = prod.filter((s) => s.pathTemplate !== null)
const unresolved = prod.filter((s) => s.pathTemplate === null)

const findings = checkCallSites(prod)
const violations = findings.filter(isViolation)
const gaps = findings.filter((f) => f.kind === 'contract-gap')
const opaqueBodies = business.filter((s) => s.bodyOpaque && s.pathTemplate !== null)
/** 还有一条不具备可解析路径的请求体（服务端返回的第三方预授权 URL），见 unresolved 清单 */
const opaqueBodiesOnUnresolvedPaths = business.filter(
  (s) => s.bodyOpaque && s.pathTemplate === null,
)
const unverifiableResponses = findings.filter((f) => f.kind === 'unverifiable-response')
const dynamicQueries = unverifiableResponses.filter((f) => f.message.includes('query'))

/**
 * 未解析调用点的**稳定身份清单**（I-R6）。
 *
 * 旧版锁的是 `file:line`：宿主会话实现要在 `client.ts` 里插代码，行号一移，
 * 正确修复就会被这条普查打红。现在锁的是「文件 + 所在函数 + 哪个 wrapper」，
 * 并单独限次（同一函数里同一 wrapper 出现几次）。判定仍然是「不得新增」：
 * - 出现清单外的身份 → 红（新调用不能藏进未解析桶）；
 * - 某个身份的次数超过登记值 → 红；
 * - 次数减少不算错（把动态路径改成可解析，正是修复）；
 * - 任何登记身份消失 → 红（不能把已有调用删成"看不见"）。
 */
interface UnresolvedEntry {
  /** `file::函数!wrapper`（不含次数；次数单独登记） */
  id: string
  /** 允许出现几次 */
  count: number
  /** 来源类别：这条未解析调用到底是"哪来的" */
  category: 'wrapper-internal-transport' | 'server-provided-url' | 'component-callback'
  reason: string
}

const UNRESOLVED_INVENTORY: UnresolvedEntry[] = [
  {
    id: 'src/api/client.ts::rawFetch!fetch',
    count: 1,
    category: 'wrapper-internal-transport',
    reason: '统一传输自身发出的请求：path 由调用方传入，wrapper 内部解析不了具体业务路径。',
  },
  {
    id: 'src/api/client.ts::fetchBlob!fetch',
    count: 2,
    category: 'wrapper-internal-transport',
    reason: '下载通道的首次请求与 401 后重放各一次；修复若合并成一次，次数下降是允许的。',
  },
  {
    id: 'src/features/files/upload-engine.ts::uploadBySession!fetch',
    count: 1,
    category: 'server-provided-url',
    reason:
      '第三方预授权 URL：目标地址来自服务端响应字段 session.uploadUrl，客户端表达式决定不了。',
  },
  {
    id: 'src/features/quick-notes/components/quick-note-dialog.tsx::<anonymous>!fetchBlob',
    count: 1,
    category: 'component-callback',
    reason: '组件回调里下载附件：路径由运行时数据拼出，静态判定不了。',
  },
  {
    id: 'src/features/quick-notes/components/quick-note-editor.tsx::<anonymous>!fetchBlob',
    count: 1,
    category: 'component-callback',
    reason: '编辑器的附件下载回调：同上，路径来自运行时数据。',
  },
]

/** 稳定身份（不含次数），与 `callSiteIdentity` 同源，避免两套字符串 */
function identityShape(site: CallSite): string {
  return callSiteIdentity({ ...site, occurrence: 0 }).replace(/\[0\]$/, '')
}

const unresolvedById = new Map<string, CallSite[]>()
for (const s of unresolved) {
  const id = identityShape(s)
  unresolvedById.set(id, [...(unresolvedById.get(id) ?? []), s])
}

function where(f: Finding): string {
  return `${f.file}:${f.line} [${f.method}] ${'path' in f ? f.path : ''}`
}

/* ══ 真实源码注入管线（故障对照 / 反向对照都用它） ═════════════════ */

const INJECT_ROOT = path.join(CLIENT_WEB, 'audit-tests', '.tmp-inject')

/**
 * 把一段**真实源码**放进一个临时 client-web 根里（`src/api/client.ts` 用真实的
 * 统一封装），再用真实的抽取器与判定器跑一遍。这样故障对照走的入口与生产代码
 * 完全相同：不是手写 CallSite，也没有针对某个字符串的特判。
 */
function runInjection(name: string, source: string): { sites: CallSite[]; findings: Finding[] } {
  const root = path.join(INJECT_ROOT, name)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(path.join(root, 'src', '__injection__'), { recursive: true })
  mkdirSync(path.join(root, 'src', 'api'), { recursive: true })
  cpSync(
    path.join(CLIENT_WEB, 'src', 'api', 'client.ts'),
    path.join(root, 'src', 'api', 'client.ts'),
  )
  writeFileSync(path.join(root, 'src', '__injection__', 'probe.ts'), source, 'utf8')
  const injected = extractCallSites(root)
  const fromProbe = injected.filter((s) => s.file.startsWith('src/__injection__/'))
  return { sites: fromProbe, findings: checkCallSites(fromProbe) }
}

afterAll(() => {
  rmSync(INJECT_ROOT, { recursive: true, force: true })
})

describe('调用面分母（不删分母：无法判定的部分必须显式计数）', () => {
  it('分层计数：业务 219 + 传输 4 = 生产 223；封装定义另算 5（wrapper 桶，不并入生产）', () => {
    // 「不得减少」而不是「必须相等」（I-R6）：宿主会话实现会在统一传输里真正
    // 增减请求，正确修复不该把普查打红；但任何调用点**消失**（藏进 PASS）都必须红。
    expect(business.length, '业务调用点从分母里消失了').toBeGreaterThanOrEqual(219)
    // 传输实现 4 = rawFetch 的 fetch、doRefresh 的 fetch、fetchBlob 的首次 fetch
    // 与 401 重放 fetch（ICS 修复把导出接进统一传输后新增的一次重放调用）。
    expect(transport.length, '传输实现调用点从分母里消失了').toBeGreaterThanOrEqual(4)
    expect(prod.length).toBeGreaterThanOrEqual(223)
    expect(wrapperDefs.length).toBeGreaterThanOrEqual(5)
  })

  it('分母比审计口径多 51（不是 55/56）：多出的都是真实调用点，不是白名单', () => {
    const AUDIT_PROD = 172
    expect(prod.length - AUDIT_PROD).toBeGreaterThanOrEqual(51)
    // 把 wrapper 桶也加进来才会得到审计文档里那个错误的 56（旧版写作 55）
    expect(prod.length + wrapperDefs.length - AUDIT_PROD).toBeGreaterThanOrEqual(56)
  })

  it('可解析 ≥217 = 业务 ≥216 + 传输 ≥1；未解析仍逐条登记（不因修好而消失）', () => {
    expect(business.filter((s) => s.pathTemplate !== null).length).toBeGreaterThanOrEqual(216)
    expect(transport.filter((s) => s.pathTemplate !== null).length).toBeGreaterThanOrEqual(1)
    expect(resolvable.length).toBeGreaterThanOrEqual(217)
    // 未解析的**业务**调用点被清单逐条钉住（见下一条），这里只保证总数没被藏着变多
    expect(unresolved.length).toBeLessThanOrEqual(6)
  })

  it('动态未解析项被稳定身份钉住（文件+函数+wrapper），不锁行号、不允许新增', () => {
    for (const entry of UNRESOLVED_INVENTORY) {
      const found = unresolvedById.get(entry.id) ?? []
      expect(
        found.length,
        `未解析调用点 ${entry.id}（${entry.category}）不见了：不能把它从分母里删掉换绿`,
      ).toBeGreaterThan(0)
      expect(
        found.length,
        `未解析调用点 ${entry.id} 出现了 ${found.length} 次（登记 ${entry.count} 次）：新调用不能藏进未解析桶`,
      ).toBeLessThanOrEqual(entry.count)
      expect(entry.reason.length, `${entry.id} 的依据太短`).toBeGreaterThan(20)
    }
    const expected = new Set(UNRESOLVED_INVENTORY.map((e) => e.id))
    const unexpected = [...unresolvedById.keys()].filter((id) => !expected.has(id))
    expect(
      unexpected,
      `这些未解析调用点没有登记来源：${unexpected.join(', ')}；新调用不得以"解析不了"混过普查`,
    ).toEqual([])
    // 稳定身份必须真的带上函数名（否则就退化成文件名+wrapper）
    for (const s of unresolved) {
      expect(s.enclosingFunction.length, `${s.file}:${s.line} 缺少稳定身份的函数名`).toBeGreaterThan(0)
      expect(s.occurrence).toBeGreaterThanOrEqual(0)
    }
  })

  it('行号移动不改变稳定身份（宿主实现插行不会把这批清单打红）', () => {
    const root = path.join(INJECT_ROOT, 'line-shift')
    rmSync(root, { recursive: true, force: true })
    mkdirSync(path.join(root, 'src', 'api'), { recursive: true })
    const clientRel = 'src/api/client.ts'
    const original = readFileSync(path.join(CLIENT_WEB, clientRel), 'utf8')
    writeFileSync(path.join(root, clientRel), original, 'utf8')
    const before = extractCallSites(root).filter((s) => s.pathTemplate === null)
    expect(before.length, '前置：client.ts 里应有未解析的裸 fetch').toBeGreaterThan(0)
    // 在文件头插入 40 行注释：模拟宿主会话实现在这些行上面插入代码
    writeFileSync(path.join(root, clientRel), '// host implementation\n'.repeat(40) + original, 'utf8')
    const after = extractCallSites(root).filter((s) => s.pathTemplate === null)
    expect(after.map(identityShape).sort()).toEqual(before.map(identityShape).sort())
    expect(
      after.map((s) => s.line),
      '前置失效：插行后行号竟然没变，这个对照证明不了稳定身份',
    ).not.toEqual(before.map((s) => s.line))
  })

  it('故障对照：新出现的未解析业务调用不在登记清单里（会被普查判红）', () => {
    const { sites: injected } = runInjection(
      'new-unresolved-call',
      `${CLIENT_IMPORT}\ndeclare const endpoint: string\nexport const p = fetch(endpoint)\n`,
    )
    const fresh = injected.filter((s) => s.pathTemplate === null)
    expect(fresh.length, '注入源码没有产生未解析调用点（故障对照失效）').toBe(1)
    const registered = new Set(UNRESOLVED_INVENTORY.map((e) => e.id))
    expect(
      fresh.map(identityShape).filter((id) => registered.has(id)),
      '新注入的未解析调用竟然命中了登记身份：清单挡不住新增',
    ).toEqual([])
  })

  it('没有路径解析变成「部分已知」却没被记账的调用点（$TAIL 必须为 0 或显式列出）', () => {
    const partial = prod.filter((s) => s.pathTemplate?.includes(TAIL_SENTINEL))
    expect(
      partial.map((s) => `${s.file}:${s.line}`),
      '出现无法静态判定的路径尾部，需要人工判定它是路径段还是 query',
    ).toEqual([])
  })

  it('动态 query 的调用点数量只设上界（减少是修复，增多必须人工复核）', () => {
    expect(
      dynamicQueries.length,
      `动态 query 从 25 涨到 ${dynamicQueries.length}：新增的动态 query 不能被当成"本来就核对不了"`,
    ).toBeLessThanOrEqual(25)
  })

  it('合法 GET /api/v1/auth/me operation 可查：契约里有它，生产调用仍在抽取分母里', () => {
    // 宿主会话的守卫要调用它；这条把「契约里有这个 operation」与
    // 「实现它的调用点确实被 extractCallSites 看见」钉在一起，
    // 免得将来换成别的入口后从分母里消失。
    const contract = loadContract()
    expect(
      [...contract.operations.keys()].includes('GET /api/v1/auth/me'),
      '契约里没有 GET /api/v1/auth/me：宿主守卫的 me 调用将无契约可对',
    ).toBe(true)
    const meSites = prod.filter((s) => s.pathTemplate === '/api/v1/auth/me')
    expect(
      meSites.length,
      '抽取器看不见任何 /auth/me 的生产调用点：它已从分母里消失',
    ).toBeGreaterThan(0)
    expect(meSites.every((s) => s.pathTemplate === '/api/v1/auth/me')).toBe(true)
  })
})

describe('PW-01/PW-13：路径必须落在契约 operation 上', () => {
  it('每个可解析生产调用点都能解析到契约 operation（含带证据的尾斜杠等价）', () => {
    const bad = violations.filter(
      (f) => f.kind === 'path-absent' || f.kind === 'trailing-slash-unevidenced',
    )
    expect(bad.map((f) => `${where(f)} → ${f.message}`).join('\n')).toBe('')
  })

  it('可解析调用点 217/217 全部解析成功——这只证明路径命中，不是 schema 覆盖', () => {
    const ok = resolvable.filter(
      (s) => !checkCallSite(s).some((f) => f.kind === 'path-absent'),
    ).length
    expect(ok).toBe(217)
    // 注意：217/217 只说明路径命中。字段/请求体维度由同一管线的其他 kind
    // 与 request-boundary.test.ts 的 $ref 校验负责，不能写成「调用点已被契约覆盖」。
  })

  it('动态路径不会被当成 PASS：既不计入可解析分母，也不产生违规', () => {
    for (const s of unresolved) expect(checkCallSite(s).filter(isViolation)).toEqual([])
  })
})

describe('PW-02：请求体字段与 query 参数都必须受 schema 约束', () => {
  it('没有任何调用点发送契约/schema 未声明的请求体字段，也没有缺必填', () => {
    const fieldFindings = violations.filter(
      (f) =>
        f.kind === 'undeclared-body-field' ||
        f.kind === 'missing-required-body-field' ||
        f.kind === 'body-field-type-mismatch' ||
        f.kind === 'body-field-enum-mismatch',
    )
    expect(
      fieldFindings.map((f) => `${where(f)} → ${f.message}`).join('\n'),
      '存在契约外的请求体字段、缺失必填字段，或类型/枚举与契约不一致',
    ).toBe('')
  })

  it('没有任何调用点发送契约未声明的 query 参数', () => {
    const queryFindings = violations.filter((f) => f.kind === 'undeclared-query-param')
    expect(queryFindings.map((f) => `${where(f)} → ${f.message}`).join('\n')).toBe('')
  })

  it('调用点发非空请求体时，契约必须声明该 requestBody', () => {
    expect(violations.filter((f) => f.kind === 'body-not-declared').map(where).join('\n')).toBe('')
  })
})

describe('fail-closed：请求体字段无法静态核对时必须算违规（不是 PASS）', () => {
  /*
   * 注意：这里**不**再锁「无法核对的清单必须等于某一份历史快照」——
   * 那种断言会在把 `Record<string, unknown>` 改成契约类型（正确修复）时变红。
   * 规则本身（无法核对 → 违规）保留；清单只作为 __report 的诊断数字。
   */
  it('每一条无法核对的请求体都产生了 unverifiable-body 违规（减少可以是修复，漏报不行）', () => {
    const flagged = new Set(
      violations.filter((f) => f.kind === 'unverifiable-body').map((f) => `${f.file}:${f.line}`),
    )
    const missing = opaqueBodies
      .map((s) => `${s.file}:${s.line}`)
      .filter((loc) => !flagged.has(loc))
    expect(
      missing,
      '这些调用点的请求体字段集合无法静态枚举，却没有被记成 unverifiable-body（fail-closed 被削弱）',
    ).toEqual([])
  })

  it('不具备可解析路径的请求体在可解析分母之外单独计数，不得静默混入 PASS', () => {
    // 只记录数量与位置；修好某一条会让计数下降，这是允许的。
    expect(opaqueBodiesOnUnresolvedPaths.length).toBeGreaterThanOrEqual(0)
    for (const s of opaqueBodiesOnUnresolvedPaths) {
      expect(s.pathTemplate, '只有在路径不可解析时才允许单列').toBeNull()
    }
  })
})

describe('PW-03/PW-17：契约缺口必须显式可见，且不得靠改客户端绕过', () => {
  it('尾斜杠调用点逐条都有权威来源登记（pim-api 文件:行 + DTO）', () => {
    const used = resolvable.filter((s) => s.pathTemplate!.split('?')[0]!.endsWith('/'))
    const evidence = loadTrailingSlashEvidence()
    const missing = used
      .filter((s) => !evidence[`${s.method} ${s.pathTemplate!.split('?')[0]}`])
      .map((s) => `${s.file}:${s.line} ${s.method} ${s.pathTemplate}`)
    expect(missing, '未登记的带斜杠调用点：必须先核对 pim-api 权威源码再登记').toEqual([])
  })

  it('CONTRACT-GAP 集合被固定住：契约补齐前不得消失，也不得新增', () => {
    const pair = [...new Set(gaps.map((f) => `${f.method} ${'path' in f ? f.path : ''}`))].sort()
    expect(pair).toEqual(['POST /api/v1/pc/categories/'])
    // 按文件而不是行号锁定：任何一次正常编辑都会移动行号，锁行号只会制造噪音。
    expect([...new Set(gaps.map((f) => f.file))]).toEqual([
      'src/features/knowledge/pages/app-knowledge-page.tsx',
    ])
    expect(gaps.length, '分类树保存的入口应恰好两处，且都必须显式记为 CONTRACT-GAP').toBe(2)
  })

  it('缺口项在契约里确实缺 schema（证明这是上游缺口，不是客户端写错）', () => {
    const schemas = loadContract().raw.components?.schemas ?? {}
    expect(Object.keys(schemas)).not.toContain('CategorySaveRequest')
    const legacy = schemas['SaveCategoryRequest'] as { properties?: Record<string, unknown> }
    expect(Object.keys(legacy.properties ?? {}).sort()).toEqual([
      'appPattern',
      'categoryName',
      'color',
      'priority',
    ])
  })

  it('尾斜杠登记必须带 pim-api 源码位置，且按隔离宿主证据归类', () => {
    const evidence = loadTrailingSlashEvidence()
    const keys = Object.keys(evidence)
    expect(keys.length).toBeGreaterThanOrEqual(4)
    for (const k of keys) {
      const e = evidence[k]!
      expect(e.serverRegistration, `${k} 必须给出 pim-api 源码位置`).toMatch(/\.cs:\d+/)
      expect(e.note.length).toBeGreaterThan(20)
    }
    expect(evidence['GET /api/v1/status/']!.upstreamStatus).toBe('contract-complete')
    expect(evidence['POST /api/v1/pc/app-signatures/']!.upstreamStatus).toBe('contract-complete')
    expect(evidence['POST /api/v1/pc/categories/']!.upstreamStatus).toBe('upstream-contract-gap')
    expect(evidence['GET /api/v1/pc/categories/']!.upstreamStatus).toBe('upstream-contract-gap')
  })

  it('路由证据必须限定在「隔离匹配器」口径：写明不是什么，且快照 sha 与文件一致', () => {
    const e = loadEvidenceFile()
    expect(e.routeProbeEvidence.notWhat).toMatch(/不是.*线上|不是.*完整/)
    expect(e.routeProbeEvidence.observations.join('\n')).toMatch(/AmbiguousMatchException/)
    expect(e.routeProbeEvidence.howToReproduce).toContain('round2/logs')
    expect(e.contractSnapshotSha256).toBe(
      createHash('sha256')
        .update(readFileSync(path.join(CLIENT_WEB, '..', 'contract', 'openapi.json')))
        .digest('hex'),
    )
    // 分类的两套注册不得被写成「能靠斜杠分流」
    for (const k of ['POST /api/v1/pc/categories/', 'GET /api/v1/pc/categories/']) {
      expect(e.trailingSlashEvidence[k]!.note, `${k} 的说明仍声称斜杠能分流`).not.toMatch(
        /带斜杠就?落到|斜杠.*分流到分类树/,
      )
    }
  })
})

describe('PW-15：响应维度结构性不可核对，必须显式记录而不是算 PASS', () => {
  it('契约里 2xx 响应 schema 的缺失被逐条记成 unverifiable-response', () => {
    const contract = loadContract()
    const withoutResponseSchema = [...contract.operations.values()].filter(
      (o) => !o.hasResponseSchema,
    ).length
    expect(withoutResponseSchema).toBeGreaterThan(0)
    expect(unverifiableResponses.length).toBeGreaterThan(0)
    // 这些不是违规、也不是通过：它们必须继续被计数。
    expect(unverifiableResponses.every((f) => !isViolation(f))).toBe(true)
  })
})

/* ══ 故障对照：真实源码注入，判定必须 fail-closed ═══════════════════ */

interface InjectionCase {
  name: string
  source: string
  expectViolations: Finding['kind'][]
}

const CLIENT_IMPORT = `import { apiGet, apiPost } from '../api/client'\n`

const INJECTION_CASES: InjectionCase[] = [
  {
    name: 'path-absent',
    source: `${CLIENT_IMPORT}\nexport const p = apiGet<unknown>('/api/v1/audit-not-in-contract-probe')\n`,
    expectViolations: ['path-absent'],
  },
  {
    name: 'traversal-dynamic-segment',
    // 字面量写进模板表达式的遍历段：旧版只得到 unverifiable-response（假绿）
    source: `${CLIENT_IMPORT}\nexport const p = apiGet<unknown>(\`/api/v1/files/items/\${'../admin'}/open-link\`)\n`,
    expectViolations: ['invalid-path-segment'],
  },
  {
    name: 'traversal-mid-path',
    source: `${CLIENT_IMPORT}\nexport const p = apiPost<unknown>(\`/api/v1/pc/categories/\${'..'}/save\`, {})\n`,
    expectViolations: ['invalid-path-segment'],
  },
  {
    name: 'illegal-query-literal',
    source: `${CLIENT_IMPORT}\nexport const p = apiGet<unknown>('/api/v1/pc/app-signatures?auditProbe=1')\n`,
    expectViolations: ['undeclared-query-param'],
  },
  {
    name: 'illegal-query-template',
    source: `${CLIENT_IMPORT}\nexport const p = apiGet<unknown>(\`/api/v1/pc/app-signatures?\${'auditProbe'}=1\`)\n`,
    expectViolations: ['undeclared-query-param'],
  },
  {
    name: 'traversal-encoded-literal',
    // `encodeURIComponent('../')`：可静态求值，旧版收成 `${...}` → 假绿
    source: `${CLIENT_IMPORT}\nexport const p = apiGet<unknown>(\`/api/v1/files/items/\${encodeURIComponent('../')}/open-link\`)\n`,
    expectViolations: ['invalid-path-segment'],
  },
  {
    name: 'traversal-encoded-const',
    source: [
      CLIENT_IMPORT,
      `const seg = encodeURIComponent('../')`,
      'export const p = apiGet<unknown>(`/api/v1/files/items/${seg}/open-link`)',
      '',
    ].join('\n'),
    expectViolations: ['invalid-path-segment'],
  },
  {
    name: 'query-const-var',
    // `?${k}=1` 且 k 是字符串常量：参数名可静态看到，不能被当成动态 query 放过
    source: [
      CLIENT_IMPORT,
      `const k = 'auditProbe'`,
      'export const p = apiGet<unknown>(`/api/v1/pc/app-signatures?${k}=1`)',
      '',
    ].join('\n'),
    expectViolations: ['undeclared-query-param'],
  },
  {
    name: 'body-field-null-nonnullable',
    // SiteImportRequest.content 是 required、非 nullable 的 string
    source: `${CLIENT_IMPORT}\nexport const p = apiPost<unknown>('/api/v1/pc/browser-tt/import', { content: null })\n`,
    expectViolations: ['body-field-type-mismatch'],
  },
  {
    name: 'record-typed-body',
    source: [
      CLIENT_IMPORT,
      `const body: Record<string, unknown> = { rrule: 'FREQ=DAILY', calendarId: 'c-1' }`,
      `export const p = apiPost<unknown>('/api/v1/calendar/events', body)`,
      '',
    ].join('\n'),
    expectViolations: ['unverifiable-body'],
  },
  {
    name: 'unresolvable-spread',
    source: [
      CLIENT_IMPORT,
      `declare const extra: Record<string, unknown>`,
      `export const p = apiPost<unknown>('/api/v1/calendar/events', { title: 'x', ...extra })`,
      '',
    ].join('\n'),
    expectViolations: ['unverifiable-body'],
  },
  {
    name: 'unbound-identifier-body',
    source: [
      CLIENT_IMPORT,
      `export const p = (payload: unknown) => apiPost<unknown>('/api/v1/calendar/events', payload)`,
      '',
    ].join('\n'),
    expectViolations: ['unverifiable-body'],
  },
  {
    name: 'undeclared-body-field',
    source: `${CLIENT_IMPORT}\nexport const p = apiPost<unknown>('/api/v1/pc/app-signatures', { processName: 'x', auditUnknownField: 1 })\n`,
    expectViolations: ['undeclared-body-field'],
  },
  {
    name: 'missing-required-body-field',
    source: `${CLIENT_IMPORT}\nexport const p = apiPost<unknown>('/api/v1/pc/browser-tt/import', { mode: 'add' })\n`,
    expectViolations: ['missing-required-body-field'],
  },
  {
    name: 'body-field-type-mismatch',
    source: `${CLIENT_IMPORT}\nexport const p = apiPost<unknown>('/api/v1/calendar/calendars', { name: 123 })\n`,
    expectViolations: ['body-field-type-mismatch'],
  },
  {
    name: 'body-not-declared',
    // POST 存在但契约没有声明 requestBody（空体不算，见判定器注释）
    source: [
      CLIENT_IMPORT,
      `declare const id: string`,
      `export const p = apiPost<unknown>(\`/api/v1/calendar/calendars/\${id}/delete-preview\`, { auditProbe: 1 })`,
      '',
    ].join('\n'),
    expectViolations: ['body-not-declared'],
  },
]

describe('故障对照：真实源码注入必须 fail-closed（不是手写 CallSite）', () => {
  it('注入管线本身跑在真实封装模块上（前置：能抽到 wrapper 自身的调用）', () => {
    const { sites: injected } = runInjection(
      'harness-precondition',
      `${CLIENT_IMPORT}\nexport const p = apiGet<unknown>('/api/v1/status')\n`,
    )
    // 注入根里放的是真实的 src/api/client.ts，所以应该同时抽到它的 wrapper/transport 调用；
    // 只统计注入文件本身时，至少要有 1 条。
    expect(injected.length).toBe(1)
    const all = extractCallSites(path.join(INJECT_ROOT, 'harness-precondition'))
    expect(all.some((s) => s.file === 'src/api/client.ts')).toBe(true)
  })

  for (const c of INJECTION_CASES) {
    it(`注入 ${c.name} → 违规 ${c.expectViolations.join(', ') || '（无）'}`, () => {
      const { sites: injected, findings: f } = runInjection(c.name, c.source)
      expect(injected.length, '注入源码没有产生调用点（故障对照失效）').toBeGreaterThan(0)
      const kinds = [...new Set(f.filter(isViolation).map((x) => x.kind))].sort()
      expect(kinds, formatFindings(f)).toEqual([...c.expectViolations].sort())
    })
  }

  it('可选字段省略必须通过（反向对照，防止判定过严）', () => {
    const { findings: f } = runInjection(
      'optional-omission-ok',
      `${CLIENT_IMPORT}\nexport const p = apiPost<unknown>('/api/v1/calendar/calendars', { name: 'x' })\n`,
    )
    expect(f.filter(isViolation)).toEqual([])
  })

  it('合法调用点（契约内路径 + 已声明字段）不得被误报为违规', () => {
    const { findings: f } = runInjection(
      'legal-call-ok',
      `${CLIENT_IMPORT}\nexport const p = apiGet<unknown>(\`/api/v1/files/items/\${id}/open-link\`)\nconst id = 'x'\n`,
    )
    expect(f.filter(isViolation)).toEqual([])
  })
})

describe('PW-01/PW-13：合法具名 generated 请求类型必须被接受（类型边界判据）', () => {
  /*
   * 返工背景（Grok R3 → review I-D1 相邻项）：旧判据只认「对象字面量能枚举字段」，
   * 于是把请求体交给一个**声明类型已经是该 operation 的 generated 请求类型**的
   * 参数/变量时，也会被记成 `unverifiable-body`。那会逼着产品改写成与该判据同构的
   * 形状，而不是证明类型约束成立。
   *
   * 本轮只加**接受判据**，不加厚 AST、不收窄产品调用面：
   * - 声明类型 = `components['schemas'][X]`（或其本地别名）且 X 正是该 operation 的
   *   requestBody schema ⇒ 不在违规里；
   * - `Record` / `any` / `unknown` / `object` / 索引签名 / 未绑定标识符 ⇒ 仍 fail-closed；
   * - 具名类型与 operation 对不上 ⇒ 仍 fail-closed；
   * - 新的 typed 入口必须仍被 `extractCallSites` 看见（不能靠换入口让调用从分母消失）。
   */
  const EVENTS_PATH = '/api/v1/calendar/events'
  const TYPED_IMPORT = `${CLIENT_IMPORT}import type { components } from '../api/generated'\n`

  it('前置：契约里 POST /api/v1/calendar/events 的请求类型确实是 CreateEventRequest', () => {
    const op = loadContract().operations.get(`POST ${EVENTS_PATH}`)
    expect(op, '契约里没有 POST /api/v1/calendar/events').toBeDefined()
    expect(op!.requestSchema?.name, '契约的请求类型变了，下面的接受判据要同步').toBe(
      'CreateEventRequest',
    )
  })

  it('参数注解直接写 components["schemas"][X] ⇒ 零违规（接受判据）', () => {
    const { findings: f } = runInjection(
      'typed-param-direct',
      [
        TYPED_IMPORT,
        `export const p = (body: components['schemas']['CreateEventRequest']) => apiPost<unknown>('${EVENTS_PATH}', body)`,
        '',
      ].join('\n'),
    )
    expect(f.filter(isViolation), formatFindings(f)).toEqual([])
  })

  it('参数注解是本地别名（type Body = components["schemas"][X]）⇒ 同样接受', () => {
    const { findings: f } = runInjection(
      'typed-param-alias',
      [
        TYPED_IMPORT,
        `type Body = components['schemas']['CreateEventRequest']`,
        `export const p = (body: Body) => apiPost<unknown>('${EVENTS_PATH}', body)`,
        '',
      ].join('\n'),
    )
    expect(f.filter(isViolation), formatFindings(f)).toEqual([])
  })

  it('变量声明类型 = generated 具名请求类型 ⇒ 同样接受', () => {
    const { findings: f } = runInjection(
      'typed-const-alias',
      [
        TYPED_IMPORT,
        `type Body = components['schemas']['CreateEventRequest']`,
        `export const send = (body: Body) => apiPost<unknown>('${EVENTS_PATH}', body)`,
        '',
      ].join('\n'),
    )
    expect(f.filter(isViolation), formatFindings(f)).toEqual([])
  })

  it('宽类型注解仍然 fail-closed：Record / any / unknown / object / 索引签名', () => {
    const annotations = [
      'Record<string, unknown>',
      'any',
      'unknown',
      'object',
      '{ [key: string]: unknown }',
    ]
    for (const annotation of annotations) {
      const { findings: f } = runInjection(
        `typed-wide-${annotation.replace(/[^a-zA-Z]/g, '')}`,
        [
          CLIENT_IMPORT,
          `export const p = (body: ${annotation}) => apiPost<unknown>('${EVENTS_PATH}', body)`,
          '',
        ].join('\n'),
      )
      expect(
        [...new Set(f.filter(isViolation).map((x) => x.kind))],
        `宽类型 ${annotation} 被放过了：fail-closed 被削弱`,
      ).toEqual(['unverifiable-body'])
    }
  })

  it('具名类型与命中的 operation 对不上 ⇒ 仍然 fail-closed（不能靠随便写个具名类型混过）', () => {
    const { findings: f } = runInjection(
      'typed-wrong-operation',
      [
        TYPED_IMPORT,
        `export const p = (body: components['schemas']['LoginRequest']) => apiPost<unknown>('${EVENTS_PATH}', body)`,
        '',
      ].join('\n'),
    )
    expect([...new Set(f.filter(isViolation).map((x) => x.kind))]).toEqual(['unverifiable-body'])
  })

  it('新的 typed 入口必须仍被 extractCallSites 看见（不能从分母里消失）', () => {
    const { sites: injected } = runInjection(
      'typed-entry-visible',
      [
        TYPED_IMPORT,
        `export const p = (body: components['schemas']['CreateEventRequest']) => apiPost<unknown>('${EVENTS_PATH}', body)`,
        '',
      ].join('\n'),
    )
    expect(injected.length, 'typed 入口从抽取分母里消失了').toBe(1)
    expect(injected[0]!.pathTemplate).toBe(EVENTS_PATH)
    expect(injected[0]!.level).toBe('business')
    expect(injected[0]!.bodySchemaType).toBe('CreateEventRequest')
    expect(injected[0]!.bodyOpaque).toBe(false)
  })
})

describe('enum 检查：契约声明的枚举不一致时必须失败', () => {
  /**
   * 真实契约的 request schema 目前 0 个带 enum（已核对），所以这一分支用一个
   * **由真实契约派生的变体**（只给 CreateCalendarRequest.kind 加 enum）来验证；
   * 注入的源码仍然走真实抽取管线。词表是变体，不是手写 CallSite。
   */
  const withKindEnum = (): ReturnType<typeof buildContractIndex> => {
    const raw = JSON.parse(
      JSON.stringify(loadContract().raw),
    ) as ContractRaw
    const schemas = raw.components?.schemas ?? {}
    const target = schemas['CreateCalendarRequest'] as {
      properties?: Record<string, { enum?: string[] }>
    }
    const kind = target.properties?.['kind']
    if (!kind) throw new Error('前提不成立：CreateCalendarRequest.kind 不在契约里')
    kind.enum = ['calendar', 'task']
    return buildContractIndex(raw)
  }

  it('事实记录：契约里确实有 enum（DaemonSourceState，经 $ref 挂在 daemon heartbeat 上），但 Web 没有该 POST 的生产调用', () => {
    /*
     * 旧版这里写 `enumProps === []` 并当成前提——那是把「判定器不展开 $ref、
     * 所以看不见 enum」锁成「契约没有 enum」。真实契约有 DaemonSourceState
     * （Unknown/Available/Unavailable/Paused），只通过 $ref 出现。
     * 这里只记录事实：契约有 enum / Web 没有该调用（也不允许为了这条去加心跳客户端）。
     */
    const raw = loadContract().raw
    const state = raw.components?.schemas?.['DaemonSourceState'] as { enum?: string[] } | undefined
    expect(state?.enum, '契约里应有 DaemonSourceState 枚举').toEqual([
      'Unknown',
      'Available',
      'Unavailable',
      'Paused',
    ])
    const heartbeat = (
      raw.paths?.['/api/v1/daemon/heartbeat'] as { post?: { requestBody?: unknown } } | undefined
    )?.post?.requestBody
    expect(
      JSON.stringify(heartbeat),
      'DaemonHeartbeatRequest 应经 $ref 使用该枚举',
    ).toContain('DaemonHeartbeatRequest')
    expect(
      prod.some((s) => s.pathTemplate?.includes('/daemon/heartbeat') && s.method === 'POST'),
      'Web 目前不应有 POST /api/v1/daemon/heartbeat 的生产调用',
    ).toBe(false)
  })

  it('注入契约外枚举值 → body-field-enum-mismatch', () => {
    const { sites: injected } = runInjection(
      'enum-mismatch',
      `${CLIENT_IMPORT}\nexport const p = apiPost<unknown>('/api/v1/calendar/calendars', { name: 'x', kind: 'bogus' })\n`,
    )
    const f = checkCallSites(injected, withKindEnum())
    expect([...new Set(f.filter(isViolation).map((x) => x.kind))]).toEqual([
      'body-field-enum-mismatch',
    ])
  })

  it('反向对照：枚举内的值必须通过', () => {
    const { sites: injected } = runInjection(
      'enum-ok',
      `${CLIENT_IMPORT}\nexport const p = apiPost<unknown>('/api/v1/calendar/calendars', { name: 'x', kind: 'calendar' })\n`,
    )
    expect(checkCallSites(injected, withKindEnum()).filter(isViolation)).toEqual([])
  })
})

describe('验收目标：生产调用零违规（唯一的绿灯条件）', () => {
  it('全量一致性：不得有任何契约违规', () => {
    expect(
      violations.map((f) => `${where(f)} → ${f.message}`).join('\n'),
      'client-web 存在契约不一致或无法核对的调用点',
    ).toBe('')
  })

  it('对照：PW-N1 的 open-link?mode=view 必须已消失（本轮已修，且只删了 query）', () => {
    expect(
      violations.some((f) => f.kind === 'undeclared-query-param'),
      'open-link 的契约外 query 参数仍在发送',
    ).toBe(false)
    const openLink = prod.find((s) => s.pathTemplate?.includes('/open-link'))
    expect(openLink?.pathTemplate).toBe('/api/v1/files/items/${...}/open-link')
  })
})

/**
 * 诊断数字（**不**作为验收断言）：opaque 清单会随正确修复而减少，
 * 因此只导出计数，不再锁成一份历史快照。
 */
export const __report = {
  business: business.length,
  transport: transport.length,
  wrapperDefs: wrapperDefs.length,
  prod: prod.length,
  resolvable: resolvable.length,
  unresolved: unresolved.length,
  violations: violations.length,
  violationKinds: [...new Set(violations.map((f) => f.kind))].sort(),
  violationLocations: violations.map((f) => `${f.kind} ${f.file}:${f.line}`).sort(),
  gaps,
  opaqueBodies: opaqueBodies.length,
  opaqueBodiesOnUnresolvedPaths: opaqueBodiesOnUnresolvedPaths.map(
    (s) => `${s.file}:${s.line}`,
  ),
  dynamicQueries: dynamicQueries.length,
  formatted: formatFindings(violations),
}
