# Chrome Web Store Listing — Syrin Note Side Panel

Copy-paste–ready content for the submission form. Update the YouTube URL
after uploading your demo video as **unlisted**.

---

## Item details

**Name** (≤45 chars)
```
Syrin Note — Side Panel Markdown
```

**Summary** (≤132 chars)
```
Markdown notes in Chrome's side panel. Write while you read. Press Alt+S to open. No tracking, no account required.
```

**Category**: Productivity
**Language**: English (United States)

**Detailed description**
```
Syrin Note lives in Chrome's side panel so you can write notes without leaving the page you're reading.

— Press Alt+S anywhere in Chrome to open the panel.
— Markdown with live preview: GFM, code blocks (highlight.js), math (KaTeX), Mermaid diagrams, wiki-links [[like-this]].
— Realtime autosave (Yjs + IndexedDB). Works offline; syncs when you're back.
— Optional client-side AES-GCM encryption. The key is derived from your passphrase in your browser and never leaves your device.
— Choose what opens on launch: a random new note, a specific slug, or the last note you had open. The toolbar badge shows H / S / L so you always know.
— No tracking, no analytics, no remote code, no host permissions. The extension is a thin wrapper around https://note.syrin.online.
— Optional device-local reliability diagnostics are never uploaded automatically. Events older than 7 days are discarded the next time diagnostics are read or written; if the extension is dormant, expired entries can remain until then.

Open source. Privacy policy: https://note.syrin.online/privacy
```

---

## What's new — v1.3.7

```
• The fallback screen now opens a built-in troubleshooting guide packaged inside the extension.
• The guide explains the current offline/online-unverified and not-inspected CSP diagnostics without relying on a repository URL.
```

(Previous releases: v1.2.0 added the badge + postMessage handshake;
v1.1.0 added the Settings page and Alt+S shortcut.)

---

## Permission justifications

**sidePanel** — required to render the Syrin Note app inside Chrome's side panel via `sidepanel.html`.

**storage** — saves the user's Settings (default slug, open mode, debug toggle) and last-opened note locator to `chrome.storage.sync`. If sync is unavailable, the panel uses safe defaults rather than copying locators into device-local storage. `chrome.storage.local` stores edit capabilities, the diagnostics opt-in, and optional reliability diagnostics. Owner capabilities are never stored by the extension or synced. Events older than 7 days are discarded the next time diagnostics are read or written; if the extension is dormant, expired entries can remain until then. Diagnostics are never uploaded automatically.

**Host permissions**: none. The extension does not request access to any website.

**Remote code**: none. All JavaScript is bundled in the extension. The side panel embeds `https://note.syrin.online` inside an `<iframe>`; that page is the same web app installable as a PWA.

---

## Single purpose

```
Open Syrin Note (https://note.syrin.online) inside Chrome's side panel so users can take markdown notes alongside any page they're reading.
```

---

## Privacy practices

| Question | Answer |
|----------|--------|
| Does this item handle user-generated content? | Yes. Note content entered in the embedded web app is synchronized by the web service; it is plaintext unless the user enables client-side encryption. |
| Does this item handle extension settings? | Yes. Open mode, a default/last note locator, and debug preferences use Chrome storage. |
| Does this item handle authentication info? | No account is required. Optional encryption passphrases remain in the browser. |
| Does this item handle health/financial info? | No |
| Does this item handle web history? | No |
| Does this item handle location? | No location feature or IP geolocation. Hosting and backend providers necessarily process standard connection metadata such as IP address. |
| Does this item use local diagnostics? | Optional, bounded technical events only. Events older than 7 days are discarded the next time diagnostics are read or written; if the extension is dormant, expired entries can remain until then. They are never uploaded automatically. |
| Does this item use remote code? | No executable extension code is loaded remotely. The side panel embeds the HTTPS web app described above. |
| Privacy policy URL | https://note.syrin.online/privacy |
| Support email | (your email) |

Information received from Chrome APIs is used only for the extension's single purpose and in accordance with the Chrome Web Store User Data Policy, including its Limited Use requirements.

---

## Screenshots (1280×800)

Upload all 5 from `/mnt/documents/chrome-store/`:

| File | Caption |
|------|---------|
| `screenshot-1-hero.png` | Write while you read — notes alongside any page |
| `screenshot-2-settings.png` | Choose what opens: homepage, specific note, or last opened |
| `screenshot-3-default-slug.png` | Toolbar badge shows H / S / L for the current open mode |
| `screenshot-4-preview.png` | Markdown with live preview — GFM, code, math, mermaid |
| `screenshot-5-lock.png` | Optional client-side AES-GCM encryption |

Promo tiles also in `/mnt/documents/chrome-store/`:
- `tile-440x280.png` (Small promo tile — required)
- `marquee-1400x560.png` (Marquee — optional, boosts placement)
- `promo-920x680.png` (Large promo — optional)

---

## Video (20s, unlisted YouTube)

Embed URL: `https://www.youtube.com/watch?v=YOUR_VIDEO_ID`

Recording script:

| Time | Action |
|------|--------|
| 0–3s | Browse any webpage in Chrome. |
| 3–5s | Press **Alt+S** — side panel slides in. |
| 5–12s | Type markdown; preview renders live in the panel. |
| 12–17s | Right-click toolbar icon → Options → set default slug → Save. Badge changes to **S**. |
| 17–20s | Close + reopen panel — it lands on the configured slug. End on the watercolor "N" logo. |

Upload as **Unlisted**, paste the URL into the "Promotional video" field.

---

## Optional Vietnamese translation

**Name**: `Syrin Note — Ghi chú Side Panel`
**Summary**: `Ghi chú markdown trong side panel của Chrome. Vừa đọc vừa viết. Nhấn Alt+S để mở. Không tracking.`
**Description**: dịch các bullet ở mục Detailed description ở trên.
