/*
 * 断言质量判定（审计整改测试设施，非产品代码）。
 *
 * PW-09 的核心是「恒真断言」：脚本里存在永远不会失败的断言，于是它既不能
 * 证明通过、也不能在链路坏掉时报警。这里用 AST 判定，而不是 grep 关键词：
 *   1. 先认出本地的断言助手（形如 `const ok = (name, cond, detail) => { … pass: !!cond … }`），
 *      取「条件」参数的位置；
 *   2. 再看调用它的地方，条件实参是不是恒真（字面量 true / `A || true` / `true || A`）。
 * 另外做一次兜底：任何调用实参里出现 `|| true` 也报出来（审计的原始形态）。
 */
import ts from 'typescript'

export interface TautologyFinding {
  file: string
  line: number
  callee: string
  expression: string
  reason: string
}

/** 剥掉外层括号 */
function unwrap(node: ts.Expression): ts.Expression {
  let n = node
  while (ts.isParenthesizedExpression(n)) n = n.expression
  return n
}

function isTrueLiteral(node: ts.Expression): boolean {
  const n = unwrap(node)
  if (n.kind === ts.SyntaxKind.TrueKeyword) return true
  return ts.isNumericLiteral(n) && n.text === '1'
}

/** `A || true` / `true || A` → 恒真 */
function alwaysTrueDisjunction(node: ts.Expression): boolean {
  const n = unwrap(node)
  if (!ts.isBinaryExpression(n)) return false
  if (n.operatorToken.kind !== ts.SyntaxKind.BarBarToken) return false
  return isTrueLiteral(n.left) || isTrueLiteral(n.right)
}

/** 在函数体里找「被 !! 包裹」或赋给 pass 的属性名，用它的参数位置当条件槽 */
function conditionParamIndex(fn: ts.FunctionLikeDeclaration): number | null {
  const body = fn.body
  if (!body) return null
  const bodyText = body.getText()
  const params = fn.parameters
  for (let i = 0; i < params.length; i += 1) {
    const p = params[i]!
    if (!ts.isIdentifier(p.name)) continue
    const name = p.name.text
    if (new RegExp(`!!\\s*${name}\\b`).test(bodyText) || new RegExp(`\\bpass\\s*:\\s*${name}\\b`).test(bodyText)) {
      return i
    }
  }
  return null
}

/** 收集本地断言助手：名字 → 条件参数下标 */
function collectAssertHelpers(sf: ts.SourceFile): Map<string, number> {
  const helpers = new Map<string, number>()
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const init = node.initializer
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
        const idx = conditionParamIndex(init)
        if (idx !== null) helpers.set(node.name.text, idx)
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      const idx = conditionParamIndex(node)
      if (idx !== null) helpers.set(node.name.text, idx)
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return helpers
}

export function findTautologicalAssertions(source: string, file: string): TautologyFinding[] {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS)
  const helpers = collectAssertHelpers(sf)
  const out: TautologyFinding[] = []

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const callee = node.expression.text
      const line = sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1
      const idx = helpers.get(callee)
      if (idx !== null && idx !== undefined) {
        const cond = node.arguments[idx]
        if (cond) {
          if (isTrueLiteral(cond)) {
            out.push({
              file,
              line,
              callee,
              expression: cond.getText(),
              reason: '条件实参是字面量 true，断言永远通过',
            })
          } else if (alwaysTrueDisjunction(cond)) {
            out.push({
              file,
              line,
              callee,
              expression: cond.getText(),
              reason: '条件是 `… || true` 形式，恒真',
            })
          }
        }
      }
      // 兜底：任何断言类调用的实参里出现 `|| true`
      for (const arg of node.arguments) {
        if (alwaysTrueDisjunction(arg)) {
          const already = out.some((f) => f.line === line && f.expression === arg.getText())
          if (!already) {
            out.push({
              file,
              line,
              callee,
              expression: arg.getText(),
              reason: '断言实参含 `|| true`，该分支永远不会失败',
            })
          }
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sf)
  return out
}
