/*
 * PW-06：CI 必须真的构建/测试两个壳（Capacitor android / Tauri）。
 * PW-11：文档里引用的脚本与描述的 CI 行为必须与实现一致。
 * PW-12：门禁必须仍然「能失败」——架空模式要被机械识别（含故障对照）。
 * PW-19：业务测试不能薄到「空文件也算覆盖」。
 * PW-20：仓库里的测试脚本不得成为孤儿；需要真实后端的脚本必须写明不进 gate。
 * PW-23：PR 四段双语章节必须有模板（且不得在没有校验器时声称 CI 已拦截）。
 *
 * 第二轮返工要点（I-5）：
 * - 判据从「命令文本里出现某个字符串」改成「**真实入口**」：`echo gradlew assemble &&
 *   exit 0` 这类空转命令不算执行；
 * - 覆盖类断言都要求**故障传播**：跑这些命令的 job 必须被 gate 消费（needs），
 *   否则失败不会影响整体结果；
 * - 不要求「每个文件名都出现在 CI 里」：需要真实后端的脚本由文档统一声明不进 gate；
 * - 文档纠正为现状（无 paths 过滤），不为迎合旧文档改发版行为。
 */
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import yaml from 'js-yaml'
import { afterAll, describe, expect, it } from 'vitest'
import { CLIENT_WEB, REPO_ROOT } from './_lib/contract'
import { jobAssertsArtifact, jobAssertsFreshArtifact, realCommandLines as sharedRealCommandLines } from './_lib/shell-build'

/* ── workflow 装载 ─────────────────────────────────────────── */

interface WfStep {
  name?: string
  run?: string
  uses?: string
  if?: string | boolean
  'continue-on-error'?: boolean | string
}

interface WfJob {
  name?: string
  'runs-on'?: string
  needs?: string | string[]
  if?: string | boolean
  'continue-on-error'?: boolean | string
  steps?: WfStep[]
}

interface Wf {
  name?: string
  on?: unknown
  jobs?: Record<string, WfJob>
}

interface LoadedWorkflow {
  rel: string
  wf: Wf
  text: string
}

function loadWorkflows(): LoadedWorkflow[] {
  const dir = path.join(REPO_ROOT, '.github', 'workflows')
  const out: LoadedWorkflow[] = []
  for (const f of readdirSync(dir)) {
    if (!/\.ya?ml$/.test(f)) continue
    const rel = `.github/workflows/${f}`
    const text = readFileSync(path.join(dir, f), 'utf8')
    out.push({ rel, text, wf: yaml.load(text) as Wf })
  }
  return out
}

function loadActions(): LoadedWorkflow[] {
  const dir = path.join(REPO_ROOT, '.github', 'actions')
  const out: LoadedWorkflow[] = []
  for (const a of readdirSync(dir)) {
    const rel = `.github/actions/${a}/action.yml`
    const p = path.join(dir, a, 'action.yml')
    if (!existsSync(p)) continue
    const text = readFileSync(p, 'utf8')
    out.push({ rel, text, wf: yaml.load(text) as Wf })
  }
  return out
}

const WORKFLOWS = loadWorkflows()
const ACTIONS = loadActions()
const ALL_CI_FILES = [...WORKFLOWS, ...ACTIONS]

function allSteps(wf: Wf): { job: string; step: WfStep }[] {
  const out: { job: string; step: WfStep }[] = []
  for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
    for (const step of job.steps ?? []) out.push({ job: jobName, step })
  }
  return out
}

function allRunText(files: LoadedWorkflow[] = ALL_CI_FILES): string {
  return files
    .flatMap((f) => allSteps(f.wf).map(({ step }) => step.run ?? ''))
    .concat(
      files.map(
        (f) =>
          (f.wf as { runs?: { using?: string; steps?: WfStep[] } }).runs?.steps
            ?.map((s) => s.run ?? '')
            .join('\n') ?? '',
      ),
    )
    .join('\n')
}

/**
 * 抽出「真实会被执行的命令行」：
 * - 去掉注释/空行；
 * - 去掉 `echo …` / `true` / `:` 这些空转语句；
 * - 支持 `cd xxx && <命令>` 前缀。
 * 这样 `echo gradlew assembleDebug` 就不会被当成「真的在构建壳」。
 *
 * 实现与 `_lib/shell-build.ts` 的 `jobAssertsArtifact` **共用**（review I-D1：
 * 两处口径分叉会让产物断言被 `echo test -f` 满足）。
 */
function realCommandLines(files: LoadedWorkflow[] = ALL_CI_FILES): string[] {
  return sharedRealCommandLines(allRunText(files))
}

/** 某个「要被验证的能力」是否被任何 workflow 步骤**真实执行** */
function isReallyExecuted(patterns: RegExp[], files: LoadedWorkflow[] = ALL_CI_FILES): boolean {
  return realCommandLines(files).some((line) => patterns.some((p) => p.test(line)))
}

/** gate job 的 needs（GW 门禁消费） */
function gateNeeds(files: LoadedWorkflow[] = WORKFLOWS): string[] {
  const ci = files.find((w) => w.rel.endsWith('ci.yml'))
  expect(ci, '找不到 .github/workflows/ci.yml').toBeDefined()
  for (const job of Object.values(ci!.wf.jobs ?? {})) {
    if (job.name === 'CI Gate') {
      return (Array.isArray(job.needs) ? job.needs : [job.needs]).filter(
        (x): x is string => typeof x === 'string',
      )
    }
  }
  throw new Error('ci.yml 里找不到名为 "CI Gate" 的 job')
}

/** 哪个 job 里有满足该 pattern 的真实命令 */
function jobsRunning(patterns: RegExp[], files: LoadedWorkflow[] = ALL_CI_FILES): string[] {
  const out: string[] = []
  for (const f of files) {
    for (const { job, step } of allSteps(f.wf)) {
      for (const line of (step.run ?? '').split('\n')) {
        const t = line.trim()
        if (!t || t.startsWith('#')) continue
        const cmd = t.split('&&').map((p) => p.trim()).slice(-1)[0]!
        if (/^(echo|true|:|printf)$/.test(cmd.split(/\s+/)[0]!)) continue
        if (patterns.some((p) => p.test(cmd))) out.push(job)
      }
    }
  }
  return [...new Set(out)]
}

/* ── 架空模式识别（PW-12 的判据） ──────────────────────────── */

interface SwallowFinding {
  rel: string
  where: string
  pattern: string
}

/**
 * 判据来自 legacy 仓自己的结构判定（ai-dev-workflow REQ-8）：
 * 只看**结构**，不看注释 —— continue-on-error / if: false 会改变执行语义，
 * `|| true` / `&& true` / `set +e` 会吞掉失败码。
 */
