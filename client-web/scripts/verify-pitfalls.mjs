/*
 * P5-B4 坑位自检（04 §API 约定硬点，逐条对真实测试 API 核验）：
 * 1. 双态端点：tasks 带/不带分页参数分别命中 PagedResult / 裸数组
 * 2. PagedResult.totalCount（非 total）
 * 3. outlook batches 的 total 字段
 * 4. /api/v1/status/ 尾斜杠可用
 * 5. 302 下载端点不跟随（files content 端点 redirect: manual）
 * 6. token 15min/refresh 轮换（refresh 后 accessToken 变化）
 *
 * 运行：node scripts/verify-pitfalls.mjs
 *
 * 既可在本地配合真实后端运行，也作为 CI 中 pw09-pitfalls job 的真实 QA 步骤执行（见 AGENTS.md）。
 *    所有判定必须是「能失败」的：拿不到证据的项用 note() 记成 OBSERVED，
 *    不允许出现恒真断言（`true` / `… || true`）——那会让 PASS 失去证明力。
 */
import { apiBase, testCredentials } from './env.mjs'

const BASE = apiBase()
const { username, password } = testCredentials()
const results = []
const notes = []
const ok = (name, cond, detail) => {
  results.push({ name, pass: !!cond, detail })
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`)
}
/** 只记录观察值，不判定通过/失败（用于缺少可判定证据的项） */
const note = (name, detail) => {
  notes.push({ name, detail })
  console.log(`NOTE  ${name}  (${detail})`)
}

async function login() {
  const r = await fetch(`${BASE}/api/v1/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password }),
  })
  const j = await r.json()
  return j.data
}

const { accessToken, refreshToken } = await login()
const H = { Authorization: `Bearer ${accessToken}` }

/* 1/2. 双态端点 + totalCount */
const paged = await (await fetch(`${BASE}/api/v1/calendar/tasks?page=1&pageSize=5`, { headers: H })).json()
ok('① tasks 带分页参数 → PagedResult（items+totalCount）',
  Array.isArray(paged.data?.items) && typeof paged.data?.totalCount === 'number' && 'total' in (paged.data ?? {}) === false,
  `totalCount=${paged.data?.totalCount}`)
const bare = await (await fetch(`${BASE}/api/v1/calendar/tasks`, { headers: H })).json()
ok('① tasks 不带分页参数 → 裸数组', Array.isArray(bare.data), `len=${bare.data?.length}`)

/* 3. outlook batches total 字段 */
const batches = await (await fetch(`${BASE}/api/v1/calendar/outlook/sync/batches?page=1&pageSize=1`, { headers: H })).json()
ok('③ outlook batches 含 total 字段', 'total' in (batches.data ?? {}), `total=${JSON.stringify(batches.data?.total)}`)

/* 4. /api/v1/status/ 尾斜杠 */
const withSlashRes = await fetch(`${BASE}/api/v1/status/`, { headers: H })
const withSlash = await withSlashRes.json()
const noSlashRes = await fetch(`${BASE}/api/v1/status`, { headers: H })
// 无斜杠的行为在服务端默认匹配器上是「另一条候选」，本脚本没有可判定的期望值：
// 只记录实际观测（状态码 + 响应），不写成 PASS。
const noSlashText = await noSlashRes.text()
ok('④ status/ 尾斜杠可用', withSlash.code === 0, `code=${withSlash.code}`)
note(
  '④ status 无斜杠的实际行为（无期望值，不判定）',
  `HTTP ${noSlashRes.status} body=${noSlashText.slice(0, 80).replace(/\s+/g, ' ')}`,
)

/* 5. 302 下载（manual 不跟随；OneDrive 语义）
 * 测试服务器当前 OneDrive 绑定失效（5321），无法实测 302——
 * 前端行为在实现层保证：download-url 返回 JSON → window.open；不 fetch 跟随 302（lib/download.ts）。
 * 没有可判定的断言就不写 ok()：恒真断言会让「0 FAIL」变成假绿。 */
note(
  '⑤ 302 下载语义',
  'OBSERVED-NOT-VERIFIED：测试服务器 OneDrive 未绑定（5321），本次未实测；前端行为由 lib/download.ts 保证（download-url JSON + window.open，不 fetch 跟随）',
)

/* 6. refresh 轮换 */
const ref = await (await fetch(`${BASE}/api/v1/auth/refresh`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ refreshToken }),
})).json()
ok('⑥ refresh 轮换出新 accessToken', typeof ref.data?.accessToken === 'string' && ref.data.accessToken !== accessToken,
  `rotated=${ref.data?.accessToken !== accessToken}`)

/* 单测覆盖（无需真实 API）：409/412 allowStatuses、429 Retry-After、401 单飞 —— client.test.ts */
console.log('\n单测覆盖项（client.test.ts）：409/412 allowStatuses 解包、401 单飞刷新、429 Retry-After 语义')
const fails = results.filter((r) => !r.pass)
console.log(`\n${results.length - fails.length}/${results.length} PASS，${notes.length} 项仅记录（未验证）`)
for (const n of notes) console.log(`  · NOT-VERIFIED ${n.name}`)
process.exitCode = fails.length ? 1 : 0
