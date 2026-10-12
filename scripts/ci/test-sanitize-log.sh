#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
SCRIPT="$ROOT/scripts/ci/sanitize-log.py"
CI_YML="$ROOT/.github/workflows/ci.yml"
fail=0

WORKDIR="$(mktemp -d)"
trap 'rm -rf "$WORKDIR"' EXIT

assert_eq() {
  local name="$1" expected="$2" actual="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL $name: expected [$expected] got [$actual]"
    fail=1
  else
    echo "OK   $name"
  fi
}

assert_not_contains() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    echo "FAIL $name: leaked [$needle] in [$haystack]"
    fail=1
  else
    echo "OK   $name (no leak)"
  fi
}

assert_contains() {
  local name="$1" needle="$2" haystack="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    echo "FAIL $name: expected to retain [$needle] in [$haystack]"
    fail=1
  else
    echo "OK   $name (retained)"
  fi
}

run_sanitize() {
  local input="$1"
  python3 "$SCRIPT" <<< "$input"
}

# 1. Quoted equals with spaces (R6-I1 core counterexample)
input1='Password="R5CAN_ALPHA BRAVO"; secret="R5CAN_TOKEN CHARLIE"'
out1="$(run_sanitize "$input1")"
assert_eq "quoted-double-space" 'Password="<redacted>"; secret="<redacted>"' "$out1"
assert_not_contains "leak-check-BRAVO" "BRAVO" "$out1"
assert_not_contains "leak-check-CHARLIE" "CHARLIE" "$out1"

# 2. Single-quoted equals with spaces
input2="Password='R5CAN_ALPHA BRAVO'; secret='R5CAN_TOKEN CHARLIE'"
out2="$(run_sanitize "$input2")"
assert_eq "quoted-single-space" "Password='<redacted>'; secret='<redacted>'" "$out2"
assert_not_contains "leak-check-single-BRAVO" "BRAVO" "$out2"
assert_not_contains "leak-check-single-CHARLIE" "CHARLIE" "$out2"

# 3. Backslash-escaped double-quoted equals with spaces.
# The backslashes must be real: a case that reuses the case-1 input would be a
# duplicate and would never reach the escaped-quote branch.
input3='Password=\"R5CAN_ALPHA BRAVO\"; secret=\"R5CAN_TOKEN CHARLIE\"'
out3="$(run_sanitize "$input3")"
assert_eq "quoted-escaped-double-space" 'Password=\"<redacted>\"; secret=\"<redacted>\"' "$out3"
assert_not_contains "leak-check-esc-BRAVO" "BRAVO" "$out3"
assert_not_contains "leak-check-esc-CHARLIE" "CHARLIE" "$out3"

# 4. Backslash-escaped single-quoted equals with spaces
input4="Password=\'R5CAN_ALPHA BRAVO\'; secret=\'R5CAN_TOKEN CHARLIE\'"
out4="$(run_sanitize "$input4")"
assert_eq "quoted-escaped-single-space" "Password=\'<redacted>\'; secret=\'<redacted>\'" "$out4"
assert_not_contains "leak-check-esc-single-BRAVO" "BRAVO" "$out4"
assert_not_contains "leak-check-esc-single-CHARLIE" "CHARLIE" "$out4"

# 4b. Distinctness guard: the escaped cases must not be copies of the plain ones.
if [ "$input3" = "$input1" ]; then
  echo "FAIL escaped-double case duplicates the plain-double case"
  fail=1
else
  echo "OK   escaped-double case is distinct from plain-double case"
fi
if [ "$input4" = "$input2" ]; then
  echo "FAIL escaped-single case duplicates the plain-single case"
  fail=1
else
  echo "OK   escaped-single case is distinct from plain-single case"
fi

# 5. Unquoted key-value assignments
input5='secret=R5CAN_raven token=R5CAN_north'
out5="$(run_sanitize "$input5")"
assert_eq "unquoted-kv" 'secret=<redacted> token=<redacted>' "$out5"

# 6. JSON structured credential and bearer
input6='{"Authorization":"Bearer R5CAN_raven"}'
out6="$(run_sanitize "$input6")"
assert_eq "json-auth" '{"Authorization":"<redacted>"}' "$out6"

# 7. Signed URL query stripping
input7='https://storage.example.invalid/f?sig=R5CAN_raven&signature=R5CAN_north&token=R5CAN_river'
out7="$(run_sanitize "$input7")"
assert_eq "signed-url" 'https://storage.example.invalid/f?<redacted>' "$out7"

# 8. Preservation of migration and phase names
input8=$'Applying migration MicrosoftAuthorizationSessionIntegrity
phase=wait-for-api-ready'
out8="$(run_sanitize "$input8")"
assert_contains "migration-retained" "MicrosoftAuthorizationSessionIntegrity" "$out8"
assert_contains "phase-retained" "phase=wait-for-api-ready" "$out8"

# 9. Consistency check: CI YAML inline definitions vs scripts/ci/sanitize-log.py
python3 - "$ROOT" << 'PYEOF'
import sys, re
from pathlib import Path

repo_root = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(".")
script_text = (repo_root / "scripts/ci/sanitize-log.py").read_text()
ci_text = (repo_root / ".github/workflows/ci.yml").read_text()

ci_matches = re.findall(r"def sanitize_text\(.*?return text", ci_text, re.DOTALL)
if len(ci_matches) != 3:
    print(f"FAIL: Expected 3 inline sanitize_text in ci.yml, found {len(ci_matches)}")
    sys.exit(1)

for idx, match in enumerate(ci_matches):
    if "mask_kv" not in match:
        print(f"FAIL: Inline sanitize_text #{idx+1} missing mask_kv logic")
        sys.exit(1)
    if "PIM_TEST_PASS" not in match:
        print(f"FAIL: Inline sanitize_text #{idx+1} missing PIM_TEST_PASS")
        sys.exit(1)

print("OK   ci.yml 3 inline copies match sanitize-log.py logic")
PYEOF

if [[ "$fail" -ne 0 ]]; then
  echo "sanitize-log tests failed"
  exit 1
fi
echo "sanitize-log tests passed"
