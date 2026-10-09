# Syrin Note Side Panel — v1.3.7

## Highlights

- **Built-in troubleshooting guide** — the fallback screen opens `troubleshooting.html` from inside the extension package; it no longer depends on a repository URL.
- **Current diagnostics guidance** — the page explains `offline` versus `online-unverified`, sanitized local diagnostics, and that CSP is recorded as `not-inspected` rather than probed by the extension.

## Packaging

Build and verify the Chrome Web Store archive from the repository root:

```bash
bun run scripts/build-extension-zip.ts
bun run scripts/verify-extension-zip.ts
```
