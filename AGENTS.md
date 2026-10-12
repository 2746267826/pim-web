# Repository Git Hygiene

This repository is shared by multiple agent conversations. Keep `master` useful as the latest runnable version of the web frontend (`client-web/`) and its shell builds.


## 接口契约与门禁

### 与后端的接口
- 本仓与 `pim-api` 的接口以 `contract/openapi.json` 为准（快照随本仓提交，说明见 `contract/README.md`）。
- **不要凭猜测调用接口**：不得手写或臆测契约里不存在的路径、字段、枚举值。改动涉及接口时，先对照契约确认形状。
- **需要新接口时不要自己造**：把需求写给用户转交后端实现 —— 说明用途、请求方法与路径、请求字段、响应字段、示例。后端在 `pim-api` 实现并更新契约后，本仓再刷新快照并接入。
- 后端契约更新后，用 `scripts/ci/fetch-contract.sh` 刷新本仓快照再提交。快照落后不影响本仓 CI（不阻塞），但接入新字段前必须先刷新。

### 门禁怎么过
- 四个公开仓（api / web / android / windows）的 `master` 有两把锁：**`CI Gate`** 与 **`PIM Independent Acceptance`**。
- **CI 全绿 ≠ 可以合并**：PR 此时仍会显示 `BLOCKED`，因为还差第二把锁的盖章。
- 该 Check Run 只能由独立验收身份发布，**agent 没有权限**。交付后在 PR 里写明「等待独立验收」即可 ——
  **不要重试、不要绕过、不要为了让门禁变绿去改 ruleset 或 `.github/workflows/*`。**

### 本仓特有的两条
- `client-web/src/api/generated.ts` 由 `scripts/ci/fetch-contract.sh` 生成，**禁止手工编辑**；契约更新后重跑该脚本并提交结果。
- 本仓产物不单独发 release（打进 `pim-api` 镜像）。

## Communication And Planning

- Communicate with the user in Simplified Chinese by default.
- For user-facing UI, default visible text to Simplified Chinese. Keep code identifiers, API names, logs, protocol fields, and third-party product names in English unless localization is explicitly part of the task.

## Start Of Every Session

- Run `git status --short --branch` before changing files.
- Run `git fetch --all --prune`; if `master` is behind `origin/master`, pull before making new work unless the user explicitly asks otherwise.
- Move the main workspace to the latest `origin/master` at the start of every conversation, unless the user explicitly asks to base work on another branch (e.g. a handoff task). The main workspace is for read-only investigation; all file-changing work happens in worktrees — see the branch and worktree policy below.
- Note existing dirty files and do not revert or overwrite work you did not create.

## Branch, PR, And GitHub Actions Workflow

- All file-changing work must happen on a non-`master` branch.
- Create branches with an `{agent}-{os}/{topic}` prefix (e.g. `antigravity-linux/location-fix`, `xiaoi-linux/ci-release-serialization`) unless the user asks for another branch name. `agent` is the AI agent's name, `os` is the operating system the agent runs on (`win` or `linux`), and `topic` is a short kebab-case English summary of the branch's purpose. Branches opened automatically by tooling (e.g. `task/<n>`) do not follow this scheme.
- Make focused commits at suitable checkpoints. Push the working branch to GitHub when creating a PR, enabling CI visibility, handing work off, or preserving a useful checkpoint.
- Open a pull request for all file-changing work.
- After opening or updating a PR, wait for triggered GitHub Actions checks and confirm they pass before calling the task complete.
- If no GitHub Actions workflow is triggered because the changed files do not match workflow path filters, state that explicitly instead of waiting.
- Do not modify `.github/workflows/*` unless the task is specifically about CI/release automation or the user explicitly asks for it. If a workflow change is unavoidable, explain why before editing it.
- Write PR titles and descriptions in both English and Simplified Chinese.
- Create git worktrees under a single short root directory per platform, never scattered across filesystem roots:
  - **Windows**: `C:\pim-wt\{topic}`. Use short directory names (topic only, ≤ 12 chars) to avoid Windows MAX_PATH issues from long nested paths.
  - **Linux (codeg workspace)**: `/home/coder/workspace/pim-wt/{topic}`. **Never use `/tmp`** (wiped on rebuild, losing in-progress work). No MAX_PATH constraint, but keep names short for consistency. Other Linux agents use `pim-wt/{topic}` under their own persistent work directory.