function findFailureSwallowing(text: string, rel = '<memory>'): SwallowFinding[] {
  const out: SwallowFinding[] = []
  let wf: Wf
  try {
    wf = yaml.load(text) as Wf
  } catch {
    return out
  }
  for (const [jobName, job] of Object.entries(wf.jobs ?? {})) {
    if (job['continue-on-error'] === true || job['continue-on-error'] === 'true') {
      out.push({ rel, where: `job ${jobName}`, pattern: 'continue-on-error: true (job)' })
    }
    if (job.if === false || job.if === 'false') {
      out.push({ rel, where: `job ${jobName}`, pattern: 'if: false (job)' })
    }
    for (const step of job.steps ?? []) {
      const label = `job ${jobName} / step "${step.name ?? step.uses ?? step.run?.split('\n')[0] ?? '?'}"`
      if (step['continue-on-error'] === true || step['continue-on-error'] === 'true') {
        out.push({ rel, where: label, pattern: 'continue-on-error: true (step)' })
      }
      if (step.if === false || step.if === 'false') {
        out.push({ rel, where: label, pattern: 'if: false (step)' })
      }
      const run = step.run ?? ''
      if (/\|\|\s*true\b/.test(run)) out.push({ rel, where: label, pattern: '|| true' })
      if (/&&\s*true\b/.test(run)) out.push({ rel, where: label, pattern: '&& true' })
      if (/(^|\n)\s*set\s*\+e\b/.test(run)) out.push({ rel, where: label, pattern: 'set +e' })
    }
  }
  return out
}

/* ── 断言 ─────────────────────────────────────────────────── */

