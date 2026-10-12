/*
 * 类型层判据（PW-01 / PW-13 / AC-COM-02）：用**真实 tsc** 验证目标类型形态。
 *
 *   - 合法具名 generated Body（components['schemas'][...]）与可选字段省略必须编译通过；
 *   - 契约外 path / 错误 method / 多余字段 / 宽 Record / 类型不符必须被 tsc 拒绝
 *     （用 `@ts-expect-error`：少报一条，tsc 自己就会失败）；
 *   - 故障对照：把 `@ts-expect-error` 去掉后同一份用例必须真的报错，
 *     证明「编译通过」不是恒真。
 *
 * 本文件只跑编译器，不看源码字符串，也没有任何探针字符串特判。
 */
import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { CLIENT_WEB } from './_lib/contract'

const TSC = path.join(CLIENT_WEB, 'node_modules', '.bin', 'tsc')
const FIXTURES = path.join(CLIENT_WEB, 'audit-tests', 'fixtures', 'typed-boundary')
const TMP = path.join(CLIENT_WEB, 'audit-tests', '.tmp-type')

interface TscRun {
  status: number
  output: string
}

function runTsc(cwd: string): TscRun {
  try {
    const out = execFileSync(TSC, ['-p', 'tsconfig.json'], {
      cwd,
      encoding: 'utf8',
      stdio: 'pipe',
      maxBuffer: 32 * 1024 * 1024,
    })
    return { status: 0, output: out }
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string }
    return { status: e.status ?? -1, output: `${e.stdout ?? ''}${e.stderr ?? ''}` }
  }
}

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('类型边界：generated 的 path/method/schema 约束必须由真实 tsc 执行', () => {
  it('合法具名 generated Body + 可选字段省略必须通过（exit 0）', () => {
    const r = runTsc(FIXTURES)
    expect(
      r.status,
      `目标类型形态下的合法用例必须编译通过。tsc 输出：\n${r.output}`,
    ).toBe(0)
  }, 180_000)

  it('故障对照：去掉 @ts-expect-error 后，同一份非法用例必须真的让 tsc 报错', () => {
    mkdirSync(TMP, { recursive: true })
    const source = readFileSync(path.join(FIXTURES, 'illegal.ts'), 'utf8')
    const stripped = source
      .split('\n')
      .filter((line) => !line.trim().startsWith('// @ts-expect-error'))
      .join('\n')
      // 临时目录比 fixtures/typed-boundary 浅一层，相对导入要跟着改
      .replace("from '../../_lib/typed-client'", "from '../_lib/typed-client'")
    expect(stripped, '过滤 @ts-expect-error 失败（fixture 结构变了）').not.toBe(source)
    writeFileSync(path.join(TMP, 'illegal-nodirectives.ts'), stripped, 'utf8')
    writeFileSync(
      path.join(TMP, 'tsconfig.json'),
      JSON.stringify(
        {
          compilerOptions: {
            target: 'es2023',
            lib: ['ES2023', 'DOM', 'DOM.Iterable'],
            module: 'esnext',
            moduleResolution: 'bundler',
            types: [],
            skipLibCheck: true,
            strict: true,
            noEmit: true,
            verbatimModuleSyntax: true,
            moduleDetection: 'force',
            paths: { '@/*': ['../src/*'] },
          },
          include: ['illegal-nodirectives.ts', '../_lib/typed-client.ts'],
        },
        null,
        2,
      ),
      'utf8',
    )

    const r = runTsc(TMP)
    expect(
      r.status,
      `去掉 @ts-expect-error 后非法用例竟然编译通过了：契约外 path/method/多余字段/宽 Record 没有被 tsc 拒绝。\n${r.output}`,
    ).not.toBe(0)
    const errors = r.output
      .split('\n')
      .filter((l) => l.includes('illegal-nodirectives.ts') && /error TS\d+/.test(l))
    expect(
      errors.length,
      `非法用例触发的 tsc 报错条数少于预期（每条都必须失败）：\n${r.output}`,
    ).toBeGreaterThanOrEqual(6)
  }, 180_000)
})
