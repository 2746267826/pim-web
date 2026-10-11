#!/usr/bin/env bash
#
# PR 元数据门禁（PW-23 / REQ-COM-05）。
#
# 只处理**当前事件**的 payload（不查历史 PR），在 pull_request 事件上校验：
#   1. PR 描述里必须有四段双语标题，且必须是**独立的标题行**（不做子串匹配：
#      正文里顺口提一句「测试 / Tests」不算填过模板）；
#   2. 源分支名必须是 `{agent}-{os}/{topic}` 或工具分支 `task/<n>`；
#      dependabot / renovate 这类工具分支按既有例外放行。
#
# 非 pull_request 事件（push / workflow_dispatch）：PR 元数据不适用，
# 脚本**自己**以 0 结束。不要用 job 级 `if:` 把它限制在 pull_request 上 ——
# 那样 push 时这个 job 会 skipped，而现有 CI Gate 把 skipped 当失败，会误伤 push。
#
# 输入（全部来自 workflow 里的 github.event.pull_request.*，不读网络、不读历史）：
#   GITHUB_EVENT_NAME  事件名
#   PR_BODY            PR 描述原文（push 上为空）
#   PR_HEAD_REF        源分支名
#
# 用法：bash scripts/ci/check-pr-body.sh
set -uo pipefail

EVENT="${GITHUB_EVENT_NAME:-}"
BODY="${PR_BODY:-}"
HEAD_REF="${PR_HEAD_REF:-}"

REQUIRED_HEADINGS=(
  '## 技术修改 / Technical changes'
  '## 功能变化 / Feature changes'
  '## 如何体验 / How to try it'
  '## 测试 / Tests'
)

if [ "$EVENT" != 'pull_request' ]; then
  echo "PR 元数据校验：事件为 '${EVENT:-<未设置>}'（非 pull_request），本项不适用 → 成功结束。"
  exit 0
fi

fail=0

# 标题行比较：去掉 CR 与首尾空白后**整行相等**（与 changelog 提取器同一口径）；
# 正文里内联提到标题不算。
normalized_body="$(printf '%s\n' "$BODY" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
has_heading() {
  printf '%s\n' "$normalized_body" | grep -Fxq -- "$1"
}

missing=()
for heading in "${REQUIRED_HEADINGS[@]}"; do
  if ! has_heading "$heading"; then
    missing+=("$heading")
  fi
done
if [ "${#missing[@]}" -ne 0 ]; then
  echo "❌ PR 描述缺少这些双语标题行（要逐字保留，不能改写/翻译/内联）："
  for h in "${missing[@]}"; do echo "   - $h"; done
  fail=1
else
  echo "✅ PR 描述包含全部四段双语标题行"
fi

# 分支名：{agent}-{os}/{topic}（os ∈ win|windows|linux|mac|osx）或工具分支 task/<n>；
# dependabot / renovate 是既有工具分支，按例外放行。
branch_ok() {
  local b="$1"
  case "$b" in
    '') return 1 ;;
    task/[0-9]*) return 0 ;;
    dependabot/*|renovate/*) return 0 ;;
  esac
  printf '%s' "$b" | grep -Eq '^[A-Za-z0-9._-]+-(win|windows|linux|mac|osx)/[A-Za-z0-9._/-]+$'
}

if [ -z "$HEAD_REF" ]; then
  echo "❌ 拿不到 PR 源分支名（PR_HEAD_REF 为空）"
  fail=1
elif branch_ok "$HEAD_REF"; then
  echo "✅ 源分支名 '${HEAD_REF}' 符合 {agent}-{os}/{topic}（或工具分支例外）"
else
  echo "❌ 源分支名 '${HEAD_REF}' 不符合 {agent}-{os}/{topic}（工具分支 task/<n>、dependabot/、renovate/ 例外）"
  fail=1
fi

if [ "$fail" -ne 0 ]; then
  echo ''
  echo "::error::PR 元数据校验未通过：请按 .github/pull_request_template.md 补齐四段双语章节，并使用合规分支名。"
  exit 1
fi

echo ''
echo 'PR 元数据校验通过（四段双语章节 + 分支名）。'