describe('PW-06：两个壳必须真的被构建/测试，并且失败能传到 gate', () => {
  const ANDROID = [/gradlew?\b.*(assemble|test|build)/i, /assembleDebug|assembleRelease|bundleDebug/, /\bcap(acitor)?\s+sync\b/i]
  const TAURI = [/cargo\s+(check|build|test|clippy)\b/, /tauri\s+(build|dev)\b/i]
  /*
   * R7 判据补强（独立 review `web-round6-grok.md` §4.2 判据洞 1/3）。
   *
   * 上面两条宽判据是**或**关系：`cap sync` 或 `gradlew test*` 单独就能满足
   * 「真实执行 Android 壳构建」，于是把 `bash gradlew assembleDebug` 换成
   * `echo gradlew assembleDebug` 后判据仍为真；Tauri 侧 `cargo test` 同理能替
   * `cargo build`。真正产出产物的是 assemble/bundle 与 cargo build，因此单独要求。
   */
  const ANDROID_ASSEMBLE = [/\bgradlew?\b[^\n]*\b(assemble|bundle)/i, /\b(assemble|bundle)(Debug|Release)\b/]
  const TAURI_BUILD = [/\bcargo\s+build\b/, /\btauri\s+build\b/]
  /** 产物断言里要出现的路径/后缀：空脚本不产生它们 */
  const ANDROID_ARTIFACTS = ['app-debug.apk', 'app-release.apk', 'app/build/outputs']
  const TAURI_ARTIFACTS = ['target/debug', 'target/release']

  const CI_TEXT = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')

  /** 把一段（被注入过的）ci.yml 文本当成唯一 workflow 装载，用于精准 mutant */
  function asCi(text: string): LoadedWorkflow[] {
    return [{ rel: '.github/workflows/ci.yml', text, wf: yaml.load(text) as Wf }]
  }

  /** 某个 job 的全部 step（跨给定 workflow 查找） */
  function stepsOf(jobName: string, files: LoadedWorkflow[]): WfStep[] {
    const out: WfStep[] = []
    for (const f of files) {
      for (const [name, job] of Object.entries(f.wf.jobs ?? {})) {
        if (name === jobName) out.push(...(job.steps ?? []))
      }
    }
    return out
  }

  function stepsOfJob(jobName: string): WfStep[] {
    return stepsOf(jobName, ALL_CI_FILES)
  }

  it('存在真实执行 Capacitor Android 壳构建/测试的命令', () => {
    expect(
      isReallyExecuted(ANDROID),
      'CI 里没有任何**真实**构建/测试 client-web/android 的命令（AGENTS.md 却把 "its shell builds" 列为 master 的价值）',
    ).toBe(true)
  })

  it('存在真实执行 Tauri 壳构建/检查的命令', () => {
    expect(isReallyExecuted(TAURI), 'CI 里没有任何真实构建/检查 client-web/src-tauri 的命令').toBe(true)
  })

  it('存在真实执行 Android assemble/bundle 的命令（cap sync 与 gradlew test 不能代替）', () => {
    expect(
      isReallyExecuted(ANDROID_ASSEMBLE),
      'CI 里没有真实执行 assemble/bundle 的命令：`cap sync` 或 `gradlew test*` 都不能产出 APK',
    ).toBe(true)
  })

  it('存在真实执行 Tauri cargo build / tauri build 的命令（cargo test 不能代替）', () => {
    expect(
      isReallyExecuted(TAURI_BUILD),
      'CI 里没有真实执行 cargo build / tauri build 的命令：`cargo test` 不能代替产物构建',
    ).toBe(true)
  })

  it('跑壳构建的 job 必须被 gate 消费（否则失败不影响整体结果）', () => {
    const jobs = [...jobsRunning(ANDROID), ...jobsRunning(TAURI)]
    expect(jobs.length, '没有 job 真实执行壳构建').toBeGreaterThan(0)
    const needs = gateNeeds()
    const missing = jobs.filter((j) => !needs.includes(j))
    expect(missing, `这些 job 跑了壳构建但没进 gate.needs：${missing.join(', ')}`).toEqual([])
  })

  it('壳构建 job 必须断言**产物存在且新鲜**（否则空 gradlew / 陈旧产物也能绿）', () => {
    /*
     * 判据返工（PW-06）：命令文本里出现 gradlew 不够——空的 gradlew（exit 0）
     * 同样满足。job 必须另有断言产物的步骤（存在性检查或 upload-artifact），
     * 这样「没真的构建」在 CI 里必然失败。
     *
     * R7 补强（review `web-round6-grok.md` §4.2 判据洞 2）：只要求 `test -f`
     * 仍然放过「上一轮留下的陈旧 APK」。所以这里改用 `jobAssertsFreshArtifact`，
     * 它同时要求存在性断言与 `-nt`（或等价）新鲜度比较。
     */
    const androidJobs = jobsRunning(ANDROID)
    const tauriJobs = jobsRunning(TAURI)
    const noArtifact = [
      ...androidJobs.filter((j) => !jobAssertsFreshArtifact(stepsOfJob(j), ANDROID_ARTIFACTS)),
      ...tauriJobs.filter((j) => !jobAssertsFreshArtifact(stepsOfJob(j), TAURI_ARTIFACTS)),
    ]
    expect(
      noArtifact,
      `这些 job 只跑了壳构建命令、没有断言产物存在**且新鲜**：一个空的 gradlew（exit 0）` +
        `或上一轮留下的陈旧产物也会让它们变绿。缺少判据的 job：${noArtifact.join(', ')}`,
    ).toEqual([])
  })

  it('故障对照：“只有命令、没有产物断言”的 job 不得通过新判据', () => {
    const onlyCommand = [
      { run: 'cd client-web/android && ./gradlew assembleDebug' },
      { run: 'echo done' },
    ]
    /** 只判存在：旧判据会放行，但它挡不住「陈旧 APK」，因此新鲜度判据必须拒绝 */
    const onlyExists = [
      { run: 'cd client-web/android && ./gradlew assembleDebug' },
      { run: 'test -f client-web/android/app/build/outputs/apk/debug/app-debug.apk' },
    ]
    const freshAndExists = [
      ...onlyExists,
      { run: 'test client-web/android/app/build/outputs/apk/debug/app-debug.apk -nt .ci-stamps/android' },
    ]
    expect(jobAssertsArtifact(onlyCommand, ANDROID_ARTIFACTS), '只有命令也通过 = 判据仍是文本计数').toBe(false)
    expect(jobAssertsArtifact(onlyExists, ANDROID_ARTIFACTS)).toBe(true)
    expect(
      jobAssertsFreshArtifact(onlyExists, ANDROID_ARTIFACTS),
      '只写 `test -f <apk>` 就被判为「断言了新鲜产物」：陈旧 APK 仍会假绿',
    ).toBe(false)
    expect(jobAssertsFreshArtifact(freshAndExists, ANDROID_ARTIFACTS)).toBe(true)
  })

  it('壳源码目录必须落在某个 job 的工作范围内', () => {
    const text = ALL_CI_FILES.map((f) => f.text).join('\n')
    expect(
      /client-web\/android|client-web\/src-tauri/.test(text),
      '两个壳目录在 .github/ 里完全没有出现，改坏壳代码不会有任何检查',
    ).toBe(true)
  })

  it('故障对照：`echo gradlew assembleDebug` 这类空转命令不得被当成真实执行', () => {
    const probeText = `
name: probe
on: [push]
jobs:
  shell-android:
    runs-on: ubuntu-latest
    steps:
      - run: echo gradlew assembleDebug
  shell-tauri:
    runs-on: ubuntu-latest
    steps:
      - run: "true"
`
    const probe: LoadedWorkflow[] = [{ rel: '<probe>', text: probeText, wf: yaml.load(probeText) as Wf }]
    expect(isReallyExecuted(ANDROID, probe), 'echo 命令被当成了真实构建').toBe(false)
    expect(isReallyExecuted(TAURI, probe)).toBe(false)

    const real = `
name: probe
on: [push]
jobs:
  shell-android:
    runs-on: ubuntu-latest
    steps:
      - run: cd client-web/android && ./gradlew assembleDebug
`
    const realWf: LoadedWorkflow[] = [{ rel: '<probe>', text: real, wf: yaml.load(real) as Wf }]
    expect(isReallyExecuted(ANDROID, realWf), '真实 gradlew 命令没被识别').toBe(true)
  })

  /*
   * R7 精准 mutant（review `web-round6-grok.md` §4.2 的对照表）。
   * 每个 mutant 先在**旧判据**下保持为真（复现洞），再在**补强后的判据**下必须为红；
   * 未注入的 ci.yml 必须为真（恢复绿）。mutant 只作用于文本副本，不改仓库文件。
   */
  it('判据 mutant：`assemble` 换成 echo 后，assemble 判据必须红（cap sync / test 不能兜底）', () => {
    const mutated = CI_TEXT.replace('run: bash gradlew assembleDebug', 'run: echo gradlew assembleDebug')
    expect(mutated, '注入没有生效（ci.yml 里的 assemble 命令变了）').not.toBe(CI_TEXT)
    const files = asCi(mutated)
    expect(
      isReallyExecuted(ANDROID, files),
      '前提：宽判据在注入后仍为真——这正是原来的判据洞',
    ).toBe(true)
    expect(
      isReallyExecuted(ANDROID_ASSEMBLE, files),
      'assemble 被换成 echo 后 assemble 判据仍为真：cap sync / gradlew test 还在兜底，洞没堵上',
    ).toBe(false)
    expect(isReallyExecuted(ANDROID_ASSEMBLE), '现状（未注入）必须为真：恢复绿').toBe(true)
  })

  it('判据 mutant：`cargo build` 换成 echo 后，cargo build 判据必须红（cargo test 不能兜底）', () => {
    const mutated = CI_TEXT.replace('run: cargo build', 'run: echo cargo build')
    expect(mutated, '注入没有生效（ci.yml 里的 cargo build 命令变了）').not.toBe(CI_TEXT)
    const files = asCi(mutated)
    expect(isReallyExecuted(TAURI, files), '前提：宽判据在注入后仍为真（cargo test 兜底）').toBe(true)
    expect(
      isReallyExecuted(TAURI_BUILD, files),
      'cargo build 被换成 echo 后 cargo build 判据仍为真：cargo test 在兜底，洞没堵上',
    ).toBe(false)
    expect(isReallyExecuted(TAURI_BUILD), '现状（未注入）必须为真：恢复绿').toBe(true)
  })

  it('判据 mutant：删掉 Android 的 `-nt` 新鲜度行后，新鲜度判据必须红（只留 test -f 不算）', () => {
    const ntLine =
      '\n          test client-web/android/app/build/outputs/apk/debug/app-debug.apk -nt .ci-stamps/android'
    expect(CI_TEXT.includes(ntLine), 'fixture 漂移：ci.yml 里找不到 Android 新鲜度行').toBe(true)
    const mutated = CI_TEXT.replace(ntLine, '')
    expect(mutated).not.toBe(CI_TEXT)
    const steps = stepsOf('shell-android', asCi(mutated))
    expect(
      jobAssertsArtifact(steps, ANDROID_ARTIFACTS),
      '前提：旧判据只看 `test -f`，删掉新鲜度行后仍为真——这才是要堵的洞',
    ).toBe(true)
    expect(
      jobAssertsFreshArtifact(steps, ANDROID_ARTIFACTS),
      '删掉 `-nt` 新鲜度行后新鲜度判据仍为真：陈旧 APK 仍能假绿',
    ).toBe(false)
    expect(
      jobAssertsFreshArtifact(stepsOfJob('shell-android'), ANDROID_ARTIFACTS),
      '现状（未注入）必须为真：恢复绿',
    ).toBe(true)
  })

  it('判据 mutant：删掉 Tauri 的 `-nt` 新鲜度行后，新鲜度判据必须红', () => {
    const ntLine = '\n          test client-web/src-tauri/target/debug/app -nt .ci-stamps/tauri'
    expect(CI_TEXT.includes(ntLine), 'fixture 漂移：ci.yml 里找不到 Tauri 新鲜度行').toBe(true)
    const mutated = CI_TEXT.replace(ntLine, '')
    expect(mutated).not.toBe(CI_TEXT)
    const steps = stepsOf('shell-tauri', asCi(mutated))
    expect(jobAssertsArtifact(steps, TAURI_ARTIFACTS), '前提：旧判据删掉新鲜度行后仍为真').toBe(true)
    expect(
      jobAssertsFreshArtifact(steps, TAURI_ARTIFACTS),
      '删掉 `-nt` 新鲜度行后新鲜度判据仍为真：陈旧二进制仍能假绿',
    ).toBe(false)
    expect(
      jobAssertsFreshArtifact(stepsOfJob('shell-tauri'), TAURI_ARTIFACTS),
      '现状（未注入）必须为真：恢复绿',
    ).toBe(true)
  })

  it('判据 mutant：ci.yml 中 Android 改为逆向 `stamp -nt apk` 后，新鲜度判据必须红', () => {
    const orig = 'test client-web/android/app/build/outputs/apk/debug/app-debug.apk -nt .ci-stamps/android'
    const mutated = CI_TEXT.replace(
      orig,
      'test .ci-stamps/android -nt client-web/android/app/build/outputs/apk/debug/app-debug.apk',
    )
    expect(mutated).not.toBe(CI_TEXT)
    const steps = stepsOf('shell-android', asCi(mutated))
    expect(
      jobAssertsFreshArtifact(steps, ANDROID_ARTIFACTS),
      '逆向 stamp -nt apk 仍被判为新鲜：假绿漏洞',
    ).toBe(false)
    expect(
      jobAssertsFreshArtifact(stepsOfJob('shell-android'), ANDROID_ARTIFACTS),
      '现状（未注入）必须为真：恢复绿',
    ).toBe(true)
  })

  it('判据 mutant：ci.yml 中 Android 改为逆向 `apk -ot stamp` 后，新鲜度判据必须红', () => {
    const orig = 'test client-web/android/app/build/outputs/apk/debug/app-debug.apk -nt .ci-stamps/android'
    const mutated = CI_TEXT.replace(
      orig,
      'test client-web/android/app/build/outputs/apk/debug/app-debug.apk -ot .ci-stamps/android',
    )
    expect(mutated).not.toBe(CI_TEXT)
    const steps = stepsOf('shell-android', asCi(mutated))
    expect(
      jobAssertsFreshArtifact(steps, ANDROID_ARTIFACTS),
      '逆向 apk -ot stamp 仍被判为新鲜：假绿漏洞',
    ).toBe(false)
    expect(
      jobAssertsFreshArtifact(stepsOfJob('shell-android'), ANDROID_ARTIFACTS),
      '现状（未注入）必须为真：恢复绿',
    ).toBe(true)
  })

  it('判据 mutant：ci.yml 中 Android 改为无关外部 stamp 后，新鲜度判据必须红', () => {
    const orig = 'test client-web/android/app/build/outputs/apk/debug/app-debug.apk -nt .ci-stamps/android'
    const mutated = CI_TEXT.replace(
      orig,
      'test client-web/android/app/build/outputs/apk/debug/app-debug.apk -nt /tmp/epoch',
    )
    expect(mutated).not.toBe(CI_TEXT)
    const steps = stepsOf('shell-android', asCi(mutated))
    expect(
      jobAssertsFreshArtifact(steps, ANDROID_ARTIFACTS),
      '外部无关 stamp 比较仍被判为新鲜：假绿漏洞',
    ).toBe(false)
    expect(
      jobAssertsFreshArtifact(stepsOfJob('shell-android'), ANDROID_ARTIFACTS),
      '现状（未注入）必须为真：恢复绿',
    ).toBe(true)
  })
})

