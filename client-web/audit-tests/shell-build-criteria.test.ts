/*
 * PW-06 判据返工：证明「空脚本 / exit 0 / 只打印 BUILD SUCCESSFUL」不能算壳构建成功，
 * 只有**执行后产生新鲜产物**才算（不是命令文本计数）。
 *
 * 本文件在本地起假工作区真的执行脚本；不做任何真机/真实 SDK 的冒充。
 */
import { chmodSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CLIENT_WEB } from './_lib/contract'
import { jobAssertsArtifact, jobAssertsFreshArtifact, verifyShellBuild } from './_lib/shell-build'

const TMP = path.join(CLIENT_WEB, 'audit-tests', '.tmp-shell-build')

function workspace(name: string): string {
  const dir = path.join(TMP, name)
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  return dir
}

function writeScript(dir: string, name: string, body: string): void {
  const file = path.join(dir, name)
  writeFileSync(file, `#!/usr/bin/env bash\n${body}`, 'utf8')
  chmodSync(file, 0o755)
}

beforeAll(() => {
  mkdirSync(TMP, { recursive: true })
})

afterAll(() => {
  rmSync(TMP, { recursive: true, force: true })
})

describe('PW-06 判据：构建成功必须由「新鲜产物」证明，不能由命令文本/日志证明', () => {
  it('空 gradlew（立即 exit 0）不得被判定为构建成功', () => {
    const dir = workspace('empty-gradle')
    // 假装是 Android 壳工程，写上空的 gradlew
    mkdirSync(path.join(dir, 'client-web', 'android'), { recursive: true })
    writeScript(dir, 'gradlew', 'exit 0\n')
    const r = verifyShellBuild({
      cwd: dir,
      command: './gradlew assembleDebug',
      artifactSuffixes: ['app-debug.apk'],
    })
    expect(r.status, '空脚本的退出码确实是 0（这正是它骗过文本判据的方式）').toBe(0)
    expect(r.proven, r.detail).toBe(false)
    expect(r.artifacts).toEqual([])
  })

  it('空的 cargo 包装脚本（exit 0）不得被判定为构建成功', () => {
    const dir = workspace('empty-cargo')
    writeScript(dir, 'cargo', 'exit 0\n')
    const r = verifyShellBuild({
      cwd: dir,
      command: './cargo check --manifest-path client-web/src-tauri/Cargo.toml',
      artifactSuffixes: ['.rlib', '.rmeta'],
    })
    expect(r.status).toBe(0)
    expect(r.proven, r.detail).toBe(false)
  })

  it('只打印 “BUILD SUCCESSFUL” 但没有产物，同样不得算成功（判据不看日志文本）', () => {
    const dir = workspace('log-only')
    writeScript(dir, 'gradlew', 'echo BUILD SUCCESSFUL\nexit 0\n')
    const r = verifyShellBuild({
      cwd: dir,
      command: './gradlew assembleDebug',
      artifactSuffixes: ['app-debug.apk'],
    })
    expect(r.proven, r.detail).toBe(false)
  })

  it('反向对照：真的产出 APK 时才判定成功（防止判据恒假）', () => {
    const dir = workspace('real-gradle')
    mkdirSync(path.join(dir, 'app', 'build', 'outputs', 'apk', 'debug'), { recursive: true })
    writeScript(
      dir,
      'gradlew',
      'mkdir -p app/build/outputs/apk/debug\necho fake-apk > app/build/outputs/apk/debug/app-debug.apk\n',
    )
    const r = verifyShellBuild({
      cwd: dir,
      command: './gradlew assembleDebug',
      artifactSuffixes: ['app-debug.apk'],
    })
    expect(r.proven, r.detail).toBe(true)
    expect(r.artifacts).toEqual(['app/build/outputs/apk/debug/app-debug.apk'])
  })

  it('反向对照：构建命令失败（exit != 0）时，即使有陈旧产物也不得算成功', () => {
    const dir = workspace('failing-build')
    mkdirSync(path.join(dir, 'app', 'build', 'outputs', 'apk', 'debug'), { recursive: true })
    writeFileSync(path.join(dir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk'), 'x')
    writeScript(dir, 'gradlew', 'echo fail >&2\nexit 1\n')
    const r = verifyShellBuild({
      cwd: dir,
      command: './gradlew assembleDebug',
      artifactSuffixes: ['app-debug.apk'],
    })
    expect(r.status).not.toBe(0)
    expect(r.proven, r.detail).toBe(false)
  })

  it('反向对照：命令 exit 0，但产物在本次执行前就存在且没被改写（mtime 陈旧）⇒ 不算成功', () => {
    /*
     * 这是「exit 0 + 陈旧 APK」的回归保护：打包产物是上一次构建留下的，
     * 本次命令什么也没做。判据靠 mtime 新鲜度挡住它，这条用例把这个行为锁住。
     */
    const dir = workspace('stale-artifact')
    const apk = path.join(dir, 'app', 'build', 'outputs', 'apk', 'debug', 'app-debug.apk')
    mkdirSync(path.dirname(apk), { recursive: true })
    writeFileSync(apk, 'stale-apk-from-an-earlier-run')
    const stale = new Date(Date.now() - 60_000)
    utimesSync(apk, stale, stale)
    writeScript(dir, 'gradlew', 'exit 0\n')
    const r = verifyShellBuild({
      cwd: dir,
      command: './gradlew assembleDebug',
      artifactSuffixes: ['app-debug.apk'],
    })
    expect(r.status, '前提：这个空转命令的退出码是 0').toBe(0)
    expect(r.proven, `陈旧产物被当成了本次构建的产物：${r.detail}`).toBe(false)
    expect(r.artifacts).toEqual([])
  })
})

/*
 * `jobAssertsArtifact` 的判据返工（review I-D1）：
 * 旧实现逐行做子串匹配，`echo test -f <apk>` 就能满足「断言产物存在」。
 * 现在两处（真实执行 / 产物断言）共用同一套「真实命令行」过滤，注释与 echo 都不算。
 */
describe('PW-06 判据：产物断言也必须是真实命令行（echo / 注释不算）', () => {
  const ANDROID_ARTIFACTS = ['app-debug.apk', 'app/build/outputs']
  const BUILD = { run: 'cd client-web/android && ./gradlew assembleDebug' }
  const APK = 'client-web/android/app/build/outputs/apk/debug/app-debug.apk'

  it('故障对照：只有 `echo test -f <产物>` 的 job 不得被当成断言了产物', () => {
    expect(
      jobAssertsArtifact([BUILD, { run: `echo test -f ${APK}` }], ANDROID_ARTIFACTS),
      'echo 出来的断言仍被判为「断言了产物」：判据还是文本计数',
    ).toBe(false)
    expect(
      jobAssertsArtifact([BUILD, { run: `echo "test -f ${APK}" && true` }], ANDROID_ARTIFACTS),
    ).toBe(false)
  })

  it('故障对照：注释里的 `test -f <产物>` 也不算断言', () => {
    expect(
      jobAssertsArtifact([BUILD, { run: `# test -f ${APK}` }], ANDROID_ARTIFACTS),
    ).toBe(false)
    expect(
      jobAssertsArtifact([BUILD, { run: `./gradlew assembleDebug\n# test -f ${APK}` }], ANDROID_ARTIFACTS),
    ).toBe(false)
  })

  it('反向对照：真实的产物断言必须通过（防止判据恒假）', () => {
    expect(jobAssertsArtifact([BUILD, { run: `test -f ${APK}` }], ANDROID_ARTIFACTS)).toBe(true)
    expect(
      jobAssertsArtifact([BUILD, { run: `cd client-web/android && test -f ${APK}` }], ANDROID_ARTIFACTS),
    ).toBe(true)
    expect(jobAssertsArtifact([BUILD, { run: `ls -l ${APK}` }], ANDROID_ARTIFACTS)).toBe(true)
    expect(
      jobAssertsArtifact([BUILD, { run: `tar -cf /dev/null ${APK}` }], ANDROID_ARTIFACTS),
    ).toBe(true)
  })

  it('故障对照：只有构建命令、没有产物断言的 job 仍然不通过', () => {
    expect(jobAssertsArtifact([BUILD, { run: 'echo done' }], ANDROID_ARTIFACTS)).toBe(false)
  })
})

/*
 * R7 补强（review `web-round6-grok.md` §4.2 判据洞 2）：
 * 「断言了产物」不等于「断言了**新鲜**产物」。只写 `test -f <apk>` 时，一个把本次
 * 构建换成空转、靠上一轮遗留 APK 的 job 依然能过；判据必须看到 `-nt` 之类的比较。
 */
describe('PW-06 判据：产物断言必须包含新鲜度（-nt / -ot / -newer），不能只 test -f', () => {
  const ANDROID_ARTIFACTS = ['app-debug.apk', 'app/build/outputs']
  const BUILD = { run: 'cd client-web/android && bash gradlew assembleDebug' }
  const APK = 'client-web/android/app/build/outputs/apk/debug/app-debug.apk'
  const EXIST = { run: `test -f ${APK}` }
  const FRESH = { run: `test ${APK} -nt .ci-stamps/android` }

  it('故障对照：只 `test -f` 不算新鲜度断言（旧判据在这里为真，正是那个洞）', () => {
    expect(jobAssertsArtifact([BUILD, EXIST], ANDROID_ARTIFACTS), '前提：旧判据只认存在性').toBe(true)
    expect(
      jobAssertsFreshArtifact([BUILD, EXIST], ANDROID_ARTIFACTS),
      '只 `test -f` 被判为「断言了新鲜产物」：陈旧 APK 仍能假绿',
    ).toBe(false)
  })

  it('反向对照：存在性 + 新鲜度同时具备时必须通过（防止判据恒假）', () => {
    expect(jobAssertsFreshArtifact([BUILD, EXIST, FRESH], ANDROID_ARTIFACTS)).toBe(true)
    expect(jobAssertsFreshArtifact([BUILD, { run: `[[ ${APK} -nt .ci-stamps/android ]]` }], ANDROID_ARTIFACTS)).toBe(true)
    expect(
      jobAssertsFreshArtifact([BUILD, { run: `test -e ${APK} && test .ci-stamps/android -ot ${APK}` }], ANDROID_ARTIFACTS),
    ).toBe(true)
  })

  it('故障对照：逆向 `stamp -nt apk`（stamp 比产物新意味着产物是旧的）必须被拒绝', () => {
    expect(
      jobAssertsFreshArtifact(
        [BUILD, EXIST, { run: `test .ci-stamps/android -nt ${APK}` }],
        ANDROID_ARTIFACTS,
      ),
      '逆向 stamp -nt apk 被误判为新鲜度断言：陈旧 APK 假绿',
    ).toBe(false)
  })

  it('故障对照：逆向 `apk -ot stamp`（产物比 stamp 旧意味着陈旧产物）必须被拒绝', () => {
    expect(
      jobAssertsFreshArtifact(
        [BUILD, EXIST, { run: `test ${APK} -ot .ci-stamps/android` }],
        ANDROID_ARTIFACTS,
      ),
      '逆向 apk -ot stamp 被误判为新鲜度断言：陈旧 APK 假绿',
    ).toBe(false)
  })

  it('故障对照：与无关外部 stamp 比较（非 .ci-stamps/ 目录绑定）必须被拒绝', () => {
    expect(
      jobAssertsFreshArtifact(
        [BUILD, EXIST, { run: `test ${APK} -nt /tmp/epoch` }],
        ANDROID_ARTIFACTS,
      ),
      '外部无关 stamp 被误判为新鲜度断言',
    ).toBe(false)
  })

  it('故障对照：新鲜度比较出现在注释或 echo 里不算', () => {
    expect(
      jobAssertsFreshArtifact([BUILD, { run: `# ${FRESH.run}` }], ANDROID_ARTIFACTS),
      '注释里的新鲜度比较被当成了真实断言',
    ).toBe(false)
    expect(
      jobAssertsFreshArtifact([BUILD, { run: `echo "test ${APK} -nt .ci-stamps/android"` }], ANDROID_ARTIFACTS),
      'echo 出来的新鲜度比较被当成了真实断言',
    ).toBe(false)
  })
})
