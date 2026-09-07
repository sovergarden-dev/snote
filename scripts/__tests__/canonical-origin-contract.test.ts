import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CANONICAL_ORIGIN = "https://note.syrin.online";

const publicSurfaces = [
  "index.html",
  "README.md",
  "public/robots.txt",
  "public/sitemap.xml",
  "src/pages/RawView.tsx",
  "src/lib/pwa-update-readiness.ts",
  ".github/workflows/pwa-update-smoke-post-deploy.yml",
] as const;

describe("canonical production origin", () => {
  it("uses note.syrin.online on every public app surface", () => {
    for (const path of publicSurfaces) {
      const source = readFileSync(path, "utf8");
      expect(source, path).toContain(CANONICAL_ORIGIN);
      expect(source, path).not.toContain("https://syrin.online");
      expect(source, path).not.toContain("https://snote.lovable.app");
      expect(source, path).not.toContain("https://www.note.syrin.online");
    }
  });

  it("labels capability security as a deferred target instead of live production", () => {
    const readme = readFileSync("README.md", "utf8");
    const findings = readFileSync("docs/security-findings.md", "utf8");

    expect(readme).toMatch(
      /Production currently runs canary-on `CutoverNotePage`/,
    );
    expect(readme).toContain("`capabilityRoutesEnabled` true");
    expect(readme).toContain("77d791af");
    expect(readme).toContain("findings §3e");
    expect(readme).toContain("Phase C");
    expect(readme).toContain("RawView");
    expect(readme).toMatch(/LNO `open`/);
    expect(readme).toMatch(/LNO `exists`/);
    expect(readme).toContain("Home mints capabilities when canary is on");
    expect(readme).toContain("fail-closed on idle");
    expect(readme).toContain("LegacyNotePage");
    expect(readme).not.toMatch(/origin `7d00fd52`/);
    expect(readme).not.toMatch(/live origin `c5914c8e`/);
    expect(readme).not.toMatch(/live origin `386421e8`/);
    expect(readme).not.toMatch(/live origin `4baa8966`/);
    expect(readme).not.toMatch(/live origin `7335fadc`/);
    expect(readme).not.toMatch(/live origin `8d9ce025`/);
    expect(readme).not.toMatch(/live origin `e39caacd`/);
    expect(readme).not.toMatch(/live origin `4c791861`/);
    expect(readme).not.toMatch(/live origin `92aa4e0d`/);
    expect(readme).not.toMatch(/live origin `1f21777e`/);
    expect(readme).not.toMatch(/live origin `d15aee5d`/);
    expect(readme).not.toMatch(/live origin `4c846592`/);
    expect(readme).not.toMatch(/live origin `4ef734ee`/);
    expect(readme).not.toMatch(/live origin `27da93eb`/);
    expect(readme).not.toMatch(/live origin `e05c73ea`/);
    expect(readme).not.toMatch(/live origin `addeeb29`/);
    expect(readme).not.toContain("Home does not mint capabilities");
    expect(readme).not.toMatch(/capability\s+routes disabled/);
    expect(readme).not.toMatch(/SPA canary remain off/);
    expect(readme).toMatch(/SQL 240 is not applied/);
    expect(readme).toMatch(/soak ≥48h started from the first canary/);
    expect(readme).toMatch(/not soak-complete/);
    expect(readme).toMatch(
      /The capability model below is the target post-cutover architecture, not the\s+authorization model currently active in production\./,
    );
    expect(findings).toContain(
      "Production `anon` can still write `public.notes` (SQL 240 not applied;",
    );
    expect(findings).not.toContain(
      "Production legacy write path is still live (`NotePage` `legacyOnly`,",
    );
    expect(findings).toMatch(
      /Additive SQL `20260722000000_capability_backend\.sql` is\s+applied on production/,
    );
    expect(readme).toContain("`writes_enabled=true`");
    expect(readme).toContain("`private_realtime_enabled=false`");
    expect(readme).not.toMatch(/kill switch closed/);
    expect(findings).toContain(
      "`writes_enabled=true`, `private_realtime_enabled=false`",
    );
    expect(findings).not.toContain("Kill switch still closed");
    expect(findings).not.toContain(
      "closed kill switch (`writes_enabled=false`, `private_realtime_enabled=false`).",
    );
    expect(findings).toMatch(
      /Additive SQL `20260727000000_capability_sync_conflict_codes\.sql` is\s+(?:also\s+)?applied/,
    );
    expect(findings).toContain("append_encryption_conflict");
    expect(findings).toContain("checkpoint_encryption_conflict");
    expect(findings).toContain("checkpoint_version_conflict");
    expect(findings).toMatch(
      /Atomic SQL `20260724000000_atomic_capability_cutover\.sql` has not been\s+applied\./,
    );
    expect(findings).toContain("Capability SPA canary is on");
    expect(findings).not.toContain("Capability SPA canary remains off");
    expect(findings).not.toContain("Origin remains `fe18302f`");
    expect(findings).not.toContain("Canary remains off");
    expect(findings).not.toContain("Origin is `c5914c8e`");
    expect(findings).not.toContain("Origin is `386421e8`");
    expect(findings).not.toContain("Origin is `4baa8966`");
    expect(findings).not.toContain("Origin is `7335fadc`");
    expect(findings).not.toContain("Origin is `8d9ce025`");
    expect(findings).not.toContain("Origin is `e39caacd`");
    expect(findings).not.toContain("Origin is `4c791861`");
    expect(findings).not.toContain("Origin is `92aa4e0d`");
    expect(findings).not.toContain("Origin is `1f21777e`");
    expect(findings).not.toContain("Origin is `d15aee5d`");
    expect(findings).not.toContain("Origin is `4c846592`");
    expect(findings).not.toContain("Origin is `4ef734ee`");
    expect(findings).not.toContain("Origin is `27da93eb`");
    expect(findings).not.toContain("Origin is `e05c73ea`");
    expect(findings).not.toContain("Origin is `addeeb29`");
    expect(findings).not.toContain("Origin is `7d00fd52`");
    expect(findings).toContain("Origin is `77d791af`");
    expect(findings).toContain("capabilityRoutesEnabled` is true");
    expect(findings).toContain("Phase C");
    expect(findings).not.toContain("`RawView` reads `public.notes` directly");
    expect(findings).toContain("VITE_CAPABILITY_ROUTES_ENABLED` is true");
    expect(findings).toMatch(
      /Do not treat 220, 270, `writes_enabled`, or this\s+origin canary as authorization to apply 240 or flip\s+`private_realtime_enabled`/,
    );
    expect(findings).not.toContain(
      "Do not treat 220 or 270 as authorization to flip the canary or apply 240.",
    );
    expect(findings).not.toContain(
      "Atomic SQL `20260724000000_atomic_capability_cutover.sql` is applied",
    );
    expect(findings).toContain(
      "## 1. Legacy metadata and crawler previews — production verified",
    );
    expect(findings).toMatch(
      /The\s+deployed `note-meta` endpoint is production-verified\./,
    );
    expect(findings).toContain(
      "Worker crawler containment is live and verified in production.",
    );
    expect(findings).not.toContain("tombstone deploy unverified");
    expect(findings).not.toContain(
      "production deployment has not been independently verified",
    );
  });

  it("records production daily backups without PITR or cutover authorization", () => {
    const findings = readFileSync("docs/security-findings.md", "utf8");

    expect(findings).toContain(
      "## 3c. Production daily backups — verified, no PITR",
    );
    expect(findings).toMatch(
      /Lovable Cloud → More → Cloud → Database →\s+Backups/,
    );
    expect(findings).toContain("There is no PITR / point-in-time UI");
    expect(findings).toContain("14 daily automated snapshots");
    expect(findings).toContain("2026-09-01 19:33:22 UTC");
    expect(findings).toContain("2026-08-19 19:34:43 UTC");
    expect(findings).toContain("Nothing was restored");
    expect(findings).toContain(
      "Worst-case loss on restore-to-snapshot is up to ~24h of writes",
    );
    expect(findings).toMatch(
      /This is not authorization to call\s+`capability_runtime_set`/,
    );
    expect(findings).not.toContain("PITR checkpoint is available");
  });

  it("records the production writes_enabled go without treating it as later cutover steps", () => {
    const findings = readFileSync("docs/security-findings.md", "utf8");

    expect(findings).toContain(
      "## 3d. Production writes_enabled go — verified, Realtime still false",
    );
    expect(findings).toContain("2026-09-02 ~11:23 ICT");
    expect(findings).toContain("production not staging");
    expect(findings).toContain(
      "SELECT public.capability_runtime_set(true, false);",
    );
    expect(findings).toContain("via Lovable Cloud `query_database`");
    expect(findings).toContain("`singleton=true`, `writes_enabled=true`");
    expect(findings).toContain("`private_realtime_enabled=false`");
    expect(findings).toContain("2026-09-02 04:24:07.235188+00");
    expect(findings).toContain("`capability_note_import_legacy` is absent");
    expect(findings).toContain(
      "fe18302fb650b98eaee414e34e61db5cf06acc61",
    );
    expect(findings).toContain("`capabilityRoutesEnabled` false");
    expect(findings).toContain("2026-09-01T19:55:38.557Z");
    expect(findings).toContain(
      'POST `/functions/v1/note-session` `{}` still 401 `{"error":"unauthorized"}`',
    );
    expect(findings).toMatch(
      /this flip does not mount `CutoverNotePage` and is not a\s+canary/,
    );
    expect(findings).toContain(
      "This is not canary, not SQL 240, not origin/Worker deploy, not",
    );
    expect(findings).toContain("`private_realtime_enabled`, and not soak.");
    expect(findings).toContain("Later origin canary is §3e");
    expect(findings).not.toContain("PITR checkpoint is available");
  });

  it("records the production origin canary go without treating it as soak, 240, or Realtime", () => {
    const findings = readFileSync("docs/security-findings.md", "utf8");

    expect(findings).toContain(
      "## 3e. Production origin canary go — capabilityRoutesEnabled true",
    );
    expect(findings).toContain("2026-09-02 ~12:01 ICT");
    expect(findings).toContain("snote-g4-origin");
    expect(findings).toContain("wrangler pages deploy");
    expect(findings).toContain("`build:release`");
    expect(findings).toContain("`VITE_CAPABILITY_ROUTES_ENABLED=true` only");
    expect(findings).toContain(
      "`VITE_CAPABILITY_AUTH_ENABLED` and `VITE_ADMIN_PANEL_ENABLED` stayed false",
    );
    expect(findings).toContain("https://note.syrin.online/");
    expect(findings).toContain("do not advertise `snote.lovable.app`");
    expect(findings).toContain("First canary origin (not current live)");
    expect(findings).toContain(
      "c5914c8e8f953d5e8ed877d8c892b6e0941095e7",
    );
    expect(findings).toContain("`capabilityRoutesEnabled` true");
    expect(findings).toContain("2026-09-02T05:00:59.705Z");
    expect(findings).toContain("1788325246305-qzfta8za");
    expect(findings).toContain(
      "6277a076-c0d3-4464-b5b5-5b0432011029",
    );
    expect(findings).toContain("32ccfc35");
    expect(findings).toContain("2026-09-02 ~16:03 ICT");
    expect(findings).toContain(
      "386421e87f7eac2864f1a40655a2b0255b4332d6",
    );
    expect(findings).toContain("2026-09-02T09:02:48.606Z");
    expect(findings).toContain("1788339753769-8ld1rqzh");
    expect(findings).toContain("same-canary");
    expect(findings).toContain("#64");
    expect(findings).toContain("#65");
    expect(findings).toContain("find/replace");
    expect(findings).toContain("2026-09-02 ~17:52 ICT");
    expect(findings).toContain(
      "4baa89665ee1d75dcafb238d62fbed9b18f8a7c7",
    );
    expect(findings).toContain("2026-09-02T10:52:01.159Z");
    expect(findings).toContain("1788346307439-oyd5q3or");
    expect(findings).toContain(
      "a138549e-0c61-4e0c-83f2-366c341309a9",
    );
    expect(findings).toContain(
      "09472051-c61c-4fcb-ace4-1561da6d4cc2",
    );
    expect(findings).toContain("#67");
    expect(findings).toContain("find overlay");
    expect(findings).toContain("table preview");
    expect(findings).toContain("2026-09-02 ~19:22 ICT");
    expect(findings).toContain(
      "7335fadce1dc96ee5548deb2e7e75b2bbff57c40",
    );
    expect(findings).toContain("2026-09-02T12:22:26.889Z");
    expect(findings).toContain("1788351733291-8f4qsmpx");
    expect(findings).toContain(
      "86b91475-2b60-4c30-81e8-50b6a004a734",
    );
    expect(findings).toContain("#69");
    expect(findings).toContain("paste");
    expect(findings).toContain("copy-box");
    expect(findings).toContain("\\_");
    expect(findings).toContain("2026-09-02 ~20:41 ICT");
    expect(findings).toContain(
      "8d9ce025d05c65664afaba78b9b145bf137edb83",
    );
    expect(findings).toContain("2026-09-02T13:40:14.339Z");
    expect(findings).toContain("1788356400749-1b51r8sg");
    expect(findings).toContain(
      "e3033d20-c0db-4a9d-95e4-e96abb459572",
    );
    expect(findings).toContain("#71");
    expect(findings).toContain("position:fixed");
    expect(findings).toContain("horizontally centered");
    expect(findings).toContain("Note dropdown");
    expect(findings).toContain("2026-09-02 ~22:41 ICT");
    expect(findings).toContain(
      "e39caacd6b37518d61498262ba38506de64f5545",
    );
    expect(findings).toContain("2026-09-02T15:41:04.072Z");
    expect(findings).toContain("1788363650837-yre560cm");
    expect(findings).toContain("005b2f9d");
    expect(findings).toContain("#73");
    expect(findings).toContain("[[slug|display]]");
    expect(findings).toContain("backlinks");
    expect(findings).toContain("2026-09-02 ~23:49 ICT");
    expect(findings).toContain(
      "4c7918619eb6d9b56523444fa1eb8d154e0eba01",
    );
    expect(findings).toContain("2026-09-02T16:49:02.306Z");
    expect(findings).toContain("1788367729384-c7thqlof");
    expect(findings).toContain("878a55d0");
    expect(findings).toContain("#75");
    expect(findings).toContain("Cmd-K");
    expect(findings).toContain("#tag");
    expect(findings).toContain("fast-uri");
    expect(findings).toContain("2026-09-03 ~02:31 ICT");
    expect(findings).toContain(
      "92aa4e0db313f2abec12cc233175e5f86dd4b24a",
    );
    expect(findings).toContain("2026-09-02T19:31:08.064Z");
    expect(findings).toContain("1788377454668-bm60zdsr");
    expect(findings).toContain("6b434d48");
    expect(findings).toContain("#77");
    expect(findings).toContain("GFM callouts");
    expect(findings).toContain("slash mermaid/math");
    expect(findings).toContain("transclude");
    expect(findings).toContain("2026-09-03 ~04:24 ICT");
    expect(findings).toContain(
      "1f21777e7d562b4ae5f71bc7d72d7df44dd50557",
    );
    expect(findings).toContain("2026-09-02T21:23:43.585Z");
    expect(findings).toContain("1788384208561-3dfszwdt");
    expect(findings).toContain("a88095b0");
    expect(findings).toContain("#79");
    expect(findings).toContain("Home tag filter");
    expect(findings).toContain("virtual collections");
    expect(findings).toContain("templates");
    expect(findings).toContain("HomeLibraryPanel");
    expect(findings).toContain("HomeTemplatePicker");
    expect(findings).toContain("2026-09-03 ~05:07 ICT");
    expect(findings).toContain(
      "d15aee5d243630abc7f143225b2ca9cdb44dd7b2",
    );
    expect(findings).toContain("2026-09-02T22:06:29.822Z");
    expect(findings).toContain("1788386776564-qtmwh3o1");
    expect(findings).toContain("2870a660");
    expect(findings).toContain("#81");
    expect(findings).toContain("firefox");
    expect(findings).toContain("install dialog");
    expect(findings).toContain("mousedown");
    expect(findings).toContain("DialogTrigger");
    expect(findings).toContain("2026-09-03 ~06:34 ICT");
    expect(findings).toContain(
      "4c84659244f01153bab6c6f4655fe8725df419b4",
    );
    expect(findings).toContain("2026-09-02T23:34:16.494Z");
    expect(findings).toContain("1788392043070-ed273a61");
    expect(findings).toContain("7e140ebf");
    expect(findings).toContain("#83");
    expect(findings).toContain("history burst");
    expect(findings).toContain("selective hunk restore");
    expect(findings).toContain("Local IndexedDB snapshots only");
    expect(findings).toContain("2026-09-03 ~10:30 ICT");
    expect(findings).toContain(
      "4ef734ee97a93d1922eefde01a6453c828f9aed3",
    );
    expect(findings).toContain("2026-09-03T03:30:28.721Z");
    expect(findings).toContain("1788406215104-lywhln09");
    expect(findings).toContain(
      "a59b0964-8ca6-4a89-a155-e0346eebd347",
    );
    expect(findings).toContain("#85");
    expect(findings).toContain("clip pasted URL");
    expect(findings).toContain("Readability");
    expect(findings).toContain("Turndown");
    expect(findings).toContain("`/clip`");
    expect(findings).toContain("`credentials:omit`");
    expect(findings).toContain("fail-closed");
    expect(findings).toContain("CORS");
    expect(findings).toContain("private IP");
    expect(findings).toContain("No TinyFish/Worker proxy");
    expect(findings).toContain("2026-09-03 ~15:43 ICT");
    expect(findings).toContain(
      "27da93eb2db7fa670f721ce2ecbb79971f489bb2",
    );
    expect(findings).toContain("2026-09-03T08:42:12.078Z");
    expect(findings).toContain("1788424919271-lf485uzb");
    expect(findings).toContain(
      "4f5e5afc-c80b-46b8-b053-71e8339040d2",
    );
    expect(findings).toContain("#87");
    expect(findings).toContain("unwrap");
    expect(findings).toContain("inline-code");
    expect(findings).toContain("Slack");
    expect(findings).toContain("Discord");
    expect(findings).toContain("Telegram");
    expect(findings).toContain("Shift-paste");
    expect(findings).toContain("2026-09-04 ~14:39 ICT");
    expect(findings).toContain(
      "e05c73ead67a3751d07a4042ba68fe86fcb271a8",
    );
    expect(findings).toContain("2026-09-04T07:39:26.164Z");
    expect(findings).toContain("1788507551045-leqeymq1");
    expect(findings).toContain(
      "028e8199-02c8-4583-8890-bbd2f09dc8f0",
    );
    expect(findings).toContain("#95");
    expect(findings).toContain("Home capability mint");
    expect(findings).toContain("Git Provider");
    expect(findings).toContain("33849773178");
    expect(findings).toContain("2026-09-04 ~17:34 ICT");
    expect(findings).toContain(
      "addeeb29cd9a6dac73c406f251ff5305db12f8f7",
    );
    expect(findings).toContain("2026-09-04T10:34:53.874Z");
    expect(findings).toContain("1788518080553-dg3glr2m");
    expect(findings).toContain(
      "25c47833-fd81-42b1-ba6b-39e7e8f5a5e3",
    );
    expect(findings).toContain("#98");
    expect(findings).toContain("fail-closed");
    expect(findings).toContain("seedAndOpen");
    expect(findings).toContain("33863872787");
    expect(findings).toContain("2026-09-07 ~04:11 ICT");
    expect(findings).toContain(
      "7d00fd52f9c01fdb954ad9e2f034c784d9311bed",
    );
    expect(findings).toContain("2026-09-06T21:11:03.163Z");
    expect(findings).toContain("1788729048596-q0bbwjr7");
    expect(findings).toContain(
      "ed0e177e-b127-48b2-bac1-8e2460c82b28",
    );
    expect(findings).toContain("#101");
    expect(findings).toContain("#103");
    expect(findings).toContain("2026-09-07 ~07:28 ICT");
    expect(findings).toContain(
      "77d791af89696877f1f794a94270395902285c56",
    );
    expect(findings).toContain("2026-09-07T00:28:21.829Z");
    expect(findings).toContain("1788740888124-oepsltsc");
    expect(findings).toContain("1fbf89fe");
    expect(findings).toContain("#105");
    expect(findings).toContain("Phase C");
    expect(findings).toContain("34070206821");
    expect(findings).toContain("CutoverNotePage");
    expect(findings).toContain("LegacyNotePage");
    expect(findings).toContain("Phase B");
    expect(findings).toContain("SQL 240 / Worker / Realtime not changed");
    expect(findings).toContain("Kill switch unchanged");
    expect(findings).toMatch(
      /POST `\/functions\/v1\/legacy-note-open` `\{\}` 400 `\{"error":"invalid request"\}`/,
    );
    expect(findings).not.toMatch(
      /POST `\/functions\/v1\/legacy-note-open` `\{\}` still 410 `\{"found":false\}`/,
    );
    expect(findings).toMatch(
      /POST `\/functions\/v1\/note-session` `\{\}` still 401 `\{"error":"unauthorized"\}`/,
    );
    expect(findings).toContain("syrin-prerender");
    expect(findings).toContain("`931430c0` / `5f94ab6c`");
    expect(findings).toContain("Origin SPA was not redeployed");
    expect(findings).not.toContain(
      "still `9fcc58bc` / `b4d1a94e` — not redeployed",
    );
    expect(findings).toContain("`legacyOnly={!canary}`");
    expect(findings).toContain("Home mints capabilities");
    expect(findings).not.toContain("Home still does not mint capabilities");
    expect(findings).toMatch(/RawView `\/:slug\.md` loads via LNO `open`/);
    expect(findings).toMatch(/Home availability uses LNO `exists`/);
    expect(findings).toContain(
      "This is not SQL 240, not Realtime, not soak-complete.",
    );
    expect(findings).toMatch(
      /Soak ≥48h started ~12:01 ICT from the first canary/,
    );
    expect(findings).toMatch(/does not restart soak/);
    expect(findings).not.toContain(
      "Soak ≥48h starts from this live canary.",
    );
    expect(findings).not.toContain("PITR checkpoint is available");
  });

  it("pins leftover client/Worker present-tense surfaces to live origin canary 77d791af", () => {
    const client = readFileSync("docs/capability-client.md", "utf8");
    const backend = readFileSync("docs/capability-backend.md", "utf8");
    const worker = readFileSync("cloudflare-worker/README.md", "utf8");

    expect(client).toContain("`capabilityRoutesEnabled: true`");
    expect(client).toContain("findings §3e");
    expect(client).toContain("77d791af");
    expect(client).toContain("This Home mint path is live on origin `77d791af`");
    expect(client).toContain("Phase C");
    expect(client).toMatch(/LNO `exists`/);
    expect(client).toMatch(/LNO `open`/);
    expect(client).not.toContain(
      "Home create waits until the `notes.select` availability",
    );
    expect(client).toContain("fail-open to legacy `seedAndOpen`");
    expect(client).not.toContain("GitHub-first wiring, not a production attestation");
    expect(client).not.toContain("live origin `386421e8`");
    expect(client).not.toContain("live origin `4baa8966`");
    expect(client).not.toContain("live origin `7335fadc`");
    expect(client).not.toContain("live origin `8d9ce025`");
    expect(client).not.toContain("live origin `e39caacd`");
    expect(client).not.toContain("live origin `4c791861`");
    expect(client).not.toContain("live origin `92aa4e0d`");
    expect(client).not.toContain("live origin `1f21777e`");
    expect(client).not.toContain("live origin `d15aee5d`");
    expect(client).not.toContain("live origin `4c846592`");
    expect(client).not.toContain("live origin `4ef734ee`");
    expect(client).not.toContain("live origin `27da93eb`");
    expect(client).not.toContain("live origin `e05c73ea`");
    expect(client).not.toContain("This Home mint path is live on origin `e05c73ea`");
    expect(client).not.toContain("live origin `addeeb29`");
    expect(client).not.toContain("This Home mint path is live on origin `addeeb29`");
    expect(client).not.toContain("live origin `7d00fd52`");
    expect(client).not.toContain("This Home mint path is live on origin `7d00fd52`");
    expect(client).not.toContain(
      "Production builds attest `capabilityRoutesEnabled: false`.",
    );
    expect(client).toContain(".env.example");
    expect(client).toContain("`VITE_CAPABILITY_ROUTES_ENABLED=false`");
    expect(client).toContain("`build:release`");
    expect(client).toMatch(
      /Missing, empty, or any\s+other value keeps both pages `legacyOnly`/,
    );
    expect(client).not.toContain("until a named Pages deploy");
    expect(client).not.toContain("still serves dual-mode `NotePage`");
    expect(client).toContain("CutoverNotePage");
    expect(client).toContain("Phase B");

    expect(backend).toContain("CutoverNotePage");
    expect(backend).toContain("Phase C");
    expect(backend).toContain("SQL 240 is not applied");
    expect(backend).not.toMatch(
      /Live writes remain the legacy `NotePage` path \(canary off\)/,
    );
    expect(backend).not.toContain("(canary off)");
    expect(backend).toContain("dual-mode canary on");
    expect(backend).toContain("Home create mints when canary is on");
    expect(backend).toContain("fail-closed idle");

    expect(worker).toContain("`77d791af`");
    expect(worker).not.toContain("Origin SPA hiện là `addeeb29`");
    expect(worker).not.toContain("Origin SPA hiện là `7d00fd52`");
    expect(worker).toContain("`931430c0`");
    expect(worker).toContain("5f94ab6c");
    expect(worker).not.toContain("`9fcc58bc`");
    expect(worker).not.toContain("b4d1a94e");
    expect(worker).not.toContain("không còn khớp");
    expect(worker).not.toContain("chưa nhận các cờ log");
    expect(worker).not.toContain("Origin SPA hiện là `c5914c8e`");
    expect(worker).not.toContain("Origin SPA hiện là `386421e8`");
    expect(worker).not.toContain("Origin SPA hiện là `4baa8966`");
    expect(worker).not.toContain("Origin SPA hiện là `7335fadc`");
    expect(worker).not.toContain("Origin SPA hiện là `8d9ce025`");
    expect(worker).not.toContain("Origin SPA hiện là `e39caacd`");
    expect(worker).not.toContain("Origin SPA hiện là `4c791861`");
    expect(worker).not.toContain("Origin SPA hiện là `92aa4e0d`");
    expect(worker).not.toContain("Origin SPA hiện là `1f21777e`");
    expect(worker).not.toContain("Origin SPA hiện là `d15aee5d`");
    expect(worker).not.toContain("Origin SPA hiện là `4c846592`");
    expect(worker).not.toContain("Origin SPA hiện là `4ef734ee`");
    expect(worker).not.toContain("Origin SPA hiện là `27da93eb`");
    expect(worker).not.toContain("Origin SPA hiện là `e05c73ea`");
    expect(worker).not.toContain("Origin SPA vẫn là `fe18302f`");
    expect(worker).toContain("không cho phép một deployment mới");
  });

  it("records live Worker 931430c0 / 5f94ab6c with logs live, origin now 77d791af", () => {
    const findings = readFileSync("docs/security-findings.md", "utf8");
    const worker = readFileSync("cloudflare-worker/README.md", "utf8");
    const rollout = readFileSync(
      "docs/security/immediate-containment-rollout.md",
      "utf8",
    );
    const plan = readFileSync(
      "docs/superpowers/plans/2026-08-28-worker-production-source-parity.md",
      "utf8",
    );
    const spec = readFileSync(
      "docs/superpowers/specs/2026-08-28-worker-production-source-parity-design.md",
      "utf8",
    );
    const adr = readFileSync(
      "docs/adr/001-home-capability-mint-before-sql-240.md",
      "utf8",
    );

    expect(findings).toContain(
      "## 1c. Production Worker identity — live 2026-09-03",
    );
    expect(findings).toContain(
      "931430c016772d333f79aa31841e31aca2b327a4",
    );
    expect(findings).toContain("`931430c0`");
    expect(findings).toContain(
      "5f94ab6c-fde5-4416-a3aa-74daaa2e6094",
    );
    expect(findings).toContain("#89");
    expect(findings).toContain(
      "Replaces previous Cloudflare Version ID `b4d1a94e…`",
    );
    expect(findings).toMatch(
      /observability enabled, logs enabled, `invocation_logs` true/,
    );
    expect(findings).toContain("traces still false");
    expect(findings).toContain(
      "Committed `wrangler.toml` matches this live log state",
    );
    expect(findings).not.toContain(
      "Live Worker still: observability, logs, and traces disabled",
    );
    expect(findings).not.toContain(
      "This git change is not a live Worker deploy.",
    );
    expect(findings).toContain("syrin-prerender-staging");
    expect(findings).toContain("G3C staging");
    expect(findings).toContain("2026-08-24");
    expect(findings).toContain("Origin is `77d791af`");
    expect(findings).not.toContain("Origin is `7d00fd52`");
    expect(findings).toContain("origin was not redeployed");
    expect(findings).toContain("Do not claim origin is `931430c0`");
    expect(findings).toContain("synthetic-probe-token");
    expect(findings).toContain("did not echo locator or token");

    expect(worker).toContain(
      "5f94ab6c-fde5-4416-a3aa-74daaa2e6094",
    );
    expect(worker).toContain("PR #89");
    expect(worker).toContain("đã live trên production");

    expect(rollout).toContain(
      "5f94ab6c-fde5-4416-a3aa-74daaa2e6094",
    );
    expect(rollout).toContain("`931430c0`");
    expect(rollout).toContain("Observability and invocation logs are live");
    expect(rollout).toContain("traces remain disabled");
    expect(rollout).toContain("Origin remains `77d791af`");
    expect(rollout).not.toContain("Origin remains `7d00fd52`");
    expect(rollout).toContain("Home mint live");
    expect(rollout).toContain("fail-closed idle");
    expect(rollout).toContain("Phase C");

    expect(plan).toContain("**Live status (2026-09-03):**");
    expect(plan).toContain("`931430c0`");
    expect(plan).toContain(
      "5f94ab6c-fde5-4416-a3aa-74daaa2e6094",
    );
    expect(spec).toContain("**Live status (2026-09-03):**");
    expect(spec).toContain("`931430c0`");
    expect(spec).toContain(
      "5f94ab6c-fde5-4416-a3aa-74daaa2e6094",
    );

    expect(adr).toContain("Worker `931430c0` / `5f94ab6c`");
    expect(adr).toContain("5f94ab6c-fde5-4416-a3aa-74daaa2e6094");
    expect(adr).toContain("`invocation_logs` are **live**");
    expect(adr).toContain("Live origin `77d791af`");
    expect(adr).toContain("Home mint fail-closed idle live on origin `77d791af`");
    expect(adr).toMatch(/LNO `exists`/);
    expect(adr).not.toContain(
      "Home existence check today is `select slug, char_count from notes`",
    );
    expect(adr).not.toContain("Live origin `7d00fd52`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `7d00fd52`");
    expect(adr).not.toContain("Live origin `addeeb29`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `addeeb29`");
    expect(adr).not.toContain("Live origin `e05c73ea`");
    expect(adr).not.toContain("Home mint live on origin `e05c73ea`");
    expect(adr).not.toContain("Live origin `27da93eb`");
    expect(adr).not.toContain("Worker `9fcc58bc` / `b4d1a94e`");
    expect(adr).not.toContain("**committed** in #89 but **not live**");
  });

  it("pins the cutover backup gate to daily snapshots, not a PITR checkpoint", () => {
    const cutover = readFileSync(
      "docs/security/atomic-capability-cutover.md",
      "utf8",
    );

    expect(cutover).not.toContain("backup/PITR checkpoint");
    expect(cutover).not.toContain(
      "Take and verify a recoverable backup/PITR checkpoint",
    );
    expect(cutover).not.toContain("PITR checkpoint is available");
    expect(cutover).toMatch(
      /Verify the Lovable Cloud daily snapshot panel \(see\s+`docs\/security-findings\.md` §3c\)/,
    );
    expect(cutover).toContain("PITR is not available on this Tiny project");
    expect(cutover).toContain("Daily snapshot verify is done as of 2026-09-02");
    expect(cutover).toContain("2026-09-02 ~11:23 ICT");
    expect(cutover).toContain(
      "`SELECT public.capability_runtime_set(true, false);`",
    );
    expect(cutover).toContain("`writes_enabled=true`");
    expect(cutover).toContain("`private_realtime_enabled=false`");
    expect(cutover).toContain("findings §3d");
    expect(cutover).toContain("findings §3e");
    expect(cutover).toContain(
      "c5914c8e8f953d5e8ed877d8c892b6e0941095e7",
    );
    expect(cutover).toContain(
      "386421e87f7eac2864f1a40655a2b0255b4332d6",
    );
    expect(cutover).toContain("2026-09-02 ~17:52 ICT");
    expect(cutover).toContain(
      "4baa89665ee1d75dcafb238d62fbed9b18f8a7c7",
    );
    expect(cutover).toContain("2026-09-02 ~19:22 ICT");
    expect(cutover).toContain(
      "7335fadce1dc96ee5548deb2e7e75b2bbff57c40",
    );
    expect(cutover).toContain("2026-09-02 ~20:41 ICT");
    expect(cutover).toContain(
      "8d9ce025d05c65664afaba78b9b145bf137edb83",
    );
    expect(cutover).toContain("2026-09-02 ~22:41 ICT");
    expect(cutover).toContain(
      "e39caacd6b37518d61498262ba38506de64f5545",
    );
    expect(cutover).toContain("2026-09-02 ~23:49 ICT");
    expect(cutover).toContain(
      "4c7918619eb6d9b56523444fa1eb8d154e0eba01",
    );
    expect(cutover).toContain("2026-09-03 ~02:31 ICT");
    expect(cutover).toContain(
      "92aa4e0db313f2abec12cc233175e5f86dd4b24a",
    );
    expect(cutover).toContain("2026-09-03 ~04:24 ICT");
    expect(cutover).toContain(
      "1f21777e7d562b4ae5f71bc7d72d7df44dd50557",
    );
    expect(cutover).toContain("2026-09-03 ~05:07 ICT");
    expect(cutover).toContain(
      "d15aee5d243630abc7f143225b2ca9cdb44dd7b2",
    );
    expect(cutover).toContain("2026-09-03 ~06:34 ICT");
    expect(cutover).toContain(
      "4c84659244f01153bab6c6f4655fe8725df419b4",
    );
    expect(cutover).toContain("2026-09-03 ~10:30 ICT");
    expect(cutover).toContain(
      "4ef734ee97a93d1922eefde01a6453c828f9aed3",
    );
    expect(cutover).toContain("2026-09-03 ~15:43 ICT");
    expect(cutover).toContain(
      "27da93eb2db7fa670f721ce2ecbb79971f489bb2",
    );
    expect(cutover).toContain("2026-09-04 ~14:39 ICT");
    expect(cutover).toContain(
      "e05c73ead67a3751d07a4042ba68fe86fcb271a8",
    );
    expect(cutover).toContain("2026-09-04 ~17:34 ICT");
    expect(cutover).toContain(
      "addeeb29cd9a6dac73c406f251ff5305db12f8f7",
    );
    expect(cutover).toContain("2026-09-07 ~04:11 ICT");
    expect(cutover).toContain(
      "7d00fd52f9c01fdb954ad9e2f034c784d9311bed",
    );
    expect(cutover).toContain("2026-09-07 ~07:28 ICT");
    expect(cutover).toContain(
      "77d791af89696877f1f794a94270395902285c56",
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `386421e87f7eac2864f1a40655a2b0255b4332d6`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `4baa89665ee1d75dcafb238d62fbed9b18f8a7c7`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `7335fadce1dc96ee5548deb2e7e75b2bbff57c40`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `8d9ce025d05c65664afaba78b9b145bf137edb83`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `e39caacd6b37518d61498262ba38506de64f5545`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `4c7918619eb6d9b56523444fa1eb8d154e0eba01`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `92aa4e0db313f2abec12cc233175e5f86dd4b24a`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `1f21777e7d562b4ae5f71bc7d72d7df44dd50557`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `d15aee5d243630abc7f143225b2ca9cdb44dd7b2`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `4c84659244f01153bab6c6f4655fe8725df419b4`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `4ef734ee97a93d1922eefde01a6453c828f9aed3`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `27da93eb2db7fa670f721ce2ecbb79971f489bb2`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `e05c73ead67a3751d07a4042ba68fe86fcb271a8`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `addeeb29cd9a6dac73c406f251ff5305db12f8f7`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `7d00fd52f9c01fdb954ad9e2f034c784d9311bed`/,
    );
    expect(cutover).toMatch(
      /live `deployedSha` `77d791af89696877f1f794a94270395902285c56`/,
    );
    expect(cutover).toContain("Phase C");
    expect(cutover).toContain("`capabilityRoutesEnabled` true");
    expect(cutover).toMatch(/Soak ≥48h started from\s+that first canary/);
    expect(cutover).toMatch(/same-canary origin SHA bump/i);
    expect(cutover).toContain("not soak-complete");
    expect(cutover).toMatch(
      /Do not treat snapshot verify as `capability_runtime_set`/,
    );
    expect(cutover).toMatch(
      /This is not `LEGACY_SHARE_CUTOFF`, soak-complete,\s+SQL 240, Worker redeploy, or `private_realtime_enabled`/,
    );
    expect(cutover).not.toMatch(
      /This is not `LEGACY_SHARE_CUTOFF`, canary, soak, SQL 240/,
    );
    expect(cutover).toContain("Do not skip remaining order");
  });
});
