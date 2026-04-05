from pathlib import Path
import re
import sys

TARGETS = [
    Path("extensions/base/base-tools.ts"),
    Path("extensions/base/base-agents.ts"),
    Path("extensions/provider-smartrouter.ts"),
]

patterns = [
    re.compile(r"const\s+globalKey\s*=\s*[\"']__pi_vs_cc_.*?_loaded__[\"']"),
    re.compile(r"if\s*\(\s*\(globalThis\s+as\s+Record<string,\s*unknown>\)\s*\[globalKey\]\s*\)\s*return;"),
]

violations = []
for path in TARGETS:
    text = path.read_text(encoding="utf-8")
    for pattern in patterns:
        if pattern.search(text):
            violations.append(f"{path}: matches forbidden reload-guard pattern: {pattern.pattern}")

if violations:
    print("Runtime reload guard check FAILED", file=sys.stderr)
    for line in violations:
        print(line, file=sys.stderr)
    sys.exit(1)

print("Runtime reload guard check OK")
