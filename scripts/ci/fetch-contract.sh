#!/usr/bin/env bash
# 从 pim-api 仓库拉取客户端契约并生成 TypeScript 类型。
#
# 契约来源：pim-api 仓的 contract/openapi.json（由该仓 CI 从 Test 环境实例导出并校验新鲜度）。
# 产物：
#   client-web/src/api/generated.ts   （提交进仓库，便于 diff 与门槛校验）
#   contract/openapi.json             （只读快照）
#   contract/provenance.json          （本次请求的上游 ref 与实际内容 SHA，可机械核对）
#
# 用法：
#   scripts/ci/fetch-contract.sh            # 用默认分支（master）
#   PIM_CONTRACT_REF=<sha|branch> scripts/ci/fetch-contract.sh
#
# 身份闭环（PW-21）：写进 provenance 的 upstreamRef 必须是**不可变提交 SHA**——
# 传入分支/标签时用 `git ls-remote` 向公开只读上游解析（不需要凭据）；
# 然后按该 SHA 再取一次契约，字节必须与第一次取到的一致，否则脚本失败。
# 本步骤在 CI 里真实执行（有网络），因此不依赖本地 clone，也不存在 skip 分支。
set -euo pipefail

REPO="${PIM_CONTRACT_REPO:-2746267826/pim-api}"
REF="${PIM_CONTRACT_REF:-master}"
RAW_BASE="${PIM_CONTRACT_RAW_BASE:-https://raw.githubusercontent.com}"
# 上游 git 远端：只用来把分支/标签解析成提交 SHA（公开只读仓库）
REMOTE="${PIM_CONTRACT_REMOTE:-https://github.com/$REPO.git}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLIENT_DIR="$ROOT/client-web"
OUT="$CLIENT_DIR/src/api/generated.ts"
CONTRACT_SNAPSHOT="$ROOT/contract/openapi.json"
PROVENANCE="$ROOT/contract/provenance.json"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

fetch_contract() {
  # $1 = 要取的 ref（分支 / 标签 / 提交 SHA）
  curl -fsSL "$RAW_BASE/$REPO/$1/contract/openapi.json" -o "$2"
}

echo "==> 拉取契约 $REPO@$REF"
if ! fetch_contract "$REF" "$TMP/openapi.json"; then
  echo "::error::无法拉取契约 $RAW_BASE/$REPO/$REF/contract/openapi.json" >&2
  exit 1
fi
SIZE=$(wc -c < "$TMP/openapi.json")
echo "    契约大小：$SIZE 字节"

if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
  RESOLVED="$REF"
else
  # 让来源记录指向不可变提交，而不是会移动的分支名
  RESOLVED="$(git ls-remote "$REMOTE" "refs/heads/$REF" "refs/tags/$REF" "refs/tags/$REF^{}" 2>/dev/null | awk '{print $1}' | head -n 1)"
  if [ -z "$RESOLVED" ]; then
    echo "::error::无法在只读上游 $REMOTE 解析 ref \"$REF\"；来源记录不允许写一个未经验证的引用" >&2
    exit 1
  fi
fi
echo "    解析为提交：$RESOLVED"

CONTENT_SHA="$(sha256sum "$TMP/openapi.json" | awk '{print $1}')"

# 权威字节复核：按解析出的提交 SHA 再取一次，两次字节必须完全一致。
# 这既证明该 SHA 在上游可解析，也证明快照内容确实来自该提交。
if ! fetch_contract "$RESOLVED" "$TMP/openapi.pinned.json"; then
  echo "::error::无法按提交 $RESOLVED 取回上游契约字节（ref 不可解析或网络失败）" >&2
  exit 1
fi
PINNED_SHA="$(sha256sum "$TMP/openapi.pinned.json" | awk '{print $1}')"
if [ "$CONTENT_SHA" != "$PINNED_SHA" ]; then
  echo "::error::按 $REF 取到的契约与按提交 $RESOLVED 取到的字节不一致（上游在两次读取之间发生了变化）" >&2
  echo "  $REF    : $CONTENT_SHA" >&2
  echo "  $RESOLVED: $PINNED_SHA" >&2
  exit 1
fi
echo "    内容 SHA：$CONTENT_SHA（与提交 $RESOLVED 的字节一致）"

BANNER='// 本文件由 scripts/ci/fetch-contract.sh 自动生成，请勿手工编辑。
// 来源：'"$REPO"'@'"$REF"' 的 contract/openapi.json
// 更新方式：在 pim-web 下执行 scripts/ci/fetch-contract.sh 并提交结果。
'

{
  printf '%s' "$BANNER"
  # 直接用 client-web 下已安装的 CLI（绝对路径）：
  # CI 里本步骤在仓库根执行，npx 在根目录找不到 client-web/node_modules；
  # 也不用 npx 拉最新版，避免 CI 与本地产物不一致。
  CONTRACT_CLI="$CLIENT_DIR/node_modules/.bin/openapi-typescript"
  if [ ! -x "$CONTRACT_CLI" ]; then
    echo "::error::未找到 $CONTRACT_CLI，请先在 client-web 下执行 npm ci" >&2
    exit 1
  fi
  "$CONTRACT_CLI" "$TMP/openapi.json"
} > "$OUT"

echo "==> 已写入 $OUT（$(wc -l < "$OUT") 行）"

# 同时把原始契约存进本仓 contract/，供开发时对照（不要手工编辑，见 contract/README.md）
mkdir -p "$(dirname "$CONTRACT_SNAPSHOT")"
cp "$TMP/openapi.json" "$CONTRACT_SNAPSHOT"
echo "==> 已更新契约快照 $CONTRACT_SNAPSHOT（$SIZE 字节）"

# 来源记录（唯一机读来源；内容确定，不含时间戳，便于随快照一起提交与复核）
cat > "$PROVENANCE" <<JSON
{
  "repo": "$REPO",
  "upstreamRef": "$RESOLVED",
  "contentSha256": "$CONTENT_SHA",
  "snapshotBytes": $SIZE,
  "sourcePath": "contract/openapi.json"
}
JSON
echo "==> 已写入来源记录 $PROVENANCE（upstreamRef=$RESOLVED）"
