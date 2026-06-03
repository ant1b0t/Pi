import urllib.parse

title = "Missing extensions/speech-core/ in npm tarball (v2026.5.28) — \"Unable to resolve bundled plugin public surface speech-core/runtime-api.js\""

body = """### Version

openclaw@2026.5.28 (e932160)

### Description

After upgrading to 2026.5.28, the gateway silently fails to reply to *any* message. Every incoming message hits:

```
Error: Unable to resolve bundled plugin public surface speech-core/runtime-api.js
Embedded agent failed before reply: Unable to resolve bundled plugin public surface speech-core/runtime-api.js
```

### Root cause

The directory `dist/extensions/speech-core/` is **missing from the npm tarball**.

* `image-generation-core` and `media-understanding-core` are present with their `runtime-api.js` artifacts — `speech-core` is absent.
* `facade-activation-check.runtime.js` lists `speech-core` in `ALWAYS_ALLOWED_RUNTIME_DIR_NAMES`, so the runtime tries to resolve it unconditionally and crashes.
* The compiled modules (`speech-core-CNZzyLuY.js`, `tts-runtime-K2ac55wV.js`) *do* exist in the tarball — only the extension directory is missing.

This appears to be the same class of packaging bug as the earlier "missing `dist/tts/tts.js`" fix mentioned in the changelog.

### Workaround

Manually create the missing directory under `/usr/lib/node_modules/openclaw/dist/`:

```bash
mkdir -p dist/extensions/speech-core
cat > dist/extensions/speech-core/runtime-api.js << 'EOF'
import { summarizeText, parseSpeechDirectiveNumberOverride } from "../../speech-core-CNZzyLuY.js";
export { summarizeText, parseSpeechDirectiveNumberOverride };
EOF
cat > dist/extensions/speech-core/openclaw.plugin.json << 'EOF'
{"id":"speech-core","version":"2026.5.28","origin":"bundled","publicArtifacts":[{"basename":"runtime-api.js","kind":"public-surface"}]}
EOF
cat > dist/extensions/speech-core/package.json << 'EOF'
{"name":"@openclaw/speech-core","version":"2026.5.28","private":true}
EOF
systemctl restart openclaw-gateway
```

### Steps to reproduce

1. `npm install -g openclaw@2026.5.28`
2. `openclaw gateway run`
3. Send any message through any channel
4. Observe: `Unable to resolve bundled plugin public surface speech-core/runtime-api.js`

### Expected behavior

`dist/extensions/speech-core/` should be included in the npm tarball, or the runtime should gracefully handle its absence (like it does for other missing public surface artifacts via the MISSING_PUBLIC_SURFACE_PREFIX catch pattern)."""

encoded_title = urllib.parse.quote(title, safe='')
encoded_body = urllib.parse.quote(body, safe='')
url = f"https://github.com/openclaw/openclaw/issues/new?title={encoded_title}&body={encoded_body}"
print(url)