### Branch And Worktree Policy (L0/L1/L2)

Apply this policy at the start of every session/task:

- **L0 — read-only sessions** (investigation, discussion, review, inspection): make no file changes; work directly in the main workspace. Before investigating, run `git fetch --all --prune` and fast-forward local `master` to `origin/master` — the remote is the source of truth, so the main workspace must always read the latest `master`. The main workspace is a valid baseline only after it has been fast-forwarded to `origin/master` this session; otherwise read baseline content via `git show origin/master:<path>` or an up-to-date worktree. Targeted reads (PR head/diff, handoff source branch, local changes under review) read their own target refs and are compared against the latest `origin/master`. No branch or worktree is created.
- **L1 — file-changing tasks**: before editing any file, fetch the latest `origin/master`, create a branch `{agent}-{os}/{topic}` based on it, and add a worktree for that branch. Do all edits inside that worktree; the main workspace never receives file changes.
- **L2 — handoff tasks**: when new work must build on an unmerged branch (e.g. continuing another agent's PR), base the new branch on that branch's latest HEAD and state the base in the PR description. If the source branch is already merged, base on `origin/master` instead.
- Cleaning is part of the definition of done: when a PR is merged or work is abandoned, remove the worktree (`git worktree remove`) and delete the local branch in the same task. Dead worktrees/branches from earlier tasks must be cleaned when noticed — e.g. if the main workspace is found on a stale or merged branch, move it back to `origin/master` before starting new work.

## Pull Request Descriptions Feed The Release Changelog

- Every PR description MUST include the four bilingual sections below, keeping the exact heading format. `.github/pull_request_template.md` carries them; the release tooling reads them from the PR body when a release is produced:
  - `## 技术修改 / Technical changes` — modules/files touched, key design decisions, API or schema changes, dependency changes
  - `## 功能变化 / Feature changes` — user-visible changes; write `无 / None` if none
  - `## 如何体验 / How to try it` — how a user experiences the feature: which screen, what actions, what visible effect to expect (step-by-step is fine). This is an experience guide for users, NOT deployment/build instructions — build/run/verify commands belong in 测试 / Tests
  - `## 测试 / Tests` — verification commands run and their results
- PRs without these sections still merge, but their release entry falls back to a bare title link — filling them in keeps the changelog useful.
- 现状（与 workflow 一致）：本仓 `ci.yml` 的 **`CI Gate`** 消费七个 job —— `resolve-version`、`build-web`（lint、单测、`audit-tests` 类型检查、契约新鲜度、构建与打包产物）、`repo-script-tests`（真实执行仓库 CI 自测脚本 `scripts/ci/test-resolve-version.sh`，见下）、`shell-android`（Capacitor 壳：JDK 21 + `npx cap sync android` + `gradlew assembleDebug` / `testDebugUnitTest`，并**断言 APK 存在且比本次构建的 stamp 新**）、`shell-tauri`（Tauri 壳：Linux 原生依赖 + `cargo test` / `cargo build`，并同样断言产物存在且新鲜）、`pr-metadata`（**真实执行** `scripts/ci/check-pr-body.sh`）与 `pw09-pitfalls`（**真实执行** `client-web/scripts/verify-pitfalls.mjs` 于隔离 Postgres + 固定 pim-api 环境）。本仓 **没有**创建 GitHub Release 的 job。
- **`pr-metadata` 在 pull_request 上真的会拦截**：`pull_request` 事件包含 `edited` 类型，所以改写（或改坏）PR 描述会重跑校验；`push` 上没有 PR body，脚本自己 `exit 0`，因此该 job **不带 `if:`**（用 `if:` 限制成只在 `pull_request` 上跑会让它在 push 时 `skipped`，而现有 Gate 把 `skipped` 当失败）。校验内容是 `.github/pull_request_template.md` 的四段双语标题**行**（整行逐字匹配，正文内联提一句不算）与分支名 `{agent}-{os}/{topic}` / 工具分支 `task/<n>`（`dependabot/`、`renovate/` 例外）；只看当前事件的 payload，不追溯历史 PR。
- `shell-android` / `shell-tauri` 的产物断言不是「命令里出现 gradlew」：构建命令退出 0 之外，还必须存在**比构建前 stamp 更新**的 APK / 二进制，否则 Gate 失败（空 `gradlew`、陈旧产物都过不了）。
- 新增 `scripts/ci/test-*.sh` 时必须同时把一条**真实执行**它的命令加进 `ci.yml` 的 `repo-script-tests`（job 已在 `CI Gate` 的 `needs` 里）；审计测试会检查每个 `test-*.sh` 都有 job 真实执行、且该 job 被 gate 消费。`echo <脚本名>` 这类空转不算执行。
- 注意：`ci.yml` 没有 `paths:` / `paths-ignore:` 过滤。任何合并到 `master` 的改动（含 docs-only）都会触发构建并产出打包产物；不要以为 docs-only 会被跳过。

## During Work

- Keep generated outputs out of commits: `node_modules/`, `dist/`, `shell-dist/`, `client-web/android/app/build/`, `client-web/src-tauri/target/`, npm caches.
- Commit source changes, tests, scripts, and docs that are needed to reproduce the current runnable version.
- Keep API and daemon defaults aligned. The local API is expected at `http://127.0.0.1:5858`, and the Windows daemon default server URL should match it.
- Use focused commits with conventional messages such as `feat:`, `fix:`, `docs:`, or `chore:`. Write both commit messages (titles & descriptions) and PR titles/descriptions in bilingual format (English and Simplified Chinese).

## Before Pushing Or Opening A PR

- Run `cd client-web && npm run test` and `npm run build` for any frontend change (the working directory is described in `README.md`); UI-visible changes also run the repeatable scripts in `client-web/scripts/` (`verify-pitfalls.mjs`, `qa-screenshots.mjs`, `qa-three-states.mjs`) against a real backend — see 需要真实后端的本地脚本 below; verify-pitfalls.mjs is in CI, while only qa-screenshots.mjs and qa-three-states.mjs require manual runs outside CI.
- Re-run `git status --short --branch` and confirm only intentional changes are staged.
- Push the working branch to `origin` and open a pull request. Do not push directly to `master` unless the user explicitly asks for a direct update and understands it bypasses the PR workflow.

## 需要真实后端的本地脚本（除 verify-pitfalls 进 CI 外部署外不进 gate）

`client-web/scripts/` 下的多数脚本要连真实后端、测试账号或浏览器/OneDrive 等外部条件，
除 `verify-pitfalls.mjs` 已作为 CI 隔离任务 `pw09-pitfalls` 真实执行并受 CI Gate 约束外，
其余脚本**不进入 CI gate**（CI 里没有对应外部环境，硬跑只会得到环境错误而不是业务结论）：

- `verify-pitfalls.mjs` — 逐条核验 04 §API 约定硬点（tasks 双态、totalCount、尾斜杠、refresh 轮换）。已在 CI 的 `pw09-pitfalls` 隔离 job 中真实执行并受 gate 约束；也可在本地对真实测试 API 运行。没有可判定证据的项用 `note()` 记成 OBSERVED，不写恒真断言、也不算 PASS。
- `verify-backend-20260930.mjs` — 一次性后端核验脚本，不进入 CI gate。
- `qa-screenshots.mjs`、`qa-three-states.mjs` — 需要真实后端 + 浏览器（Playwright）的人工 QA 截图，不进入 CI gate。
- `probe-endpoints.py`、`probe-get.py`、`extract-endpoints.py` — 一次性端点探测/抽取工具，不进入 CI gate。

这些脚本的结论只能来自**真实运行并保留原始输出**；除已进入 CI 的 `verify-pitfalls.mjs` 外，其余脚本不进入 CI gate。

## If Verification Fails

- Do not claim the branch is complete.
- Commit only if the failure is clearly unrelated and document the exact failure in the final response.

## Working Practices (derived from session experience)

### Process discipline

- **A1. Mandatory TDD (RED-GREEN-REFACTOR).** Write a failing test and watch it fail before writing the minimal implementation. Never substitute a "looks right" implementation for real concurrency/timing correctness.
- **A2. Verify before claiming done, using fresh output only.** Re-run the relevant gate commands and base claims on that run, never on stale results. Re-run the full suite once before commit and once before opening a PR.
- **A3. Review is a mandatory gate: severity-graded, zero-blockers to proceed.** Classify findings Critical/Important/Minor; no Important+ findings may remain before commit/merge. After fixing, always re-review the changed result.
- **A4. Review cadence.** Small changes: single review round, then re-review after fixes. Large stages: one holistic review at stage end.
- **A5. Deliverables carry explicit acceptance criteria.** State in the PR both how success will be judged after merge and how to test it, written in plain language (avoid overly technical control names and jargon).

### Quality habits

- **B1. Use injected clocks in tests; never fixed timestamps.** Prefer TimeProvider/clock injection over direct UtcNow and hard-coded dates.
- **B2. Classify test failures before fixing.** Failures may be environmental: wrong cwd (relative-path false positives), build-tool injection (Playwright evaluate rewritten by esbuild), or CI-only races. Confirm the failure's ownership before changing product code or tests.
- **B3. Bug fixing is log/data-driven; disproving assumptions is normal.** Locate issues from logs, data, and precise timelines before touching code. When an assumption is falsified, restart that line of investigation.
- **B4. Verify external sub-agent output.** Delegated workers may fabricate, exit early, or return unreliable conclusions. Check their actual tool-call traces and require reproducible evidence; re-dispatch on anomalies.
- **B5. Security review for anything touching external URLs, credentials, or privacy.** Whitelist-style validation must be re-checked against "follow what the server returns" semantics. Logs/confirmation pages must not leak tokens, GraphEventId, ChangeKey, etc. Tokens live in memory or encrypted storage only — never in WebView or uploads.

### Collaboration

- **C1. Maximize parallelism, serialize writes.** Read/investigation/review tasks run in parallel; file-writing tasks serialize or declare non-overlapping paths. Do not use subagents for tightly coupled edits where coordination overhead would create risk.
- **C2. Leave resumable state when interrupted.** End sessions by stating the current step and what the next agent should do first.

## Production Database And Logs

- Production runs on the home Docker host: the API in the `pim-pim-1` container, the database `pim_prod` in the 1Panel PostgreSQL container (`127.0.0.1:5432`).
- **Never point an agent session at `pim_prod`.** Work that needs real data uses the mirrored database `pim_test`, restored from a `pim_prod` snapshot (`pg_dump -Fc` → `pg_restore`) with credentials and personal tokens sanitized. The mirror is disposable and safe to mutate; its contents are "as of the snapshot time", so never write results back to production.
- Production logs are JSONL files inside the running container — `/data/pim/logs/pim-api-<YYYYMMDD>[_NNN].jsonl` (Serilog compact JSON; `@t` is UTC, and files roll at ~1 GB so the newest data may live in a `_NNN` file). Read them with `docker exec pim-pim-1 tail` / `grep`; `docker logs` only carries startup and crash output.
- Never copy production dumps, log extracts, or credentials into a PR, an issue, or any artifact.
