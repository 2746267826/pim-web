#!/usr/bin/env python3
"""
CI 日志脱敏工具 (Sanitize Log Helper)
用于脱敏包含凭据、令牌、签名 URL 等敏感信息的 CI 日志文件。
"""
import sys
import re

def sanitize_text(text: str) -> str:
    # 移除所有 HTTP/HTTPS URL query，避免敏感签名凭据遗漏（AWS/Azure/Google等）
    text = re.sub(r"(https?://[^\s\"<>?#]+)\?[^\s\"<>#]+", lambda m: m.group(1) + "?<redacted>", text)
    sens = r"accessToken|refreshToken|token|secret|password|passwd|api[_-]?key|client[_-]?secret|Authorization"
    # JSON 转义字符串及带空格值：完整捕获并替换为 <redacted>
    text = re.sub(r"(\\?\"?(" + sens + r")\\?\"?\s*:\s*\\?\")([^\"\\]|\\.)*(\\?\")", lambda m: m.group(1) + "<redacted>" + m.group(4), text, flags=re.IGNORECASE)
    # JSON 非字符串敏感值
    text = re.sub(r"(\\?\"?(" + sens + r")\\?\"?\s*:\s*)(?!\\?\"|<redacted>)[^,}\s\r\n]+", lambda m: m.group(1) + "<redacted>", text, flags=re.IGNORECASE)
    # 头部 Authorization / Bearer 凭据
    text = re.sub(r"(Authorization\s*[:=]\s*)[^\r\n\",;]+", lambda m: m.group(1) + "<redacted>", text, flags=re.IGNORECASE)
    text = re.sub(r"(Bearer\s+)[^\r\n\",; \t]+", lambda m: m.group(1) + "<redacted>", text, flags=re.IGNORECASE)
    # 键值对赋值 (Password=..., PIM_TEST_PASS=..., secret=...)
    dq = chr(34)
    sq = chr(39)
    esc_dq = "\\" + dq
    esc_sq = "\\" + sq
    pattern = (
        r"(\b(" + sens + r"|PIM_TEST_PASS)\s*[:=]\s*)"
        + r"(" + re.escape(esc_dq) + r"(?:[^\r\n" + dq + r"\\]|\\.)*?" + re.escape(esc_dq) + r"|"
        + dq + r"(?:[^" + dq + r"\r\n\\]|\\.)*" + dq + r"|"
        + re.escape(esc_sq) + r"(?:[^\r\n" + sq + r"\\]|\\.)*?" + re.escape(esc_sq) + r"|"
        + sq + r"(?:[^" + sq + r"\r\n\\]|\\.)*" + sq + r"|"
        + r"[^;\r\n" + dq + sq + r"\s\t]+)"
    )
    def mask_kv(m):
        k, v = m.group(1), m.group(3)
        if v.startswith(esc_dq) and v.endswith(esc_dq):
            return k + esc_dq + "<redacted>" + esc_dq
        elif v.startswith(dq) and v.endswith(dq):
            return k + dq + "<redacted>" + dq
        elif v.startswith(esc_sq) and v.endswith(esc_sq):
            return k + esc_sq + "<redacted>" + esc_sq
        elif v.startswith(sq) and v.endswith(sq):
            return k + sq + "<redacted>" + sq
        else:
            return k + "<redacted>"
    text = re.sub(pattern, mask_kv, text, flags=re.IGNORECASE)
    return text

def main():
    if len(sys.argv) < 2:
        content = sys.stdin.read()
        sys.stdout.write(sanitize_text(content))
    else:
        for file_path in sys.argv[1:]:
            with open(file_path, "r", encoding="utf-8", errors="replace") as f:
                content = f.read()
            sys.stdout.write(sanitize_text(content))

if __name__ == "__main__":
    main()
