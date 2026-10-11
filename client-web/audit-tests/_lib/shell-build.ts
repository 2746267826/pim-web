/*
 * 「壳构建成功」的判据（PW-06，测试设施）。
 *
 * 旧判据是「workflow 的命令文本里出现了 gradlew/cargo 字样」——`echo gradlew assembleDebug`
 * 或一个空的 `exit 0` 脚本都能满足，证明不了真的构建过。
 *
 * 新判据只看**执行后的新鲜产物**：
 *   1. 真的用 bash 执行该构建命令；
 *   2. 退出码必须是 0；
 *   3. 必须出现构建前不存在的产物文件（APK / 二进制），且 mtime 在本次执行之后。
 * 字符串计数、日志里的 "BUILD SUCCESSFUL" 都不算。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'

export interface ShellBuildResult {
  proven: boolean
  status: number
  artifacts: string[]
  detail: string
}

/** 递归收集匹配后缀的产物（返回相对路径） */
function collectArtifacts(root: string, suffixes: string[]): string[] {
  const out: string[] = []
  const walk = (dir: string): void => {
    let entries: Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const e of entries) {
      const full = path.join(dir, e.name)
      if (e.isDirectory()) {
        if (e.name === 'node_modules' || e.name === '.git') continue
        walk(full)
        continue
      }
      if (suffixes.some((s) => e.name.endsWith(s))) out.push(path.relative(root, full))
    }
  }
  walk(root)
  return out
}

/**
 * 执行构建命令并判定它是否**被产物证明**。
 * `run` 的调用方负责提供一个已经准备好的工作区（假 gradlew / cargo 脚本等）。
 */
export function verifyShellBuild(opts: {
  cwd: string
  command: string
  artifactSuffixes: string[]
  timeoutMs?: number
}): ShellBuildResult {
  const startedAt = Date.now()
  let status = 0
  try {
    execFileSync('bash', ['-c', opts.command], {
      cwd: opts.cwd,
      stdio: 'pipe',
      timeout: opts.timeoutMs ?? 60_000,
    })
  } catch (err) {
    status = (err as { status?: number }).status ?? -1
  }
  const fresh = collectArtifacts(opts.cwd, opts.artifactSuffixes).filter((rel) => {
    try {
      return statSync(path.join(opts.cwd, rel)).mtimeMs >= startedAt - 2000
    } catch {
      return false
    }
  })
  const proven = status === 0 && fresh.length > 0
  return {
    proven,
    status,
    artifacts: fresh,
    detail: proven
      ? `退出 0 且产生新鲜产物：${fresh.join(', ')}`
      : status !== 0
        ? `构建命令退出 ${status}`
        : '命令退出 0，但没有产生任何新鲜产物（空脚本/echo 不能算构建成功）',
  }
}

/**
 * 从一段 `run:` 文本里抽出「真实会被执行的命令行」：
 * - 去掉注释行/空行；
 * - 支持 `cd xxx && <命令>` 前缀（只取最后一段）；
 * - 去掉 `echo …` / `true` / `:` / `printf …` 这些空转语句。
 *
 * `workflow-integrity.test.ts` 的 `jobsRunning` 与下面的 `jobAssertsArtifact`
 * **共用**这一份实现：两处口径一旦分叉，就会出现「命令算真实执行、产物断言却能被
 * `echo test -f` 满足」的洞（review I-D1）。
 */
export function realCommandLines(runText: string): string[] {
  const out: string[] = []
  for (const line of runText.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const parts = t.split('&&').map((p) => p.trim())
    const cmd = parts[parts.length - 1]!
    const head = cmd.split(/\s+/)[0]!
    if (/^(echo|true|:|printf)$/.test(head)) continue
    out.push(cmd)
  }
  return out
}

/**
 * CI 判据：一个 job 只有同时满足下面三点，才能算「真的构建了壳」：
 *   - 里有 step 真实执行构建命令（非 echo/true/:）；
 *   - 后续 step 断言产物存在（artifact assertion，而不是只看日志）；
 *   - 该 job 被 gate 消费。
 *
 * 产物断言也走 `realCommandLines`：`echo test -f <apk>`、注释里的 `test -f <apk>`
 * 都不算断言（否则判据又退回文本计数）。
 */
export function jobAssertsArtifact(
  steps: { run?: string }[],
  artifactSuffixes: string[],
): boolean {
  return steps.some((s) =>
    realCommandLines(s.run ?? '').some(
      (cmd) =>
        artifactSuffixes.some((suffix) => cmd.includes(suffix)) &&
        /\b(test\s+-[ef]|\[\[?\s+-[ef]|ls\b|stat\b|upload-artifact|tar\b)/.test(cmd),
    ),
  )
}

/** 「新鲜度比较」的等价形状：`test A -nt B`、`[[ A -ot B ]]`、`find … -newer B` */
const FRESHNESS_RE = /(^|\s)-(nt|ot|newer)\b/

/**
 * 产物**新鲜度**判据（R7 补强，review `web-round6-grok.md` §4.2 判据洞 2）：
 * `jobAssertsArtifact` 只要求「真实命令行里出现产物路径 + test -f」，因此把
 * `test <apk> -nt <stamp>` 那一行删掉、只留 `test -f <apk>` 时判据仍然为真，
 * 而「本 job 没重新构建、只是上一轮留下的陈旧 APK」正是要挡住的假绿。
 *
 * 所以这里拆成两个**必须同时满足**的条件：
 *   1. 存在性断言：真实命令行里出现产物路径，且有 `-e/-f` / `ls` / `stat`；
 *   2. 新鲜度断言：真实命令行里出现产物路径，且有 `-nt` / `-ot` / `-newer` 比较。
 * 「进程退出码 0」「日志里打印 BUILD SUCCESSFUL」都不算。
 */
export function jobAssertsFreshArtifact(
  steps: { run?: string }[],
  artifactSuffixes: string[],
): boolean {
  const cmds = steps.flatMap((s) => realCommandLines(s.run ?? ''))
  const mentions = (cmd: string): boolean => artifactSuffixes.some((suffix) => cmd.includes(suffix))
  /*
   * `-nt`/`-ot`/`-newer` 比较本身就对缺失文件返回假，所以新鲜度比较同时满足存在性
   * （否则 `test -e X && test X -nt S` 这种同一行写法会因为 `realCommandLines`
   * 只取 `&&` 最后一段而被误判为「没有存在性断言」）。这只是避免误报，不放宽要求：
   * 下面仍然要求**同时**具备存在性与新鲜度。
   */
  const assertsExists = cmds.some(
    (cmd) =>
      mentions(cmd) &&
      (/\b(test\s+-[ef]|\[\[?\s+-[ef]|ls\b|stat\b)/.test(cmd) || FRESHNESS_RE.test(cmd)),
  )
  const assertsFresh = cmds.some((cmd) =>
    artifactSuffixes.some((suffix) => {
      if (!cmd.includes(suffix) || !cmd.includes('.ci-stamps/')) return false
      const esc = suffix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const artNt = new RegExp(`${esc}[^\\n|&;]*-nt\\s+\\S*\\.ci-stamps/\\S*`)
      const stampOt = new RegExp(`\\.ci-stamps/\\S*\\s+-ot\\s+[^\\n|&;]*${esc}`)
      const artNewer = new RegExp(`${esc}[^\\n|&;]*-newer\\s+\\S*\\.ci-stamps/\\S*`)
      return artNt.test(cmd) || stampOt.test(cmd) || artNewer.test(cmd)
    }),
  )
  return assertsExists && assertsFresh
}