describe('PW-20：版本自测必须被真实执行，且失败必须能传播', () => {
  const VERSION_TMP = path.join(CLIENT_WEB, 'audit-tests', '.tmp-version')

  /** 复制一份「仓库布局」（脚本 + composite action）用于注入故障 */
  function makeVersionRoot(name: string): string {
    const root = path.join(VERSION_TMP, name)
    rmSync(root, { recursive: true, force: true })
    mkdirSync(path.join(root, 'scripts', 'ci'), { recursive: true })
    mkdirSync(path.join(root, '.github', 'actions', 'resolve-version'), { recursive: true })
    for (const rel of [
      'scripts/ci/resolve-version.sh',
      'scripts/ci/test-resolve-version.sh',
      '.github/actions/resolve-version/action.yml',
    ]) {
      cpSync(path.join(REPO_ROOT, rel), path.join(root, rel))
    }
    return root
  }

  /** 「自测脚本」必须真的断言、且有失败退出路径；`exit 0` 不算 */
  function scriptCanFail(text: string): boolean {
    const code = text.replace(/(^|\s)#.*$/gm, '')
    const hasAssertion = /assert_eq|\[\[\s/.test(code)
    const hasFailPath = /fail=1/.test(code) || /exit\s+1\b/.test(code)
    return hasAssertion && hasFailPath
  }

  it('审计测试必须真的执行 scripts/ci/test-resolve-version.sh（不是只看文件名出现在 CI 文本里）', () => {
    const r = execFileSync('bash', ['scripts/ci/test-resolve-version.sh'], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      stdio: 'pipe',
    })
    expect(r).toMatch(/resolve-version tests passed/)
  }, 60_000)

  it('故障对照：把 resolve-version.sh 的版本拼接改坏后，同一入口必须失败', () => {
    const root = makeVersionRoot('broken-version')
    const resolve = path.join(root, 'scripts', 'ci', 'resolve-version.sh')
    const original = readFileSync(resolve, 'utf8')
    const mutated = original.replace(/VERSION_CODE=\$\(\([^\n]*/, 'VERSION_CODE=1')
    expect(mutated, '故障注入没有生效（resolve-version.sh 结构变了）').not.toBe(original)
    writeFileSync(resolve, mutated, 'utf8')
    let status = 0
    try {
      execFileSync('bash', ['scripts/ci/test-resolve-version.sh'], { cwd: root, stdio: 'pipe' })
    } catch (err) {
      status = (err as { status?: number }).status ?? -1
    }
    expect(status, '版本逻辑被改坏后自测仍然通过：这个入口没有证明力').not.toBe(0)
  }, 60_000)

  it('故障对照：自测脚本被换成 exit 0 空脚本必须被检出（不能靠文件名存在就当已验证）', () => {
    expect(scriptCanFail(readFileSync(path.join(REPO_ROOT, 'scripts/ci/test-resolve-version.sh'), 'utf8'))).toBe(true)
    expect(scriptCanFail('#!/usr/bin/env bash\nexit 0\n')).toBe(false)
    expect(scriptCanFail('#!/usr/bin/env bash\necho resolve-version tests passed\n')).toBe(false)
  })

  it('普通 PR 的 workflow 权限不得是 contents: write', () => {
    for (const f of WORKFLOWS) {
      expect(
        /contents:\s*write/.test(f.text),
        `${f.rel} 声明了 contents: write：普通 PR/fork 不该有写权限`,
      ).toBe(false)
    }
    const ci = WORKFLOWS.find((w) => w.rel.endsWith('ci.yml'))!
    expect(/^permissions:\s*\n\s*contents:\s*read/m.test(ci.text), 'ci.yml 应为 contents: read').toBe(
      true,
    )
  })

  afterAll(() => {
    // 临时工作区不能留在树里：聚合 patch 会把未跟踪文件算进去
    rmSync(VERSION_TMP, { recursive: true, force: true })
  })

  it('每个 scripts/ci/test-*.sh 都必须被 CI 真实执行，且跑它的 job 被 CI Gate 消费', () => {
    const dir = path.join(REPO_ROOT, 'scripts', 'ci')
    const testScripts = readdirSync(dir).filter((f) => /^test-.*\.sh$/.test(f))
    expect(testScripts.length, '仓库里连一个 CI 自测脚本都没有').toBeGreaterThan(0)

    const orphan: string[] = []
    const notGated: string[] = []
    const needs = gateNeeds()
    for (const s of testScripts) {
      // 判据是「有一条真实会被执行的命令行点名了这个脚本」，不是「文件名出现在 CI 文本里」
      const jobs = jobsRunning([new RegExp(`(bash|sh|\\./)\\s*[^\\n]*${s.replace(/\./g, '\\.')}`)])
      if (jobs.length === 0) orphan.push(s)
      else if (!jobs.some((j) => needs.includes(j))) notGated.push(`${s} ← ${jobs.join(',')}`)
    }
    expect(
      orphan,
      `这些自测脚本存在但没有被 CI 真实执行（它们自己会失败，但没人跑）：${orphan.join(', ')}`,
    ).toEqual([])
    expect(
      notGated,
      `这些自测脚本的 job 没有被 gate 消费，失败不会影响整体结果：${notGated.join('; ')}`,
    ).toEqual([])
  })

  it('故障对照：把 CI 里的自测命令换成 echo 空转、或把 job 从 gate needs 里摘掉，判据必须打红', () => {
    const ciRel = '.github/workflows/ci.yml'
    const base = readFileSync(path.join(REPO_ROOT, ciRel), 'utf8')
    const pattern = /(bash|sh|\.\/)\s*[^\n]*test-resolve-version\.sh/
    const asWorkflow = (text: string): LoadedWorkflow[] => [
      { rel: ciRel, text, wf: yaml.load(text) as Wf },
    ]

    const echoed = base.replace(
      'run: bash scripts/ci/test-resolve-version.sh',
      'run: echo bash scripts/ci/test-resolve-version.sh',
    )
    expect(echoed, '故障注入没有生效（CI 里的自测命令变了）').not.toBe(base)
    expect(
      jobsRunning([pattern], asWorkflow(echoed)),
      'echo 空转被当成了「真实执行自测脚本」',
    ).toEqual([])

    /*
     * 注入的目标改成「包含 repo-script-tests 的那一条 needs 列表」，而不是写死整行：
     * 门禁新增 job 时不该让这个**故障对照的注入**失效（它会以「注入没生效」红掉，
     * 那是 fixture 漂移，不是判据变弱）。注入后仍必须满足：
     * 文本确实变了、且 gateNeeds() 里不再有 repo-script-tests。
     */
    const withoutNeed = base.replace(
      /needs: \[[^\]]*\brepo-script-tests\b[^\]]*\]/,
      'needs: [resolve-version, build-web]',
    )
    expect(withoutNeed, '故障注入没有生效（gate 的 needs 变了）').not.toBe(base)
    expect(gateNeeds(asWorkflow(withoutNeed))).not.toContain('repo-script-tests')

    // 反向对照：现状必须真实执行、且在 gate needs 里
    expect(jobsRunning([pattern])).toContain('repo-script-tests')
    expect(gateNeeds()).toContain('repo-script-tests')
  })

  it('需要真实后端的 QA 脚本由文档统一声明不进 gate（不要求每个文件名都出现在 CI）', () => {
    const agents = readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8')
    const section = /需要真实后端的本地脚本[\s\S]{0,1200}/.exec(agents)
    expect(section, 'AGENTS.md 缺少「需要真实后端的本地脚本」一节').not.toBeNull()
    const scripts = readdirSync(path.join(CLIENT_WEB, 'scripts')).filter((f) =>
      /^(verify-|probe-|qa-|extract-).*\.(mjs|js|py)$/.test(f),
    )
    const missing = scripts.filter((f) => !section![0].includes(f))
    expect(missing, `这些脚本需要真实后端却没有被文档声明：${missing.join(', ')}`).toEqual([])
    expect(section![0]).toMatch(/不进[^\n]*gate|不进入[^\n]*gate/)
  })

  it('测试设施本身必须真实跑起来：npm run test 与 typecheck:audit 都发出真实命令', () => {
    const lines = realCommandLines()
    expect(lines.some((l) => /npm run test\b/.test(l)), 'CI 没有真实执行 npm run test').toBe(true)
    const pkg = JSON.parse(readFileSync(path.join(CLIENT_WEB, 'package.json'), 'utf8')) as {
      scripts?: Record<string, string>
    }
    const typecheck = pkg.scripts?.['typecheck:audit'] ?? ''
    expect(typecheck, 'package.json 没有 typecheck:audit 脚本').toMatch(/tsc\s+-p\s+tsconfig\.audit\.json/)
    expect(typecheck).not.toMatch(/^(echo|true|:)/)
    expect(
      lines.some((l) => /npm run typecheck:audit\b/.test(l)),
      'CI 没有真实执行 audit-tests 的类型检查：helper 能编译就只是声称',
    ).toBe(true)
    const tsconfig = readFileSync(path.join(CLIENT_WEB, 'tsconfig.audit.json'), 'utf8')
    expect(tsconfig).toContain('"audit-tests"')
  })
})

describe('PW-12：门禁必须仍然能失败', () => {
  it('当前 .github/ 下不存在任何架空模式（结构判定，不看注释）', () => {
    const findings = ALL_CI_FILES.flatMap((f) => findFailureSwallowing(f.text, f.rel))
    expect(
      findings.map((f) => `${f.rel} ${f.where} → ${f.pattern}`).join('\n'),
      '门禁被架空：失败会被吞掉，绿了不代表通过',
    ).toBe('')
  })

  it('gate job 必须逐项判断每个 needs 的结果：任一 job 失败/被跳过都要整体失败', () => {
    const ci = WORKFLOWS.find((w) => w.rel.endsWith('ci.yml'))!
    const gate = Object.entries(ci.wf.jobs ?? {}).find(([, j]) => j.name === 'CI Gate')
    expect(gate, 'ci.yml 里找不到名为 "CI Gate" 的 job').toBeDefined()
    const [, gateJob] = gate!
    const step = (gateJob.steps ?? []).find((s) => s.run)
    expect(step, 'gate job 没有可执行的 run 步骤').toBeDefined()

    const envTemplates = (step as WfStep & { env?: Record<string, string> }).env ?? {}
    const needs = (Array.isArray(gateJob.needs) ? gateJob.needs : [gateJob.needs]).filter(
      (x): x is string => typeof x === 'string',
    )
    expect(needs.length).toBeGreaterThan(0)
    expect(Object.keys(envTemplates).length, 'gate 步骤没有从 needs 读取任何结果').toBeGreaterThanOrEqual(
      needs.length,
    )

    const scriptPath = path.join(CLIENT_WEB, 'audit-tests', '.tmp-gate.sh')
    writeFileSync(scriptPath, step!.run!, 'utf8')

    const runGate = (results: Record<string, string>): number => {
      const env: NodeJS.ProcessEnv = { ...process.env }
      for (const [key, template] of Object.entries(envTemplates)) {
        const m = /needs\.([A-Za-z0-9_-]+)\.result/.exec(template)
        env[key] = m ? (results[m[1]!] ?? '') : template
      }
      try {
        execFileSync('bash', [scriptPath], { env, stdio: 'ignore' })
        return 0
      } catch (err) {
        return (err as { status?: number }).status ?? -1
      }
    }

    const allSuccess = Object.fromEntries(needs.map((n) => [n, 'success']))
    expect(runGate(allSuccess), '全部 success 时 gate 不应失败').toBe(0)

    for (const n of needs) {
      for (const bad of ['failure', 'cancelled', 'skipped', '']) {
        expect(
          runGate({ ...allSuccess, [n]: bad }),
          `needs.${n} = ${bad || '<missing>'} 时 gate 必须失败（缺结果也算失败）`,
        ).not.toBe(0)
      }
    }
    rmSync(scriptPath, { force: true })
  })

  it('故障对照：注入 continue-on-error / if: false / || true / set +e 都必须被识别', () => {
    const base = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    const cases: [string, string][] = [
      ['continue-on-error', base.replace('      - name: Lint', '      - name: Lint\n        continue-on-error: true')],
      ['if: false', base.replace('      - name: Lint', '      - name: Lint\n        if: false')],
      ['|| true', base.replace('        run: npm run lint', '        run: npm run lint || true')],
      ['set +e', base.replace('        run: npm run lint', '        run: |\n          set +e\n          npm run lint')],
    ]
    for (const [label, mutated] of cases) {
      expect(mutated, `${label} 注入没有生效（fixture 漂移）`).not.toBe(base)
      const found = findFailureSwallowing(mutated, `<mutated:${label}>`)
      expect(found.length, `注入 ${label} 后判定没有报出问题`).toBeGreaterThan(0)
    }
  })
})

describe('PW-11：文档引用的脚本与描述的 CI 行为必须与实现一致', () => {
  it('AGENTS.md / contract/README.md 引用的仓库内脚本路径必须存在', () => {
    const docs = ['AGENTS.md', 'contract/README.md']
    const missing: string[] = []
    for (const doc of docs) {
      const text = readFileSync(path.join(REPO_ROOT, doc), 'utf8')
      for (const m of text.matchAll(/`(scripts\/[A-Za-z0-9._/-]+)`/g)) {
        const rel = m[1]!
        if (!existsSync(path.join(REPO_ROOT, rel))) missing.push(`${doc} → ${rel}`)
      }
    }
    expect(missing, '文档引用了不存在的脚本（断链）').toEqual([])
  })

  it('文档声称的触发/发版行为必须与真实 workflow 一致（无 paths 过滤就不许写 path-filtered）', () => {
    const text = readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8')
    const claimsPathFilter = /path-filter(ed)?/i.test(text)
    const hasPathFilter = /^\s*paths(-ignore)?:/m.test(
      readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8'),
    )
    if (claimsPathFilter) {
      expect(
        hasPathFilter,
        '文档声称改动会被 path filter 跳过，但 ci.yml 没有任何 paths: 过滤',
      ).toBe(true)
    }
  })

  it('文档若声称 CI 会拦截/提取 PR 章节，必须有真实执行该校验的 job', () => {
    const text = readFileSync(path.join(REPO_ROOT, 'AGENTS.md'), 'utf8')
    // 只认「肯定式」声明：带否定词的行（没有/不会/未/不得/无）不算声称
    const claimsEnforced = text
      .split('\n')
      .filter(
        (l) =>
          /CI/i.test(l) &&
          /(提取|校验|拦截)/.test(l) &&
          /(章节|描述|body)/i.test(l) &&
          !/(没有|不会|不校验|不得|未|无)/.test(l),
      )
    if (claimsEnforced.length > 0) {
      const jobs = jobsRunning([/release-notes|validate-pr|pr-body|pull_request_template/])
      expect(
        jobs.length,
        `文档声称 CI 会提取/校验 PR 章节（${claimsEnforced[0]}），但没有任何 job 真实执行该校验`,
      ).toBeGreaterThan(0)
    }
  })

  it('文档若声称「快照落后不阻塞 CI」，必须与真实新鲜度门禁的口径一致', () => {
    const readme = readFileSync(path.join(REPO_ROOT, 'contract', 'README.md'), 'utf8')
    const ci = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    const readmeSaysNoFreshnessCheck = /不校验新鲜度|不阻塞/.test(readme)
    const ciChecksFreshness = /fetch-contract\.sh/.test(ci)
    if (readmeSaysNoFreshnessCheck && ciChecksFreshness) {
      expect(
        /generated\.ts[^。\n]*openapi\.json|openapi\.json[^。\n]*generated\.ts/.test(readme),
        'contract/README.md 说「不校验新鲜度」，而 ci.yml 确实校验了：必须写清口径，避免误导',
      ).toBe(true)
    }
  })
})

describe('PW-23：PR 四段双语章节必须有模板（不宣称 CI 已拦截）', () => {
  const TEMPLATE = path.join(REPO_ROOT, '.github', 'pull_request_template.md')
  const REQUIRED = [
    '## 技术修改 / Technical changes',
    '## 功能变化 / Feature changes',
    '## 如何体验 / How to try it',
    '## 测试 / Tests',
  ]

  /** 与 AGENTS.md 的提取逻辑同口径：只看标题行 */
  function sectionsIn(body: string): string[] {
    return REQUIRED.filter((h) => body.split('\n').some((l) => l.trim() === h))
  }

  it('仓库必须有 PR 模板，且模板本身满足四段双语标题', () => {
    expect(
      existsSync(TEMPLATE),
      'AGENTS.md 把四段双语章节写成 MUST，但 .github/ 下没有 pull_request_template.md，只能靠人记',
    ).toBe(true)
    const body = readFileSync(TEMPLATE, 'utf8')
    expect(sectionsIn(body)).toEqual(REQUIRED)
  })

  it('故障对照：章节校验器必须能认出缺失章节的 body（证明校验不是恒真）', () => {
    const full = REQUIRED.join('\n\n内容\n')
    expect(sectionsIn(full)).toEqual(REQUIRED)
    expect(sectionsIn('# 随便写点什么\n\n没有章节')).toEqual([])
    expect(sectionsIn(REQUIRED[0]!)).toEqual([REQUIRED[0]])
  })
})

/*
 * PW-23 的目标 RED（Grok R3 I-R4 / review C4 的边界）。
 *
 * 今天仓库只有模板，`ci.yml` 里没有任何**真实执行** PR 元数据校验的命令，
 * 所以这一组现在是红的——它描述的是「要实现成什么样」，不是现状。
 * 一旦实现，下面这些断言会真的跑起那条命令（不是看文件名）：
 *
 *   被校验的入口约定（实现方按这个写，测试按这个跑）：
 *     - 命令必须**真实执行**一个 `scripts/ci/` 下名字含 `pr` 的脚本（不是 echo）；
 *     - 跑它的 job 必须被 `CI Gate` 的 `needs` 消费（失败能影响整体结果）；
 *     - 该 job 不得用 `if:` 把自己限制成只在 `pull_request` 上运行——
 *       否则 `push` 时它是 `skipped`，而现有 Gate 把 skipped 当失败，会误伤 push；
 *     - 脚本从环境读：`GITHUB_EVENT_NAME`（pull_request / push）、`PR_BODY`、
 *       `PR_HEAD_REF`（分支名）；`push`（没有 PR body）必须自己成功结束。
 *
 * 不要求现在就去改 workflow：本轮只把这个「必须是红的」判据写好，
 * 并把旧的「校验 job 必须为空」反绿锁删掉。
 */
describe('PW-23：PR 元数据（四段双语章节 / 分支名）必须让现有 CI Gate 失败', () => {
  const REQUIRED = [
    '## 技术修改 / Technical changes',
    '## 功能变化 / Feature changes',
    '## 如何体验 / How to try it',
    '## 测试 / Tests',
  ]
  /** 真实执行 `scripts/ci/` 下名字含 pr 的脚本的命令行 */
  const PR_SCRIPT_RE = /(?:bash|sh|\.\/)\s+[^\n]*scripts\/ci\/[^\s]*pr[^\s]*\.sh/

  /** 找出「PR 元数据校验」的真实命令行与它所在的 job（走与其它判据同一套真实命令行过滤） */
  function prMetadataInvocation(): { job: string; command: string } | null {
    for (const f of ALL_CI_FILES) {
      for (const { job, step } of allSteps(f.wf)) {
        for (const cmd of sharedRealCommandLines(step.run ?? '')) {
          if (PR_SCRIPT_RE.test(cmd)) return { job, command: cmd }
        }
      }
    }
    return null
  }

  /** 直接用真实命令重放一次（与 CI 里跑的是同一条命令） */
  function runCheck(command: string, env: Record<string, string>): number {
    try {
      execFileSync('bash', ['-c', command], {
        cwd: REPO_ROOT,
        env: { ...process.env, ...env },
        stdio: 'pipe',
      })
      return 0
    } catch (err) {
      return (err as { status?: number }).status ?? -1
    }
  }

  const fullBody = (): string => REQUIRED.join('\n\n内容\n')
  const baseEnv = (over: Record<string, string>): Record<string, string> => ({
    GITHUB_EVENT_NAME: 'pull_request',
    PR_BODY: fullBody(),
    PR_HEAD_REF: 'deepseek-linux/pw-23-pr-metadata',
    ...over,
  })

  it('（RED）存在真实执行 PR 元数据校验的命令，且它所在的 job 被 CI Gate 消费', () => {
    const found = prMetadataInvocation()
    expect(
      found,
      'CI 里没有真实执行 PR 章节/分支校验的命令：模板存在不等于门禁存在（PW-23 未实现）',
    ).not.toBeNull()
    expect(gateNeeds(), `跑 PR 元数据校验的 job（${found!.job}）没有被 CI Gate 消费`).toContain(
      found!.job,
    )
  })

  it('（RED）该 job 不得用 if: 限制成只在 pull_request 上跑（push 时 skipped 会误伤 Gate）', () => {
    const found = prMetadataInvocation()
    expect(found, 'PR 元数据校验尚未实现（PW-23 目标 RED）').not.toBeNull()
    for (const f of WORKFLOWS) {
      for (const [name, job] of Object.entries(f.wf.jobs ?? {})) {
        if (name !== found!.job) continue
        const jobIf = typeof job.if === 'string' ? job.if : ''
        expect(
          /pull_request/.test(jobIf),
          `job ${name} 的 if 把校验限制成只在 pull_request 上运行：push 时它会 skipped，` +
            `而现有 Gate 把 skipped 当失败`,
        ).toBe(false)
      }
    }
  })

  it('（RED）缺任一段双语标题的 pull_request body 必须让这条命令失败', () => {
    const found = prMetadataInvocation()
    expect(found, 'PR 元数据校验尚未实现（PW-23 目标 RED）').not.toBeNull()
    for (const heading of REQUIRED) {
      const body = REQUIRED.filter((h) => h !== heading)
        .join('\n\n内容\n')
      expect(
        runCheck(found!.command, baseEnv({ PR_BODY: body })),
        `缺「${heading}」的 PR body 仍然通过了：章节门禁是恒真的`,
      ).not.toBe(0)
    }
    // 反向对照：四段齐全必须通过（防止判据恒假）
    expect(runCheck(found!.command, baseEnv({}))).toBe(0)
  })

  it('（RED）push 没有 PR body 时这条命令必须自己成功结束（不能靠 skip）', () => {
    const found = prMetadataInvocation()
    expect(found, 'PR 元数据校验尚未实现（PW-23 目标 RED）').not.toBeNull()
    expect(
      runCheck(found!.command, baseEnv({ GITHUB_EVENT_NAME: 'push', PR_BODY: '', PR_HEAD_REF: 'master' })),
      'push（没有 PR body）时校验命令失败了：必须自己成功结束，否则会误伤 push',
    ).toBe(0)
  })

  it('（RED）分支名：{agent}-{os}/{topic} 与工具分支 task/<n> 允许，其他形状失败', () => {
    const found = prMetadataInvocation()
    expect(found, 'PR 元数据校验尚未实现（PW-23 目标 RED）').not.toBeNull()
    const allowed = ['deepseek-linux/pw-23-pr-metadata', 'codex-win/host-bridge', 'task/12']
    for (const branch of allowed) {
      expect(
        runCheck(found!.command, baseEnv({ PR_HEAD_REF: branch })),
        `合法分支名 ${branch} 被拦下了`,
      ).toBe(0)
    }
    for (const branch of ['feature-x', 'master', 'deepseek/linux-x']) {
      expect(
        runCheck(found!.command, baseEnv({ PR_HEAD_REF: branch })),
        `不合法分支名 ${branch} 被放过了`,
      ).not.toBe(0)
    }
  })

  it('（RED）校验不得用 pull_request_target，权限保持 contents: read', () => {
    for (const f of ALL_CI_FILES) {
      expect(
        /pull_request_target/.test(f.text),
        `${f.rel} 使用了 pull_request_target：普通 PR 校验不许有这种权限模型`,
      ).toBe(false)
      expect(/contents:\s*write/.test(f.text), `${f.rel} 声明了 contents: write`).toBe(false)
    }
  })

  /*
   * R7 Minor 补强（review `web-round6-grok.md` §4.2 · M）：
   * `ci.yml` 的 `pull_request.types` 确实已含 `edited`（PR 描述被改写时会重跑校验），
   * 但原判据不读这个列表——把它删掉不会有任何测试变红。这里补一条精确断言。
   */
  it('pull_request 触发必须含 edited（否则改坏 PR 描述不会重跑校验）', () => {
    const readTypes = (text: string): string[] => {
      const wf = yaml.load(text) as Wf & { on?: { pull_request?: { types?: string[] } } }
      return wf.on?.pull_request?.types ?? []
    }
    const ciText = readFileSync(path.join(REPO_ROOT, '.github', 'workflows', 'ci.yml'), 'utf8')
    expect(
      readTypes(ciText),
      'ci.yml 的 pull_request 没有列出 edited：把 PR 描述改坏不会重跑 pr-metadata 校验',
    ).toContain('edited')

    // 故障对照：判据不是恒真——去掉 edited 后必须读不到它
    const mutated = ciText.replace(
      'types: [opened, synchronize, reopened, edited]',
      'types: [opened, synchronize, reopened]',
    )
    expect(mutated, 'fixture 漂移：ci.yml 的 pull_request.types 行变了').not.toBe(ciText)
    expect(readTypes(mutated), '去掉 edited 后判据仍为真 = 恒真断言').not.toContain('edited')
  })
})

describe('PW-19：业务测试不能薄到「空文件 / expect(true) 也算覆盖」', () => {
  const featureDirs = readdirSync(path.join(CLIENT_WEB, 'src', 'features')).filter((d) =>
    existsSync(path.join(CLIENT_WEB, 'src', 'features', d, 'api.ts')),
  )

  /**
   * 判据不是「文件里出现过 expect(」：那被 `expect(true).toBe(true)` 满足。
   * 也不是「文件里出现过 /api/v1/」：一个从没被用到的路径字符串同样满足。
   *
   * 必须同时满足三点：
   *   1. **真的引入了该域的 api 模块**，而且**真的调用了它**（`todayApi.xxx(...)`）——
   *      只 import 或只写个没人用的路径常量都不算；
   *   2. 有断言；
   *   3. 断言里出现真实请求维度（契约路径 / fetch stub / apiUrl 拼接）。
   */
  function hasRealRequestAssertion(src: string, domain: string): boolean {
    // 去掉注释，避免「注释里写个 /api/v1/」就算数
    const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|\s)\/\/.*$/gm, '')
    const importRe = new RegExp(
      `import\\s+(?:type\\s+)?\\{([^}]*)\\}\\s*from\\s*['"](?:@/features/${domain}/api|\\./api|\\.\\./api)['"]`,
    )
    const imported = importRe.exec(code)?.[1]
    if (!imported) return false
    const names = imported
      .split(',')
      .map((s) => s.trim().split(/\s+as\s+/).pop()?.trim() ?? '')
      .filter((n) => /^[A-Za-z_$][\w$]*$/.test(n))
    // 只是 import 不算：必须真的调用该域的 api（成员访问/调用）
    const invokesDomainApi = names.some((n) => new RegExp(`\\b${n}\\s*[.(]`).test(code))
    const hasAssertion = /expect\s*\(/.test(code)
    // 必须出现真实请求维度：契约路径、fetch stub、或 apiUrl 拼接
    const mentionsRequest = /\/api\/v1\/|stubGlobal\(\s*['"]fetch['"]|apiUrl\(/.test(code)
    return invokesDomainApi && hasAssertion && mentionsRequest
  }

  function testFilesOf(domain: string): string[] {
    const dir = path.join(CLIENT_WEB, 'src', 'features', domain)
    const found: string[] = []
    const walk = (p: string): void => {
      for (const e of readdirSync(p, { withFileTypes: true })) {
        if (e.isDirectory()) walk(path.join(p, e.name))
        else if (/\.test\.tsx?$/.test(e.name)) found.push(path.join(p, e.name))
      }
    }
    walk(dir)
    return found
  }

  it('每个有 api.ts 的域都必须有断言「真实请求行为」的测试文件', () => {
    const thin: string[] = []
    for (const d of featureDirs) {
      const found = testFilesOf(d)
      const ok = found.filter((f) => hasRealRequestAssertion(readFileSync(f, 'utf8'), d))
      if (ok.length === 0) thin.push(`${d}（测试文件：${found.length}，断言真实请求：0）`)
    }
    expect(thin, `这些域有网络调用却没有断言真实请求的测试：${thin.join(', ')}`).toEqual([])
  })

  it('故障对照：空文件、expect(true).toBe(true)、只 import 不断言都不得通过判据', () => {
    expect(hasRealRequestAssertion('', 'today')).toBe(false)
    expect(hasRealRequestAssertion("import { it, expect } from 'vitest'\nit('x', () => { expect(true).toBe(true) })\n", 'today')).toBe(false)
    expect(hasRealRequestAssertion("import { todayApi } from './api'\n", 'today')).toBe(false)
    // 注释里写契约路径不作数
    expect(
      hasRealRequestAssertion(
        "import { todayApi } from './api'\n// 覆盖 /api/v1/today/sections\nit('x', () => { expect(true).toBe(true) })\n",
        'today',
      ),
    ).toBe(false)
    // import + expect(true) + 一个从未被用于请求的路径字符串：仍是假绿，必须被判不合格
    expect(
      hasRealRequestAssertion(
        [
          "import { todayApi } from './api'",
          "const unusedPath = '/api/v1/today/sections'",
          "it('x', () => { expect(true).toBe(true) })",
          '',
        ].join('\n'),
        'today',
      ),
      '只 import + 一个没用到的路径字符串 + expect(true) 被当成了真实请求断言',
    ).toBe(false)
    // 反向对照：真实的请求断言必须通过（防止判据恒假）
    expect(
      hasRealRequestAssertion(
        readFileSync(path.join(CLIENT_WEB, 'src', 'features', 'today', 'today-api.test.ts'), 'utf8'),
        'today',
      ),
    ).toBe(true)
  })

  it('契约一致性测试必须真的被同一条 npm run test 收进来（不是只在目录里躺着）', () => {
    const cfg = readFileSync(path.join(CLIENT_WEB, 'vitest.config.ts'), 'utf8')
    expect(cfg).toContain('audit-tests/**/*.test.ts')
    expect(cfg).toContain('audit-tests/**/*.test.tsx')
    const conformance = path.join(CLIENT_WEB, 'audit-tests', 'contract-conformance.test.ts')
    expect(existsSync(conformance)).toBe(true)
    expect(readFileSync(conformance, 'utf8')).toMatch(/expect\s*\(/)
  })
})
