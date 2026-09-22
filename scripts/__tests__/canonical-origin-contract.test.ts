import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const CANONICAL_ORIGIN = "https://note.syrin.online";
const staleU1NotLive = ["not ", "applied/published"].join("");
const staleGithubReady = ["GitHub", "-ready"].join("");

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
      /Production currently runs W2 free-edit/,
    );
    expect(readme).toContain("`capabilityRoutesEnabled` true");
    expect(readme).toContain("0cdcdc0f");
    expect(readme).toContain("1b9ed3d1");
    expect(readme).toContain("9a80930a");
    expect(readme).toContain("8e64829c");
    expect(readme).toContain("44b02cb3");
    expect(readme).toContain("b44849c4");
    expect(readme).toContain("1b172544");
    expect(readme).toContain("5527f154");
    expect(readme).toContain("#151");
    expect(readme).toContain("#153");
    expect(readme).toContain("Choice A");
    expect(readme).toContain("#118");
    expect(readme).toContain("#119");
    expect(readme).toContain("#122");
    expect(readme).toContain("#123");
    expect(readme).toContain("#126");
    expect(readme).toContain("#128");
    expect(readme).toContain("#130");
    expect(readme).toContain("#131");
    expect(readme).toContain("#135");
    expect(readme).toContain("#137");
    expect(readme).toContain("#138");
    expect(readme).toContain("#139");
    expect(readme).toContain("#142");
    expect(readme).toContain("#143");
    expect(readme).toContain("#145");
    expect(readme).toContain("capability_note_bulk_disable_secure");
    expect(readme).toContain("bd11deed");
    expect(readme).toContain("Go C");
    expect(readme).toContain("pixel-qa/bulk-off-verify/");
    expect(readme).toContain("sentinel-qa-bulk-off-live/");
    expect(readme).toContain("/workspace/pulse-bulk-off-ab2c4de9/");
    expect(readme).toContain("pixel-qa/go-c-live-9a80930a/");
    expect(readme).toContain("sentinel-qa-go-c-live/");
    expect(readme).toContain("managed_live=3");
    expect(readme).toContain("unmanaged_live=106");
    expect(readme).toContain("pulse-rebulk-all6-20260922");
    expect(readme).toContain("sentinel-qa-rebulk-all6-live/");
    expect(readme).toContain("converted=6");
    expect(readme).toContain("managed_live=0");
    expect(readme).toContain("PWA latch");
    expect(readme).toContain("hard-reload");
    expect(readme).toContain("free-edit");
    expect(readme).toContain("convert-on-write");
    expect(readme).toContain("convert-legacy");
    expect(readme).toContain("plain-upsert");
    expect(readme).toContain("disable-secure");
    expect(readme).toContain("capability_managed");
    expect(readme).toContain("umsg_01m21zhm");
    expect(readme).toContain("**applied** live");
    expect(readme).toContain("**published**");
    expect(readme).not.toContain(staleU1NotLive);
    expect(readme).not.toContain(staleGithubReady);
    expect(readme).toContain("Pixel PASS");
    expect(readme).toContain("pixel-qa/a3-0cdcdc0f/");
    expect(readme).toContain("sentinel-qa-a3-0cdcdc0f/");
    expect(readme).toContain("READY WITH KNOWN RISKS");
    expect(readme).toContain("BLOCKER/HIGH/MEDIUM none");
    expect(readme).toContain("new-version reminder");
    expect(readme).not.toContain("Live UX W1 PASS");
    expect(readme).not.toContain("pixel-qa/w1-2ae9a230/");
    expect(readme).not.toContain("sentinel-qa-w1-live/");
    expect(readme).not.toContain("Saving securely");
    expect(readme).not.toContain("This legacy note does not exist");
    expect(readme).not.toContain("HIGH residual");
    expect(readme).not.toContain("may still be in flight");
    expect(readme).not.toContain("Sentinel still completing");
    expect(readme).not.toContain("no Sentinel verdict");
    expect(readme).not.toContain("fail-path not smoke-tested live");
    expect(readme).toContain("Duplicate securely is enabled");
    expect(readme).toContain("import-legacy");
    expect(readme).not.toContain("Duplicate securely is hidden with");
    expect(readme).toContain("legacyRo");
    expect(readme).toContain("findings §3e");
    expect(readme).toContain("Phase C");
    expect(readme).toContain("Pixel HIGH UX");
    expect(readme).toContain("H1–H6");
    expect(readme).toContain("H2");
    expect(readme).toContain("opaque");
    expect(readme).toContain("Mode/Export");
    expect(readme).toContain("Ko-fi");
    expect(readme).toContain("New Version");
    expect(readme).toContain("#113");
    expect(readme).toContain("#116");
    expect(readme).toContain("Sonner");
    expect(readme).toContain("FAB-primary");
    expect(readme).toContain("IDLE+UPDATE");
    expect(readme).toContain("no Sonner on home");
    expect(readme).toContain("RawView");
    expect(readme).toMatch(/LNO `open`/);
    expect(readme).toMatch(/LNO `exists`/);
    expect(readme).toContain("Home create always uses");
    expect(readme).toContain("seedAndOpen");
    expect(readme).toContain("fail-closed on idle");
    expect(readme).not.toContain("Home mints capabilities when canary is on");
    expect(readme).toContain("LegacyNotePage");
    expect(readme).toContain("A′");
    expect(readme).toContain("superseded");
    expect(readme).toContain("a-prime-cutover-restore.md");
    expect(readme).not.toMatch(/origin `7d00fd52`/);
    expect(readme).not.toMatch(/origin `77d791af`/);
    expect(readme).not.toMatch(/origin `9df65d53`/);
    expect(readme).not.toMatch(/origin `9bf5e92b`/);
    expect(readme).not.toMatch(/origin `b6824541`/);
    expect(readme).not.toMatch(/origin `a8f7eeb8`/);
    expect(readme).not.toMatch(/origin `5c33ac24`/);
    expect(readme).not.toMatch(/origin `9dc0240e`/);
    expect(readme).not.toMatch(/origin `15ec8285`/);
    expect(readme).not.toMatch(/origin `0073d53b`/);
    expect(readme).not.toMatch(/origin `1e76e2b7`/);
    expect(readme).not.toMatch(/origin `b4eba5d2`/);
    expect(readme).not.toMatch(/origin `f84183ba`/);
    expect(readme).not.toMatch(/origin `2ae9a230`/);
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
    expect(readme).toMatch(/SQL 240 is already applied/);
    expect(readme).not.toMatch(/SQL 240 is not applied/);
    expect(readme).toMatch(/soak ≥48h started from the first canary/);
    expect(readme).toMatch(/not soak-complete/);
    expect(readme).toMatch(
      /The capability model below is the live table-access architecture\./,
    );
    expect(readme).not.toMatch(
      /not the\s+authorization model currently active in production/,
    );
    expect(findings).toContain("Production SQL 240 is already applied");
    expect(findings).not.toContain(
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
    expect(findings).toContain(
      "Atomic SQL `20260724000000_atomic_capability_cutover.sql` is applied",
    );
    expect(findings).not.toMatch(
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
    expect(findings).not.toContain("Origin is `77d791af`");
    expect(findings).not.toContain("Origin is `9df65d53`");
    expect(findings).not.toContain("Origin is `9bf5e92b`");
    expect(findings).not.toContain("Origin is `b6824541`");
    expect(findings).not.toContain("Origin is `a8f7eeb8`");
    expect(findings).not.toContain("Origin is `5c33ac24`");
    expect(findings).not.toContain("Origin is `9dc0240e`");
    expect(findings).not.toContain("Origin is `15ec8285`");
    expect(findings).not.toContain("Origin is `0073d53b`");
    expect(findings).not.toContain("Origin is `1e76e2b7`");
    expect(findings).not.toContain("Origin is `b4eba5d2`");
    expect(findings).not.toContain("Origin is `f84183ba`");
    expect(findings).not.toContain("Origin is `2ae9a230`");
    expect(findings).not.toContain("Origin is `0cdcdc0f`");
    expect(findings).not.toContain("Origin is `9a80930a`");
    expect(findings).toContain("Origin is `1b172544`");
    expect(findings).not.toContain("Origin is `44b02cb3`");
    expect(findings).toContain("capabilityRoutesEnabled` is true");
    expect(findings).toContain("Phase C");
    expect(findings).toContain("Pixel HIGH UX");
    expect(findings).toContain("H1–H6");
    expect(findings).toContain("H2");
    expect(findings).toContain("opaque");
    expect(findings).toContain("Mode/Export");
    expect(findings).toContain("Ko-fi");
    expect(findings).toContain("New Version");
    expect(findings).toContain("#113");
    expect(findings).toContain("#116");
    expect(findings).toContain("#118");
    expect(findings).toContain("#119");
    expect(findings).toContain("#122");
    expect(findings).toContain("#123");
    expect(findings).toContain("#126");
    expect(findings).toContain("#128");
    expect(findings).toContain("#130");
    expect(findings).toContain("#131");
    expect(findings).toContain("#135");
    expect(findings).toContain("#137");
    expect(findings).toContain("#138");
    expect(findings).toContain("#139");
    expect(findings).toContain("#142");
    expect(findings).toContain("#145");
    expect(findings).toContain("#151");
    expect(findings).toContain("#153");
    expect(findings).toContain("## 3f.");
    expect(findings).toContain("## 3g.");
    expect(findings).toContain("capability_note_bulk_disable_secure");
    expect(findings).toContain("Go C");
    expect(findings).toContain("Choice A");
    expect(findings).toContain("A′");
    expect(findings).toContain("superseded");
    expect(findings).toContain("W1");
    expect(findings).toContain("W2");
    expect(findings).toContain("convert-on-write");
    expect(findings).toContain("free-edit");
    expect(findings).toContain("convert-legacy");
    expect(findings).toContain("plain-upsert");
    expect(findings).toContain("disable-secure");
    expect(findings).toContain("capability_managed");
    expect(findings).toContain("umsg_01m21zhm");
    expect(findings).toContain("**applied** live");
    expect(findings).toContain("**published**");
    expect(findings).not.toContain(staleU1NotLive);
    expect(findings).not.toContain(staleGithubReady);
    expect(findings).toContain("Duplicate securely is enabled");
    expect(findings).toContain("import-legacy");
    expect(findings).toContain("a-prime-cutover-restore.md");
    expect(findings).toContain("Sonner");
    expect(findings).toContain("FAB-primary");
    expect(findings).not.toContain("`RawView` reads `public.notes` directly");
    expect(findings).toContain("VITE_CAPABILITY_ROUTES_ENABLED` is true");
    expect(findings).toMatch(
      /Do not treat 220, 270, `writes_enabled`, or this\s+origin canary as authorization to flip\s+`private_realtime_enabled`/,
    );
    expect(findings).not.toContain(
      "Do not treat 220 or 270 as authorization to flip the canary or apply 240.",
    );
    expect(findings).toContain(
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
    expect(findings).toContain("2026-09-07 ~09:51 ICT");
    expect(findings).toContain(
      "9df65d53b5ca38fbd48db4c9fe0fb57a950192f8",
    );
    expect(findings).toContain("2026-09-07T02:51:40.515Z");
    expect(findings).toContain("1788749485576-3fz1mz5u");
    expect(findings).toContain("f0c40427");
    expect(findings).toContain("#107");
    expect(findings).toContain("2026-09-07 ~11:17 ICT");
    expect(findings).toContain(
      "9bf5e92bf07cd82ff1775bc3d4a369b330de6a42",
    );
    expect(findings).toContain("2026-09-07T04:17:46.197Z");
    expect(findings).toContain("1788754651490-9xjsutgq");
    expect(findings).toContain("#109");
    expect(findings).toContain("H2");
    expect(findings).toContain("opaque");
    expect(findings).toContain("Mode/Export");
    expect(findings).toContain("34082660457");
    expect(findings).toContain("ac63e32bbaf2471d09129469427409db");
    expect(findings).toContain("2026-09-07 ~11:36 ICT");
    expect(findings).toContain(
      "b68245410d64aac8ac44c4f9a831e859a343cf00",
    );
    expect(findings).toContain("2026-09-07T04:36:02.465Z");
    expect(findings).toContain("1788755747017-oyr7urg1");
    expect(findings).toContain("10bf76eb");
    expect(findings).toContain("#110");
    expect(findings).toContain("Ko-fi");
    expect(findings).toContain("New Version");
    expect(findings).toContain("88c32aa9e1feb672d1f059db9d6a33ca");
    expect(findings).toContain("34083747425");
    expect(findings).toContain("34083766569");
    expect(findings).toContain("cancelled");
    expect(findings).toMatch(/Playwright 2 failed|not PWA smoke PASS/);
    expect(findings).not.toContain("does not fold #110");
    expect(findings).toContain("2026-09-07 ~12:28 ICT");
    expect(findings).toContain(
      "a8f7eeb830b8440b899a6ccf0f8018f1a4fe8805",
    );
    expect(findings).toContain("2026-09-07T05:27:50.152Z");
    expect(findings).toContain("1788758854729-717yxima");
    expect(findings).toContain("bfb19758");
    expect(findings).toContain("434d4e14c59cc74bbd4c3dac0e73af8c");
    expect(findings).toContain("2026-09-07 ~13:31 ICT");
    expect(findings).toContain(
      "5c33ac241d6f6b4548ea290c299e15e4be799921",
    );
    expect(findings).toContain("2026-09-07T06:31:21.575Z");
    expect(findings).toContain("1788762666457-xzjqm3pq");
    expect(findings).toContain("6e6cdcc3");
    expect(findings).toContain("#116");
    expect(findings).toContain("Sonner");
    expect(findings).toContain("FAB-primary");
    expect(findings).toContain("d5edc17cf89dc508ed7a134bb2dfe78e");
    expect(findings).toContain("34091257777");
    expect(findings).toMatch(/PWA smoke after that ship: SUCCESS/);
    expect(findings).toContain("Playwright 2 passed");
    expect(findings).toContain("IDLE+UPDATE");
    expect(findings).toContain("no Sonner on home");
    expect(findings).toContain("Pulse confirmed");
    expect(findings).toContain("Pixel HIGH UX");
    expect(findings).toContain("H1–H6");
    expect(findings).toContain("34077809435");
    expect(findings).toContain("2026-09-07 ~17:42 ICT");
    expect(findings).toContain(
      "9dc0240e7d714d548711623f94a50c42dac64475",
    );
    expect(findings).toContain("2026-09-07T10:42:45.177Z");
    expect(findings).toContain("1788777750020-948pzpfj");
    expect(findings).toContain("304342e0");
    expect(findings).toContain("bb56bbbc6570ef11504c4d493893f218");
    expect(findings).toContain("#118");
    expect(findings).toContain("Choice A");
    expect(findings).toContain("legacyRo");
    expect(findings).toContain("Duplicate");
    expect(findings).toContain("/hage");
    expect(findings).toContain("34112928744");
    expect(findings).toContain("hardReloadCount");
    expect(findings).toContain("2≠1");
    expect(findings).toContain("READY WITH KNOWN RISKS");
    expect(findings).toMatch(/does not claim full PWA smoke PASS/);
    expect(findings).toContain("2026-09-07 ~18:56 ICT");
    expect(findings).toContain(
      "15ec8285a7f02fdf383a1b5aa87ccd13d72ba6f7",
    );
    expect(findings).toContain("2026-09-07T11:56:22.424Z");
    expect(findings).toContain("1788782168827-zcsaepnh");
    expect(findings).toContain("5367a813");
    expect(findings).toContain("0300ab59e05a2be8c14a3f6bdadb6a75");
    expect(findings).toContain("#119");
    expect(findings).toContain("PWA latch");
    expect(findings).toContain("hard-reload");
    expect(findings).toContain("34119265815");
    expect(findings).toMatch(/PWA smoke after this ship: SUCCESS/);
    expect(findings).toContain("Playwright 2 passed");
    expect(findings).toContain("2/2");
    expect(findings).toContain("Sentinel");
    expect(findings).toContain("khớp");
    expect(findings).toContain("multi-click residual cleared");
    expect(findings).toContain("240 HOLD");
    expect(findings).toContain("Pixel visual latch PASS");
    expect(findings).toContain("FAB Update = 1 reload");
    expect(findings).toContain("latch-15ec8285/");
    expect(findings).toContain("2026-09-08 ~10:24 ICT");
    expect(findings).toContain(
      "0073d53bb2524882eda0c36528f0c25a94346a65",
    );
    expect(findings).toContain("2026-09-08T03:24:01.879Z");
    expect(findings).toContain("1788837826262-e3tdqmc3");
    expect(findings).toContain("fbef2d53");
    expect(findings).toContain("50f5c8e5194530d1dc946602f65e54c9");
    expect(findings).toContain("#122");
    expect(findings).toContain("2026-09-08 ~12:23 ICT");
    expect(findings).toContain(
      "1e76e2b7cb1ee239cb9af1bc8e8a04c229641e7d",
    );
    expect(findings).toContain("2026-09-08T05:23:21.266Z");
    expect(findings).toContain("1788844987021-wi4mma7n");
    expect(findings).toContain("49c127f4");
    expect(findings).toContain("cf9426243c2a5341809ef73aedd75a12");
    expect(findings).toContain("#123");
    expect(findings).toContain("Encrypt disabled+honest");
    expect(findings).toContain("encrypt-disabled-1e76e2b7/");
    expect(findings).toContain("34190597619");
    expect(findings).toContain("gate not opened");
    expect(findings).toContain("2026-09-08 ~16:34 ICT");
    expect(findings).toContain(
      "b4eba5d29cb8057c534c13588140bbe5ffa4f19e",
    );
    expect(findings).toContain("2026-09-08T09:34:08.672Z");
    expect(findings).toContain("1788860033092-xa1nnac8");
    expect(findings).toContain("07cb774d");
    expect(findings).toContain("e4513a962f72c21b2208e6272466fa65");
    expect(findings).toContain("#126");
    expect(findings).toContain("pixel-qa/a-prime-b4eba5d2/");
    expect(findings).toContain("34211082005");
    expect(findings).toContain("CTA Home");
    expect(findings).toContain("Encrypt omit");
    expect(findings).toContain("dynamic-import");
    expect(findings).toContain("SplitView not smoked");
    expect(findings).toContain("2026-09-08 ~23:28 ICT");
    expect(findings).toContain(
      "f84183ba32d4057a4012424766a4ee53577528a4",
    );
    expect(findings).toContain("2026-09-08T16:28:58.668Z");
    expect(findings).toContain("1788884922635-dbv60j3l");
    expect(findings).toContain("74637d87");
    expect(findings).toContain("981b13ea1b56f6022d8f8a01f41838e8");
    expect(findings).toContain("#128");
    expect(findings).toContain("34251814023");
    expect(findings).toContain("Duplicate securely is enabled");
    expect(findings).toContain("import-legacy");
    expect(findings).toContain("Pixel PASS");
    expect(findings).toContain("fail-path not smoke-tested live");
    expect(findings).toContain("2026-09-09 ~10:22 ICT");
    expect(findings).toContain(
      "2ae9a23084dbdddec5aeffb9dd9aff191602b4b8",
    );
    expect(findings).toContain("2026-09-09T03:22:42.753Z");
    expect(findings).toContain("1788924147004-wx705xxn");
    expect(findings).toContain("fb35474a");
    expect(findings).toContain("fc5e9588c9d1eefcb11aba320b9aa291");
    expect(findings).toContain("#130");
    expect(findings).toContain("#131");
    expect(findings).toContain("34306921753");
    expect(findings).toContain("convert-on-write");
    expect(findings).toContain("convert-legacy");
    expect(findings).toContain("umsg_01m21zhm");
    expect(findings).toContain("**applied** live");
    expect(findings).toContain("**published**");
    expect(findings).not.toContain(staleU1NotLive);
    expect(findings).not.toContain(staleGithubReady);
    expect(findings).toContain("Live UX W1 PASS");
    expect(findings).toContain("pixel-qa/w1-2ae9a230/");
    expect(findings).toContain("Saving securely");
    expect(findings).toContain("MEDIUM");
    expect(findings).toContain("This legacy note does not exist");
    expect(findings).toContain("sentinel-qa-w1-live/");
    expect(findings).toContain("BLOCKER none");
    expect(findings).toContain("HIGH residual");
    expect(findings).toContain("slug_unavailable");
    expect(findings).toContain("anon notes 42501");
    expect(findings).toContain('from("notes")');
    expect(findings).toContain("open secure link");
    expect(findings).toContain("2026-09-15 ~22:05 ICT");
    expect(findings).toContain(
      "0cdcdc0f31eed7db7b9301c4e6fbe7c079cf69dd",
    );
    expect(findings).toContain("2026-09-15T15:05:49.668Z");
    expect(findings).toContain("1789484737351-s31qn3nf");
    expect(findings).toContain("1b9ed3d1");
    expect(findings).toContain("573ea67f70cce0747dcdc959a13a3408");
    expect(findings).toContain("#135");
    expect(findings).toContain("#137");
    expect(findings).toContain("#138");
    expect(findings).toContain("#139");
    expect(findings).toContain("34986611791");
    expect(findings).toContain("free-edit");
    expect(findings).toContain("plain-upsert");
    expect(findings).toContain("disable-secure");
    expect(findings).toContain("capability_managed");
    expect(findings).toContain("Pixel PASS");
    expect(findings).toContain("pixel-qa/a3-0cdcdc0f/");
    expect(findings).toContain("sentinel-qa-a3-0cdcdc0f/");
    expect(findings).toContain("BLOCKER/HIGH/MEDIUM none");
    expect(findings).toContain(
      "9a80930aec5d7c018879bd2a406a35c055477f06",
    );
    expect(findings).toContain("2026-09-17T02:31:11.770Z");
    expect(findings).toContain("1789612258815-8yx2tdut");
    expect(findings).toContain("8e64829c");
    expect(findings).toContain("8e64829c-c182-45d1-ba27-5f43af7d20fd");
    expect(findings).toContain("ec3b8468a53852a90787dc61d6f80720");
    expect(findings).toContain("#145");
    expect(findings).toContain("#151");
    expect(findings).toContain("#153");
    expect(findings).toContain("pixel-qa/go-c-live-9a80930a/");
    expect(findings).toContain("sentinel-qa-go-c-live/");
    expect(findings).toContain("managed_live=3");
    expect(findings).toContain("## 3h.");
    expect(findings).toContain("## 3k.");
    expect(findings).toContain("## 3l.");
    expect(findings).toContain("pulse-rebulk-all6-20260922");
    expect(findings).toContain("managed_live=0");
    expect(findings).not.toContain("Origin is `0cdcdc0f`");
    expect(findings).not.toContain("Origin is `9a80930a`");
    expect(findings).toContain("Origin is `1b172544`");
    expect(findings).not.toContain("Origin is `44b02cb3`");
    expect(findings).toContain("new-version reminder");
    expect(findings).not.toContain("may still be in flight");
    expect(findings).not.toContain("Sentinel still completing");
    expect(findings).not.toContain("no Sentinel verdict");
    expect(findings).not.toContain("Origin is `9bf5e92b`");
    expect(findings).not.toContain("Origin is `b6824541`");
    expect(findings).not.toContain("Origin is `a8f7eeb8`");
    expect(findings).not.toContain("Origin is `5c33ac24`");
    expect(findings).not.toContain("Origin is `9dc0240e`");
    expect(findings).not.toContain("Origin is `15ec8285`");
    expect(findings).not.toContain("Origin is `0073d53b`");
    expect(findings).not.toContain("Origin is `1e76e2b7`");
    expect(findings).not.toContain("Origin is `b4eba5d2`");
    expect(findings).not.toContain("Origin is `f84183ba`");
    expect(findings).not.toContain("Origin is `2ae9a230`");
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

  it("pins leftover client/Worker present-tense surfaces to live origin canary 1b172544", () => {
    const client = readFileSync("docs/capability-client.md", "utf8");
    const backend = readFileSync("docs/capability-backend.md", "utf8");
    const worker = readFileSync("cloudflare-worker/README.md", "utf8");

    expect(client).toContain("`capabilityRoutesEnabled: true`");
    expect(client).toContain("findings §3e");
    expect(client).toContain("0cdcdc0f");
    expect(client).toContain("9a80930a");
    expect(client).toContain("44b02cb3");
    expect(client).toContain("1b172544");
    expect(client).toContain("This Home create path is live on origin `1b172544`");
    expect(client).toContain("seedAndOpen");
    expect(client).not.toContain("This Home create path is live on origin `44b02cb3`");
    expect(client).not.toContain("This Home mint path is live on origin `9a80930a`");
    expect(client).not.toContain("This Home mint path is live on origin `0cdcdc0f`");
    expect(client).not.toContain("live origin `0cdcdc0f`");
    expect(client).toContain("Choice A");
    expect(client).toContain("A′");
    expect(client).toContain("superseded");
    expect(client).toContain("W1");
    expect(client).toContain("W2");
    expect(client).toContain("convert-on-write");
    expect(client).toContain("free-edit");
    expect(client).toContain("convert-legacy");
    expect(client).toContain("plain-upsert");
    expect(client).toContain("disable-secure");
    expect(client).toContain("capability_managed");
    expect(client).toContain("umsg_01m21zhm");
    expect(client).toContain("**applied** live");
    expect(client).toContain("**published**");
    expect(client).not.toContain(staleU1NotLive);
    expect(client).not.toContain(staleGithubReady);
    expect(client).toContain("a-prime-cutover-restore.md");
    expect(client).toContain("#118");
    expect(client).toContain("#119");
    expect(client).toContain("#122");
    expect(client).toContain("#123");
    expect(client).toContain("#126");
    expect(client).toContain("#128");
    expect(client).toContain("#130");
    expect(client).toContain("#131");
    expect(client).toContain("#135");
    expect(client).toContain("#137");
    expect(client).toContain("#138");
    expect(client).toContain("#139");
    expect(client).toContain("#145");
    expect(client).toContain("#151");
    expect(client).toContain("#153");
    expect(client).toContain("legacyRo");
    expect(client).toContain("Duplicate securely is enabled");
    expect(client).toContain("import-legacy");
    expect(client).not.toContain("Duplicate securely is hidden with");
    expect(client).toContain("Phase C");
    expect(client).toContain("Pixel HIGH UX");
    expect(client).toContain("H1–H6");
    expect(client).toContain("H2");
    expect(client).toContain("opaque");
    expect(client).toContain("Mode/Export");
    expect(client).toContain("Ko-fi");
    expect(client).toContain("New Version");
    expect(client).toContain("#113");
    expect(client).toContain("#116");
    expect(client).toContain("#118");
    expect(client).toContain("#119");
    expect(client).toContain("#122");
    expect(client).toContain("#123");
    expect(client).toContain("Sonner");
    expect(client).toContain("FAB-primary");
    expect(client).toMatch(/LNO `exists`/);
    expect(client).toMatch(/LNO `open`/);
    expect(client).not.toContain(
      "Home create waits until the `notes.select` availability",
    );
    expect(client).toContain("seedAndOpen");
    expect(client).not.toContain("fail-open to legacy `seedAndOpen`");
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
    expect(client).not.toContain("live origin `77d791af`");
    expect(client).not.toContain("This Home mint path is live on origin `77d791af`");
    expect(client).not.toContain("live origin `9df65d53`");
    expect(client).not.toContain("This Home mint path is live on origin `9df65d53`");
    expect(client).not.toContain("live origin `9bf5e92b`");
    expect(client).not.toContain("This Home mint path is live on origin `9bf5e92b`");
    expect(client).not.toContain("live origin `b6824541`");
    expect(client).not.toContain("This Home mint path is live on origin `b6824541`");
    expect(client).not.toContain("live origin `a8f7eeb8`");
    expect(client).not.toContain("This Home mint path is live on origin `a8f7eeb8`");
    expect(client).not.toContain("live origin `5c33ac24`");
    expect(client).not.toContain("This Home mint path is live on origin `5c33ac24`");
    expect(client).not.toContain("live origin `9dc0240e`");
    expect(client).not.toContain("This Home mint path is live on origin `9dc0240e`");
    expect(client).not.toContain("live origin `15ec8285`");
    expect(client).not.toContain("This Home mint path is live on origin `15ec8285`");
    expect(client).not.toContain("live origin `0073d53b`");
    expect(client).not.toContain("This Home mint path is live on origin `0073d53b`");
    expect(client).not.toContain("live origin `1e76e2b7`");
    expect(client).not.toContain("This Home mint path is live on origin `1e76e2b7`");
    expect(client).not.toContain("live origin `b4eba5d2`");
    expect(client).not.toContain("This Home mint path is live on origin `b4eba5d2`");
    expect(client).not.toContain("live origin `f84183ba`");
    expect(client).not.toContain("This Home mint path is live on origin `f84183ba`");
    expect(client).not.toContain("live origin `2ae9a230`");
    expect(client).not.toContain("live origin `9a80930a`");
    expect(client).not.toContain("live origin `44b02cb3`");
    expect(client).not.toContain("This Home mint path is live on origin `2ae9a230`");
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
    expect(client).not.toContain("until a named Pages go");
    expect(client).not.toContain("still serves dual-mode `NotePage`");
    expect(client).toContain("CutoverNotePage");
    expect(client).toContain("Phase B");

    expect(backend).toContain("CutoverNotePage");
    expect(backend).toContain("Phase C");
    expect(backend).toContain("Pixel HIGH UX");
    expect(backend).toContain("H1–H6");
    expect(backend).toContain("H2");
    expect(backend).toContain("opaque");
    expect(backend).toContain("Mode/Export");
    expect(backend).toContain("Ko-fi");
    expect(backend).toContain("New Version");
    expect(backend).toContain("#113");
    expect(backend).toContain("#116");
    expect(backend).toContain("#118");
    expect(backend).toContain("#119");
    expect(backend).toContain("#122");
    expect(backend).toContain("#123");
    expect(backend).toContain("#126");
    expect(backend).toContain("#128");
    expect(backend).toContain("#130");
    expect(backend).toContain("#135");
    expect(backend).toContain("#137");
    expect(backend).toContain("#138");
    expect(backend).toContain("#139");
    expect(backend).toContain("#145");
    expect(backend).toContain("#151");
    expect(backend).toContain("#153");
    expect(backend).toContain("W1");
    expect(backend).toContain("W2");
    expect(backend).toContain("convert-on-write");
    expect(backend).toContain("free-edit");
    expect(backend).toContain("plain-upsert");
    expect(backend).toContain("disable-secure");
    expect(backend).toContain("capability_managed");
    expect(backend).toContain("convert-legacy");
    expect(backend).toContain("umsg_01m21zhm");
    expect(backend).toContain("**applied** live");
    expect(backend).toContain("**published**");
    expect(backend).not.toContain(staleU1NotLive);
    expect(backend).not.toContain(staleGithubReady);
    expect(backend).toContain("Choice A");
    expect(backend).toContain("A′");
    expect(backend).toContain("superseded");
    expect(backend).toContain("a-prime-cutover-restore.md");
    expect(backend).toContain("Sonner");
    expect(backend).toContain("FAB-primary");
    expect(backend).toContain("SQL 240 is already applied");
    expect(backend).not.toContain("SQL 240 is not applied");
    expect(backend).toContain("Duplicate securely is enabled");
    expect(backend).toContain("import-legacy");
    expect(backend).not.toContain("Duplicate securely is hidden with");
    expect(backend).not.toMatch(
      /Live writes remain the legacy `NotePage` path \(canary off\)/,
    );
    expect(backend).not.toContain("(canary off)");
    expect(backend).toContain("dual-mode canary on");
    expect(backend).toContain("Home create mints when canary is on");
    expect(backend).toContain("fail-closed idle");

    expect(worker).toContain("`0cdcdc0f`");
    expect(worker).toContain("`9a80930a`");
    expect(worker).toContain("`44b02cb3`");
    expect(worker).toContain("`1b172544`");
    expect(worker).toContain("Origin SPA hiện là `1b172544`");
    expect(worker).not.toContain("Origin SPA hiện là `44b02cb3`");
    expect(worker).not.toContain("Origin SPA hiện là `9a80930a`");
    expect(worker).not.toContain("Origin SPA hiện là `0cdcdc0f`");
    expect(worker).not.toContain("Origin SPA hiện là `addeeb29`");
    expect(worker).not.toContain("Origin SPA hiện là `7d00fd52`");
    expect(worker).not.toContain("Origin SPA hiện là `77d791af`");
    expect(worker).not.toContain("Origin SPA hiện là `9df65d53`");
    expect(worker).not.toContain("Origin SPA hiện là `9bf5e92b`");
    expect(worker).not.toContain("Origin SPA hiện là `b6824541`");
    expect(worker).not.toContain("Origin SPA hiện là `a8f7eeb8`");
    expect(worker).not.toContain("Origin SPA hiện là `5c33ac24`");
    expect(worker).not.toContain("Origin SPA hiện là `9dc0240e`");
    expect(worker).not.toContain("Origin SPA hiện là `15ec8285`");
    expect(worker).not.toContain("Origin SPA hiện là `0073d53b`");
    expect(worker).not.toContain("Origin SPA hiện là `1e76e2b7`");
    expect(worker).not.toContain("Origin SPA hiện là `b4eba5d2`");
    expect(worker).not.toContain("Origin SPA hiện là `f84183ba`");
    expect(worker).not.toContain("Origin SPA hiện là `2ae9a230`");
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

    const aPrime = readFileSync(
      "docs/security/a-prime-cutover-restore.md",
      "utf8",
    );
    expect(aPrime).toContain("0cdcdc0f");
    expect(aPrime).toContain("1b9ed3d1");
    expect(aPrime).toContain("9a80930a");
    expect(aPrime).toContain("8e64829c");
    expect(aPrime).toContain("44b02cb3");
    expect(aPrime).toContain("b44849c4");
    expect(aPrime).toContain("1b172544");
    expect(aPrime).toContain("5527f154");
    expect(aPrime).toContain("#151");
    expect(aPrime).toContain("#153");
    expect(aPrime).toContain("2ae9a230");
    expect(aPrime).toContain("fb35474a");
    expect(aPrime).toContain("f84183ba");
    expect(aPrime).toContain("74637d87");
    expect(aPrime).toContain("#126");
    expect(aPrime).toContain("#128");
    expect(aPrime).toContain("#130");
    expect(aPrime).toContain("#131");
    expect(aPrime).toContain("#135");
    expect(aPrime).toContain("#137");
    expect(aPrime).toContain("#138");
    expect(aPrime).toContain("#139");
    expect(aPrime).toContain("#145");
    expect(aPrime).toContain("Live UX W1 PASS");
    expect(aPrime).toContain("pixel-qa/w1-2ae9a230/");
    expect(aPrime).toContain("MEDIUM");
    expect(aPrime).toContain("READY WITH KNOWN RISKS");
    expect(aPrime).toContain("sentinel-qa-w1-live/");
    expect(aPrime).toContain("HIGH residual");
    expect(aPrime).toContain("slug_unavailable");
    expect(aPrime).toContain("Pixel PASS");
    expect(aPrime).toContain("pixel-qa/a3-0cdcdc0f/");
    expect(aPrime).toContain("sentinel-qa-a3-0cdcdc0f/");
    expect(aPrime).toContain("pixel-qa/go-c-live-9a80930a/");
    expect(aPrime).toContain("sentinel-qa-go-c-live/");
    expect(aPrime).toContain("free-edit");
    expect(aPrime).toContain("umsg_01m21zhm");
    expect(aPrime).toContain("**applied** live");
    expect(aPrime).toContain("**published**");
    expect(aPrime).not.toContain(staleU1NotLive);
    expect(aPrime).not.toContain(staleGithubReady);
    expect(aPrime).not.toContain("Sentinel still completing");
    expect(aPrime).toContain("DUPLICATE_SECURELY_AVAILABLE = true");
    expect(aPrime).not.toContain("DUPLICATE_SECURELY_AVAILABLE = false");
    expect(aPrime).not.toContain("remains Choice A until");
  });

  it("records live Worker 931430c0 / 5f94ab6c with logs live, origin now 1b172544", () => {
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
    expect(findings).toContain("Origin is `1b172544`");
    expect(findings).not.toContain("Origin is `44b02cb3`");
    expect(findings).not.toContain("Origin is `9a80930a`");
    expect(findings).not.toContain("Origin is `0cdcdc0f`");
    expect(findings).not.toContain("Origin is `7d00fd52`");
    expect(findings).not.toContain("Origin is `77d791af`");
    expect(findings).not.toContain("Origin is `9df65d53`");
    expect(findings).not.toContain("Origin is `9bf5e92b`");
    expect(findings).not.toContain("Origin is `b6824541`");
    expect(findings).not.toContain("Origin is `a8f7eeb8`");
    expect(findings).not.toContain("Origin is `5c33ac24`");
    expect(findings).not.toContain("Origin is `9dc0240e`");
    expect(findings).not.toContain("Origin is `15ec8285`");
    expect(findings).not.toContain("Origin is `0073d53b`");
    expect(findings).not.toContain("Origin is `1e76e2b7`");
    expect(findings).not.toContain("Origin is `b4eba5d2`");
    expect(findings).not.toContain("Origin is `f84183ba`");
    expect(findings).not.toContain("Origin is `2ae9a230`");
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
    expect(rollout).toContain("Origin remains `1b172544`");
    expect(rollout).not.toContain("Origin remains `44b02cb3`");
    expect(rollout).not.toContain("Origin remains `9a80930a`");
    expect(rollout).not.toContain("Origin remains `0cdcdc0f`");
    expect(rollout).not.toContain("Origin remains `7d00fd52`");
    expect(rollout).not.toContain("Origin remains `77d791af`");
    expect(rollout).not.toContain("Origin remains `9df65d53`");
    expect(rollout).not.toContain("Origin remains `9bf5e92b`");
    expect(rollout).not.toContain("Origin remains `b6824541`");
    expect(rollout).not.toContain("Origin remains `a8f7eeb8`");
    expect(rollout).not.toContain("Origin remains `5c33ac24`");
    expect(rollout).not.toContain("Origin remains `9dc0240e`");
    expect(rollout).not.toContain("Origin remains `15ec8285`");
    expect(rollout).not.toContain("Origin remains `0073d53b`");
    expect(rollout).not.toContain("Origin remains `1e76e2b7`");
    expect(rollout).not.toContain("Origin remains `b4eba5d2`");
    expect(rollout).not.toContain("Origin remains `f84183ba`");
    expect(rollout).not.toContain("Origin remains `2ae9a230`");
    expect(rollout).toContain("Home mint live");
    expect(rollout).toContain("fail-closed idle");
    expect(rollout).toContain("Phase C");
    expect(rollout).toContain("Pixel HIGH UX");
    expect(rollout).toContain("H1–H6");
    expect(rollout).toContain("H2");
    expect(rollout).toContain("opaque");
    expect(rollout).toContain("Mode/Export");
    expect(rollout).toContain("Ko-fi");
    expect(rollout).toContain("New Version");
    expect(rollout).toContain("#113");
    expect(rollout).toContain("#116");
    expect(rollout).toContain("#118");
    expect(rollout).toContain("#119");
    expect(rollout).toContain("#122");
    expect(rollout).toContain("#123");
    expect(rollout).toContain("#126");
    expect(rollout).toContain("#128");
    expect(rollout).toContain("#130");
    expect(rollout).toContain("#135");
    expect(rollout).toContain("#137");
    expect(rollout).toContain("#138");
    expect(rollout).toContain("#139");
    expect(rollout).toContain("#145");
    expect(rollout).toContain("#151");
    expect(rollout).toContain("#153");
    expect(rollout).toContain("umsg_01m21zhm");
    expect(rollout).toContain("applied live");
    expect(rollout).toContain("published");
    expect(rollout).not.toContain(staleU1NotLive);
    expect(rollout).not.toContain(staleGithubReady);
    expect(rollout).toContain("Choice A");
    expect(rollout).toContain("Sonner");
    expect(rollout).toContain("FAB-primary");

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
    expect(adr).toContain("Live origin `1b172544`");
    expect(adr).toContain("always bare `seedAndOpen`");
    expect(adr).not.toContain("Live origin `44b02cb3`");
    expect(adr).not.toContain("Live origin `9a80930a`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `9a80930a`");
    expect(adr).toContain("#110");
    expect(adr).toContain("#113");
    expect(adr).toContain("#116");
    expect(adr).toContain("#118");
    expect(adr).toContain("#119");
    expect(adr).toContain("#122");
    expect(adr).toContain("#123");
    expect(adr).toContain("#126");
    expect(adr).toContain("#128");
    expect(adr).toContain("#130");
    expect(adr).toContain("#131");
    expect(adr).toContain("#135");
    expect(adr).toContain("#137");
    expect(adr).toContain("#138");
    expect(adr).toContain("#139");
    expect(adr).toContain("#145");
    expect(adr).toContain("#151");
    expect(adr).toContain("#153");
    expect(adr).toContain("Choice A");
    expect(adr).toContain("A′");
    expect(adr).toContain("superseded");
    expect(adr).toContain("a-prime-cutover-restore.md");
    expect(adr).toContain("umsg_01m21zhm");
    expect(adr).toContain("**applied** live");
    expect(adr).toContain("**published**");
    expect(adr).not.toContain(staleU1NotLive);
    expect(adr).not.toContain(staleGithubReady);
    expect(adr).not.toContain("Duplicate securely is hidden with");
    expect(adr).toContain("Sonner");
    expect(adr).toContain("FAB-primary");
    expect(adr).toMatch(/LNO `exists`/);
    expect(adr).not.toContain(
      "Home existence check today is `select slug, char_count from notes`",
    );
    expect(adr).not.toContain("Live origin `7d00fd52`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `7d00fd52`");
    expect(adr).not.toContain("Live origin `77d791af`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `77d791af`");
    expect(adr).not.toContain("Live origin `9df65d53`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `9df65d53`");
    expect(adr).not.toContain("Live origin `9bf5e92b`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `9bf5e92b`");
    expect(adr).not.toContain("Live origin `b6824541`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `b6824541`");
    expect(adr).not.toContain("Live origin `a8f7eeb8`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `a8f7eeb8`");
    expect(adr).not.toContain("Live origin `5c33ac24`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `5c33ac24`");
    expect(adr).not.toContain("Live origin `9dc0240e`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `9dc0240e`");
    expect(adr).not.toContain("Live origin `15ec8285`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `15ec8285`");
    expect(adr).not.toContain("Live origin `0073d53b`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `0073d53b`");
    expect(adr).not.toContain("Live origin `1e76e2b7`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `1e76e2b7`");
    expect(adr).not.toContain("Live origin `b4eba5d2`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `b4eba5d2`");
    expect(adr).not.toContain("Live origin `f84183ba`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `f84183ba`");
    expect(adr).not.toContain("Live origin `2ae9a230`");
    expect(adr).not.toContain("Home mint fail-closed idle live on origin `2ae9a230`");
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
    expect(cutover).toContain("2026-09-07 ~09:51 ICT");
    expect(cutover).toContain(
      "9df65d53b5ca38fbd48db4c9fe0fb57a950192f8",
    );
    expect(cutover).toContain("2026-09-07 ~11:17 ICT");
    expect(cutover).toContain(
      "9bf5e92bf07cd82ff1775bc3d4a369b330de6a42",
    );
    expect(cutover).toContain("2026-09-07 ~11:36 ICT");
    expect(cutover).toContain(
      "b68245410d64aac8ac44c4f9a831e859a343cf00",
    );
    expect(cutover).toContain("2026-09-07 ~12:28 ICT");
    expect(cutover).toContain(
      "a8f7eeb830b8440b899a6ccf0f8018f1a4fe8805",
    );
    expect(cutover).toContain("2026-09-07 ~13:31 ICT");
    expect(cutover).toContain(
      "5c33ac241d6f6b4548ea290c299e15e4be799921",
    );
    expect(cutover).toContain("2026-09-07 ~17:42 ICT");
    expect(cutover).toContain(
      "9dc0240e7d714d548711623f94a50c42dac64475",
    );
    expect(cutover).toContain("2026-09-07 ~18:56 ICT");
    expect(cutover).toContain(
      "15ec8285a7f02fdf383a1b5aa87ccd13d72ba6f7",
    );
    expect(cutover).toContain("2026-09-08 ~10:24 ICT");
    expect(cutover).toContain(
      "0073d53bb2524882eda0c36528f0c25a94346a65",
    );
    expect(cutover).toContain("2026-09-08 ~12:23 ICT");
    expect(cutover).toContain(
      "1e76e2b7cb1ee239cb9af1bc8e8a04c229641e7d",
    );
    expect(cutover).toContain("2026-09-08 ~16:34 ICT");
    expect(cutover).toContain(
      "b4eba5d29cb8057c534c13588140bbe5ffa4f19e",
    );
    expect(cutover).toContain("2026-09-08 ~23:28 ICT");
    expect(cutover).toContain(
      "f84183ba32d4057a4012424766a4ee53577528a4",
    );
    expect(cutover).toContain("2026-09-09 ~10:22 ICT");
    expect(cutover).toContain(
      "2ae9a23084dbdddec5aeffb9dd9aff191602b4b8",
    );
    expect(cutover).toContain("2026-09-15 ~22:05 ICT");
    expect(cutover).toContain(
      "0cdcdc0f31eed7db7b9301c4e6fbe7c079cf69dd",
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
    expect(cutover).not.toMatch(
      /live `deployedSha` `77d791af89696877f1f794a94270395902285c56`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `9df65d53b5ca38fbd48db4c9fe0fb57a950192f8`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `9bf5e92bf07cd82ff1775bc3d4a369b330de6a42`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `b68245410d64aac8ac44c4f9a831e859a343cf00`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `a8f7eeb830b8440b899a6ccf0f8018f1a4fe8805`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `5c33ac241d6f6b4548ea290c299e15e4be799921`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `9dc0240e7d714d548711623f94a50c42dac64475`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `15ec8285a7f02fdf383a1b5aa87ccd13d72ba6f7`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `0073d53bb2524882eda0c36528f0c25a94346a65`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `1e76e2b7cb1ee239cb9af1bc8e8a04c229641e7d`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `b4eba5d29cb8057c534c13588140bbe5ffa4f19e`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `f84183ba32d4057a4012424766a4ee53577528a4`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `2ae9a23084dbdddec5aeffb9dd9aff191602b4b8`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `0cdcdc0f31eed7db7b9301c4e6fbe7c079cf69dd`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `9a80930aec5d7c018879bd2a406a35c055477f06`/,
    );
    expect(cutover).not.toMatch(
      /live `deployedSha` `44b02cb3429999050aa850489b18b98a58ef2499`/,
    );
    expect(cutover).toMatch(
      /live `deployedSha` `1b1725446120ce9dd28bc7fe884c3768e37e435d`/,
    );
    expect(cutover).toContain("Phase C");
    expect(cutover).toContain("Pixel HIGH UX");
    expect(cutover).toContain("H1–H6");
    expect(cutover).toContain("H2");
    expect(cutover).toContain("opaque");
    expect(cutover).toContain("Mode/Export");
    expect(cutover).toContain("Ko-fi");
    expect(cutover).toContain("New Version");
    expect(cutover).toContain("#113");
    expect(cutover).toContain("#116");
    expect(cutover).toContain("#118");
    expect(cutover).toContain("#119");
    expect(cutover).toContain("#122");
    expect(cutover).toContain("#123");
    expect(cutover).toContain("#126");
    expect(cutover).toContain("#128");
    expect(cutover).toContain("#130");
    expect(cutover).toContain("#131");
    expect(cutover).toContain("#135");
    expect(cutover).toContain("#137");
    expect(cutover).toContain("#138");
    expect(cutover).toContain("#139");
    expect(cutover).toContain("#145");
    expect(cutover).toContain("#151");
    expect(cutover).toContain("#153");
    expect(cutover).toContain("umsg_01m21zhm");
    expect(cutover).toContain("**applied**");
    expect(cutover).toContain("**published**");
    expect(cutover).not.toContain(staleU1NotLive);
    expect(cutover).not.toContain(staleGithubReady);
    expect(cutover).toContain("Choice A");
    expect(cutover).toContain("A′");
    expect(cutover).toContain("superseded");
    expect(cutover).toContain("a-prime-cutover-restore.md");
    expect(cutover).toContain("Sonner");
    expect(cutover).toContain("FAB-primary");
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

  it("records historical bulk Legacy/Secure OFF, Go C leftovers, and re-bulk OFF ALL 6", () => {
    const readme = readFileSync("README.md", "utf8");
    const findings = readFileSync("docs/security-findings.md", "utf8");
    const runbook = readFileSync("docs/security/bulk-disable-secure-ops.md", "utf8");
    const backend = readFileSync("docs/capability-backend.md", "utf8");
    const client = readFileSync("docs/capability-client.md", "utf8");
    const aPrime = readFileSync("docs/security/a-prime-cutover-restore.md", "utf8");
    const contract = readFileSync(
      "docs/security/sql-240-readiness-contract.md",
      "utf8",
    );
    const preflight = readFileSync(
      "docs/security/sql-240-ops-preflight.md",
      "utf8",
    );
    const adr = readFileSync(
      "docs/adr/001-home-capability-mint-before-sql-240.md",
      "utf8",
    );
    const worker = readFileSync("cloudflare-worker/README.md", "utf8");
    const rollout = readFileSync(
      "docs/security/immediate-containment-rollout.md",
      "utf8",
    );
    const cutover = readFileSync(
      "docs/security/atomic-capability-cutover.md",
      "utf8",
    );

    for (const source of [
      readme,
      findings,
      runbook,
      backend,
      client,
      aPrime,
      contract,
      preflight,
      adr,
      worker,
      rollout,
      cutover,
    ]) {
      expect(source).toContain("0cdcdc0f");
      expect(source).toContain("9a80930a");
      expect(source).toContain("44b02cb3");
      expect(source).toContain("1b172544");
      expect(source).toContain("capability_note_bulk_disable_secure");
      expect(source).toMatch(/Go C/i);
      expect(source).toContain("HOLD");
      expect(source).not.toContain("Origin is `bd11deed`");
      expect(source).not.toContain("live origin `bd11deed`");
    }

    expect(readme).toContain("docs attest");
    expect(readme).toContain("not a SPA ship");
    expect(readme).toContain("26→0");
    expect(readme).toContain("skipped_encrypted=0");
    expect(readme).toContain("PASS WITH KNOWN RISKS");
    expect(readme).toContain("khớp design");
    expect(readme).toContain("snote:legacy-secure:");
    expect(readme).toContain("/workspace/pixel-qa/bulk-off-verify/");
    expect(readme).toContain("/workspace/sentinel-qa-bulk-off-live/");
    expect(readme).toContain("does not re-apply");
    expect(readme).toContain("managed_live=3");
    expect(readme).toContain("unmanaged_live=106");
    expect(readme).toContain("pixel-qa/go-c-live-9a80930a/");
    expect(readme).toContain("sentinel-qa-go-c-live");
    expect(readme).toContain("pulse-rebulk-all6-20260922");
    expect(readme).toContain("sentinel-qa-rebulk-all6-live");
    expect(readme).toContain("converted=6");
    expect(readme).toContain("managed_live=0");
    expect(readme).toContain("no re-migrate");

    expect(findings).toContain(
      "## 3f. Production bulk Legacy/Secure OFF — verified; origin unchanged",
    );
    expect(findings).toContain("## 3g.");
    expect(findings).toContain("## 3h. Production re-bulk OFF ALL 6 — verified; origin unchanged");
    expect(findings).toContain("bd11deedf95bec1f2e207a59fecdad974d861ff7");
    expect(findings).toContain(
      "a5d6623fda2ca811388396f7945ab19a305a95c84d423dc206d168f4425ab850",
    );
    expect(findings).toContain("Pulse **PASS**");
    expect(findings).toContain("service_role");
    expect(findings).toContain("26→0");
    expect(findings).toContain("snote:legacy-secure:");
    expect(findings).toContain("/workspace/pulse-bulk-off-ab2c4de9/");
    expect(findings).toContain("Origin is `1b172544`");
    expect(findings).not.toContain("Origin is `44b02cb3`");
    expect(findings).not.toContain("Origin is `9a80930a`");
    expect(findings).not.toContain("Origin is `0cdcdc0f`");
    expect(findings).toContain("This is not SQL 240, not Realtime, not soak-complete.");
    expect(findings).toContain("converted=6");
    expect(findings).toContain("no re-migrate");
    expect(findings).toContain("/workspace/pulse-rebulk-all6-20260922/");
    expect(findings).toContain("/workspace/sentinel-qa-rebulk-all6-live/");
    expect(findings).toContain("Pulse post-verify");

    expect(runbook).toContain("**applied** live");
    expect(runbook).toContain("attestation");
    expect(backend).toContain("**applied** live");
    expect(client).toContain("snote:legacy-secure:");
    expect(aPrime).toContain("pixel-qa/bulk-off-verify/");
    expect(contract).toContain("bd11deed");
    expect(preflight).toContain("bd11deed");
    expect(adr).toContain("bd11deed");
    expect(worker).toContain("không đổi origin");
    expect(rollout).toContain("Go C");
    expect(cutover).toContain("Bulk Legacy/Secure OFF");
  });

  it("records live Go C pin heal on origin 9a80930a without claiming a new deploy", () => {
    const readme = readFileSync("README.md", "utf8");
    const findings = readFileSync("docs/security-findings.md", "utf8");
    const runbook = readFileSync("docs/security/bulk-disable-secure-ops.md", "utf8");

    expect(readme).toContain("9a80930a");
    expect(readme).toContain("8e64829c");
    expect(readme).toContain("#145");
    expect(readme).toContain("LNO-wins");
    expect(readme).toContain("silent");
    expect(readme).toContain("fail-closed");
    expect(readme).toContain("no auto-ON");
    expect(readme).toContain("managed_live=3");
    expect(readme).toContain("hage");
    expect(readme).toContain("xqmqh53z");
    expect(readme).toContain("svgoccbe2542573b");
    expect(readme).toContain("unmanaged_live=106");
    expect(readme).toContain("pixel-qa/go-c-live-9a80930a/");
    expect(readme).toContain("sentinel-qa-go-c-live");
    expect(readme).toContain("READY WITH KNOWN RISKS");
    expect(readme).toContain("still-managed");
    expect(readme).toContain("does not deploy origin");
    expect(readme).toContain("does not re-apply SQL");

    expect(findings).toContain("9a80930aec5d7c018879bd2a406a35c055477f06");
    expect(findings).toContain("8e64829c-c182-45d1-ba27-5f43af7d20fd");
    expect(findings).toContain("1789612258815-8yx2tdut");
    expect(findings).toContain("ec3b8468a53852a90787dc61d6f80720");
    expect(findings).toContain("At that attest, live SPA origin was `9a80930a`");
    expect(findings).toContain("Origin is `1b172544`");
    expect(findings).not.toContain("Origin is `44b02cb3`");
    expect(findings).toContain("shipped");
    expect(findings).toContain("managed_live=3");
    expect(findings).toContain("35136042556");
    expect(findings).toContain("does not claim a later PWA smoke PASS");
    expect(findings).not.toContain("Go C pin heal **HOLD**");
    expect(findings).toContain("This is not SQL 240, not Realtime, not soak-complete.");

    expect(runbook).toContain("9a80930a");
    expect(runbook).toContain("managed_live=3");
    expect(runbook).toContain("shipped");
  });

  it("records re-bulk OFF ALL 6 live PASS without claiming a new origin deploy", () => {
    const readme = readFileSync("README.md", "utf8");
    const findings = readFileSync("docs/security-findings.md", "utf8");
    const runbook = readFileSync("docs/security/bulk-disable-secure-ops.md", "utf8");
    const backend = readFileSync("docs/capability-backend.md", "utf8");
    const client = readFileSync("docs/capability-client.md", "utf8");
    const adr = readFileSync(
      "docs/adr/001-home-capability-mint-before-sql-240.md",
      "utf8",
    );

    expect(readme).toContain("Re-bulk OFF ALL 6");
    expect(readme).toContain("converted=6");
    expect(readme).toContain("no re-migrate");
    expect(readme).toContain("gr3l8g5e");
    expect(readme).toContain("svgocc0360f59afa");
    expect(readme).toContain("x915930e");
    expect(readme).toContain("managed_live=0");
    expect(readme).toContain("Pulse post-verify");
    expect(readme).toContain("pulse-rebulk-all6-20260922");
    expect(readme).toContain("sentinel-qa-rebulk-all6-live");
    expect(readme).toContain("content_len");
    expect(readme).toContain("401");
    expect(readme).toContain("9a80930a");
    expect(readme).toContain("1789612258815-8yx2tdut");
    expect(readme).toContain("does not deploy origin");
    expect(readme).toContain("does not re-apply SQL");
    expect(readme).toContain("does not re-run bulk RPC");

    expect(findings).toContain("## 3h. Production re-bulk OFF ALL 6 — verified; origin unchanged");
    expect(findings).toContain("capability_note_bulk_disable_secure(500,false)");
    expect(findings).toContain("converted=6");
    expect(findings).toContain("no re-migrate");
    expect(findings).toContain("Pulse post-verify");
    expect(findings).toContain("anon fleet RO count was unavailable (401)");
    expect(findings).toContain("content_len drift");
    expect(findings).toContain("1 CSP console error");
    expect(findings).toContain("BLOCKER/HIGH/MEDIUM");
    expect(findings).toContain("Origin is `1b172544`");
    expect(findings).not.toContain("Origin is `44b02cb3`");
    expect(findings).not.toContain("Origin is `9a80930a`");
    expect(findings).not.toContain("Origin is `0cdcdc0f`");
    expect(findings).not.toContain("Go C pin heal **HOLD**");

    expect(runbook).toContain("/workspace/pulse-rebulk-all6-20260922/");
    expect(runbook).toContain("converted=6");
    expect(runbook).toContain("managed_live=0");
    expect(runbook).toContain("no re-migrate");
    expect(backend).toContain("Re-bulk OFF ALL 6");
    expect(client).toContain("Re-bulk OFF ALL 6");
    expect(adr).toContain("re-bulk OFF ALL 6");
  });

  it("records Go SQL allowlist p_slugs live applied without origin ship or fleet OFF", () => {
    const readme = readFileSync("README.md", "utf8");
    const findings = readFileSync("docs/security-findings.md", "utf8");
    const runbook = readFileSync("docs/security/bulk-disable-secure-ops.md", "utf8");
    const backend = readFileSync("docs/capability-backend.md", "utf8");
    const client = readFileSync("docs/capability-client.md", "utf8");
    const adr = readFileSync(
      "docs/adr/001-home-capability-mint-before-sql-240.md",
      "utf8",
    );
    const worker = readFileSync("cloudflare-worker/README.md", "utf8");
    const contract = readFileSync(
      "docs/security/sql-240-readiness-contract.md",
      "utf8",
    );
    const preflight = readFileSync(
      "docs/security/sql-240-ops-preflight.md",
      "utf8",
    );
    const rollout = readFileSync(
      "docs/security/immediate-containment-rollout.md",
      "utf8",
    );
    const cutover = readFileSync(
      "docs/security/atomic-capability-cutover.md",
      "utf8",
    );
    const aPrime = readFileSync("docs/security/a-prime-cutover-restore.md", "utf8");

    expect(readme).toContain("Go SQL allowlist");
    expect(readme).toContain("p_slugs");
    expect(readme).toContain("46ddaf01");
    expect(readme).toContain("#148");
    expect(readme).toContain(
      "f16a20a661dc96523bf9a717a830dbe51df2d2427206a72a7c9c373b4a782132",
    );
    expect(readme).toContain("20260922000000_capability_note_bulk_disable_secure_p_slugs.sql");
    expect(readme).toContain("DROP");
    expect(readme).toContain("3-arg");
    expect(readme).toContain("converted=0");
    expect(readme).toContain("scope=allowlist");
    expect(readme).toContain("skipped_allowlist_miss=1");
    expect(readme).toContain("aggadagdade");
    expect(readme).toContain("managed_live=1");
    expect(readme).toContain("**No bulk OFF.**");
    expect(readme).toContain("pulse-allowlist-sql-46ddaf01");
    expect(readme).toContain("sentinel-qa-allowlist-sql-46ddaf01");
    expect(readme).toContain("schema_migrations");
    expect(readme).toContain("9a80930a");
    expect(readme).toMatch(/does not\s+move Pages/);
    expect(readme).toContain("does not deploy origin");
    expect(readme).toContain("does not re-apply SQL");
    expect(readme).not.toContain("GitHub 3-arg `p_slugs` allowlist **not applied**");
    expect(readme).not.toContain("Live production still has the 2-arg");

    expect(findings).toContain(
      "## 3i. Production Go SQL allowlist `p_slugs` — verified; origin unchanged",
    );
    expect(findings).toContain("46ddaf012bea1d01a6235e2be7e9132555d6cd84");
    expect(findings).toContain(
      "f16a20a661dc96523bf9a717a830dbe51df2d2427206a72a7c9c373b4a782132",
    );
    expect(findings).toContain("aggadagdade");
    expect(findings).toContain("managed_live=1");
    expect(findings).toContain("**No bulk OFF.**");
    expect(findings).toContain("skipped_allowlist_miss=1");
    expect(findings).toContain("schema_migrations");
    expect(findings).toContain("/workspace/pulse-allowlist-sql-46ddaf01/");
    expect(findings).toContain("/workspace/sentinel-qa-allowlist-sql-46ddaf01/");
    expect(findings).toContain("**READY**");
    expect(findings).toContain("Origin is `1b172544`");
    expect(findings).not.toContain("Origin is `44b02cb3`");
    expect(findings).not.toContain("GitHub 3-arg `p_slugs` allowlist **not applied**");
    expect(findings).not.toContain("Go C pin heal **HOLD**");

    expect(runbook).toContain("**applied live**");
    expect(runbook).not.toContain("**not applied**");
    expect(runbook).not.toContain("GitHub-only");
    expect(runbook).toContain("46ddaf01");
    expect(runbook).toContain("aggadagdade");
    expect(runbook).toContain("managed_live=1");
    expect(backend).toContain("**applied live**");
    expect(backend).toContain("46ddaf01");
    expect(backend).toContain("aggadagdade");
    expect(backend).not.toContain("GitHub 3-arg `p_slugs` allowlist is **not applied**");
    expect(client).toContain("**applied live**");
    expect(client).toContain("aggadagdade");
    expect(adr).toContain("46ddaf01");
    expect(adr).toContain("aggadagdade");
    expect(adr).toContain("**applied live**");
    expect(adr).not.toContain("GitHub 3-arg `p_slugs` allowlist **not applied**");
    expect(worker).toContain("46ddaf01");
    expect(worker).toContain("không đổi origin");
    expect(contract).toContain("46ddaf01");
    expect(contract).toContain("aggadagdade");
    expect(preflight).toContain("46ddaf01");
    expect(preflight).toContain("aggadagdade");
    expect(rollout).toContain("46ddaf01");
    expect(rollout).toContain("aggadagdade");
    expect(cutover).toContain("46ddaf01");
    expect(cutover).toContain("aggadagdade");
    expect(aPrime).toContain("46ddaf01");
    expect(aPrime).toContain("aggadagdade");
  });

  it("records Go Ops allowlist bulk OFF 2→0 live PASS without fleet NULL or origin ship", () => {
    const readme = readFileSync("README.md", "utf8");
    const findings = readFileSync("docs/security-findings.md", "utf8");
    const runbook = readFileSync("docs/security/bulk-disable-secure-ops.md", "utf8");
    const backend = readFileSync("docs/capability-backend.md", "utf8");
    const client = readFileSync("docs/capability-client.md", "utf8");
    const adr = readFileSync(
      "docs/adr/001-home-capability-mint-before-sql-240.md",
      "utf8",
    );
    const worker = readFileSync("cloudflare-worker/README.md", "utf8");
    const contract = readFileSync(
      "docs/security/sql-240-readiness-contract.md",
      "utf8",
    );
    const preflight = readFileSync(
      "docs/security/sql-240-ops-preflight.md",
      "utf8",
    );
    const rollout = readFileSync(
      "docs/security/immediate-containment-rollout.md",
      "utf8",
    );
    const cutover = readFileSync(
      "docs/security/atomic-capability-cutover.md",
      "utf8",
    );
    const aPrime = readFileSync("docs/security/a-prime-cutover-restore.md", "utf8");

    expect(readme).toContain("Go Ops allowlist bulk OFF");
    expect(readme).toContain("ARRAY[aggadagdade,pbhcusvb]");
    expect(readme).toContain("pbhcusvb");
    expect(readme).toContain("converted=2");
    expect(readme).toContain("managed_live=2");
    expect(readme).toContain("not fleet");
    expect(readme).toContain("residual **cleared**");
    expect(readme).toContain("pulse-bulk-off-allowlist-20260922");
    expect(readme).toContain("sentinel-qa-bulk-off-allowlist-20260922");
    expect(readme).toContain("836753fe");
    expect(readme).toContain("9a80930a");
    expect(readme).toMatch(/does not\s+move Pages/);
    expect(readme).toContain("does not deploy origin");
    expect(readme).toContain("does not re-apply SQL");
    expect(readme).toContain("does not re-run bulk RPC");
    expect(readme).not.toContain("GitHub 3-arg `p_slugs` allowlist **not applied**");

    expect(findings).toContain(
      "## 3j. Production Go Ops allowlist bulk OFF 2→0 — verified; origin unchanged",
    );
    expect(findings).toContain("ARRAY[aggadagdade,pbhcusvb]");
    expect(findings).toContain("converted=2");
    expect(findings).toContain("pbhcusvb");
    expect(findings).toContain("not fleet");
    expect(findings).toContain("Residual **cleared**");
    expect(findings).toContain("/workspace/pulse-bulk-off-allowlist-20260922/");
    expect(findings).toContain("/workspace/sentinel-qa-bulk-off-allowlist-20260922/");
    expect(findings).toContain("**READY**");
    expect(findings).toContain("Origin is `1b172544`");
    expect(findings).not.toContain("Origin is `44b02cb3`");
    expect(findings).toContain("836753fe");
    expect(findings).not.toContain("Go C pin heal **HOLD**");

    expect(runbook).toContain("Go Ops allowlist bulk OFF");
    expect(runbook).toContain("ARRAY[aggadagdade,pbhcusvb]");
    expect(runbook).toContain("converted=2");
    expect(runbook).toContain("836753fe");
    expect(runbook).toContain("Residual **cleared**");
    expect(backend).toContain("Go Ops allowlist bulk OFF");
    expect(backend).toContain("pbhcusvb");
    expect(backend).toContain("not fleet");
    expect(client).toContain("Go Ops allowlist bulk OFF");
    expect(client).toContain("pbhcusvb");
    expect(adr).toContain("Go Ops allowlist bulk OFF");
    expect(adr).toContain("pbhcusvb");
    expect(worker).toContain("Go Ops allowlist bulk OFF 2→0");
    expect(worker).toContain("không đổi origin");
    expect(contract).toContain("Go Ops allowlist bulk OFF");
    expect(contract).toContain("residual **cleared**");
    expect(preflight).toContain("Go Ops allowlist bulk OFF");
    expect(preflight).toContain("residual **cleared**");
    expect(rollout).toContain("Go Ops allowlist bulk OFF");
    expect(rollout).toContain("residual **cleared**");
    expect(cutover).toContain("Go Ops allowlist bulk OFF");
    expect(cutover).toContain("pbhcusvb");
    expect(aPrime).toContain("Go Ops allowlist bulk OFF");
    expect(aPrime).toContain("residual **cleared**");
  });

  it("records live #151 Origin SPA 44b02cb3 without claiming Edge XOR shipped", () => {
    const readme = readFileSync("README.md", "utf8");
    const findings = readFileSync("docs/security-findings.md", "utf8");
    const client = readFileSync("docs/capability-client.md", "utf8");
    const backend = readFileSync("docs/capability-backend.md", "utf8");
    const worker = readFileSync("cloudflare-worker/README.md", "utf8");
    const adr = readFileSync(
      "docs/adr/001-home-capability-mint-before-sql-240.md",
      "utf8",
    );
    const aPrime = readFileSync(
      "docs/security/a-prime-cutover-restore.md",
      "utf8",
    );
    const cutover = readFileSync(
      "docs/security/atomic-capability-cutover.md",
      "utf8",
    );
    const runbook = readFileSync(
      "docs/security/bulk-disable-secure-ops.md",
      "utf8",
    );
    const contract = readFileSync(
      "docs/security/sql-240-readiness-contract.md",
      "utf8",
    );
    const preflight = readFileSync(
      "docs/security/sql-240-ops-preflight.md",
      "utf8",
    );
    const rollout = readFileSync(
      "docs/security/immediate-containment-rollout.md",
      "utf8",
    );

    expect(readme).toContain("44b02cb3");
    expect(readme).toContain("b44849c4");
    expect(readme).toContain("44b02cb3429999050aa850489b18b98a58ef2499");
    expect(readme).toContain("1790066192935-qg7oaft7");
    expect(readme).toContain("2026-09-22T08:36:49.543Z");
    expect(readme).toContain("#151");
    expect(readme).toContain("seedAndOpen");
    expect(readme).toContain("no default mint");
    expect(readme).toContain("hard XOR");
    expect(readme).toContain("invalid_state");
    expect(readme).toContain("NOT VERIFIED");
    expect(readme).toContain("in-repo only");
    expect(readme).toContain("note-manage");
    expect(readme).toContain("Pixel READY WITH KNOWN RISKS");
    expect(readme).toContain("does not deploy origin");
    expect(readme).not.toContain("Home mints capabilities when canary is on");

    expect(findings).toContain(
      "## 3k. Production #151 Origin SPA — verified; origin 44b02cb3; Edge XOR not shipped",
    );
    expect(findings).toContain("44b02cb3429999050aa850489b18b98a58ef2499");
    expect(findings).toContain("1790066192935-qg7oaft7");
    expect(findings).toContain("b44849c4");
    expect(findings).toContain("Origin is `1b172544`");
    expect(findings).not.toContain("Origin is `44b02cb3`");
    expect(findings).not.toContain("Origin is `9a80930a`");
    expect(findings).toContain("seedAndOpen");
    expect(findings).toContain("invalid_state");
    expect(findings).toContain("NOT VERIFIED");
    expect(findings).toContain("in-repo only");
    expect(findings).toContain("note-session");
    expect(findings).toContain("note-manage");
    expect(findings).toContain("SUPABASE_ACCESS_TOKEN");
    expect(findings).toContain("Pixel READY WITH KNOWN RISKS khớp");
    expect(findings).toContain("Do **not** claim Edge XOR live PASS");
    expect(findings).toContain("This is not SQL 240, not Realtime, not soak-complete.");

    expect(client).toContain("This Home create path is live on origin `1b172544`");
    expect(client).toContain("seedAndOpen");
    expect(backend).toContain("Live origin is `1b172544`");
    expect(worker).toContain("Origin SPA hiện là `1b172544`");
    expect(adr).toContain("Live origin `1b172544`");
    expect(aPrime).toContain("Current live origin `1b172544` / Pages `5527f154`");
    expect(cutover).toContain("44b02cb3429999050aa850489b18b98a58ef2499");
    expect(runbook).toContain("44b02cb3");
    expect(runbook).toContain("b44849c4");
    expect(contract).toContain("origin `44b02cb3` / Pages `b44849c4`");
    expect(preflight).toContain("1790066192935-qg7oaft7");
    expect(preflight).toContain("b44849c4");
    expect(rollout).toContain("Origin remains `1b172544`");
  });

  it("records live #153 Origin SPA 1b172544 Ko-fi FAB without claiming Edge XOR shipped", () => {
    const readme = readFileSync("README.md", "utf8");
    const findings = readFileSync("docs/security-findings.md", "utf8");
    const client = readFileSync("docs/capability-client.md", "utf8");
    const backend = readFileSync("docs/capability-backend.md", "utf8");
    const worker = readFileSync("cloudflare-worker/README.md", "utf8");
    const adr = readFileSync(
      "docs/adr/001-home-capability-mint-before-sql-240.md",
      "utf8",
    );
    const aPrime = readFileSync(
      "docs/security/a-prime-cutover-restore.md",
      "utf8",
    );
    const cutover = readFileSync(
      "docs/security/atomic-capability-cutover.md",
      "utf8",
    );
    const runbook = readFileSync(
      "docs/security/bulk-disable-secure-ops.md",
      "utf8",
    );
    const contract = readFileSync(
      "docs/security/sql-240-readiness-contract.md",
      "utf8",
    );
    const preflight = readFileSync(
      "docs/security/sql-240-ops-preflight.md",
      "utf8",
    );
    const rollout = readFileSync(
      "docs/security/immediate-containment-rollout.md",
      "utf8",
    );

    expect(readme).toContain("1b172544");
    expect(readme).toContain("5527f154");
    expect(readme).toContain("1b1725446120ce9dd28bc7fe884c3768e37e435d");
    expect(readme).toContain("1790083696998-uk4r5sxu");
    expect(readme).toContain("2026-09-22T13:28:32.689Z");
    expect(readme).toContain("66a0df1a");
    expect(readme).toContain("1790082984868-xjuz78gh");
    expect(readme).toContain("#153");
    expect(readme).toContain("bottom-4");
    expect(readme).toContain("right-4");
    expect(readme).toContain("Có update mới");
    expect(readme).toContain("MỚI");
    expect(readme).toContain("SW waiting");
    expect(readme).toContain("does not deploy origin");
    expect(readme).toContain("Pixel");
    expect(readme).toContain("READY WITH KNOWN RISKS");

    expect(findings).toContain(
      "## 3l. Production #153 Origin SPA — verified; origin 1b172544; Edge XOR not shipped",
    );
    expect(findings).toContain("1b1725446120ce9dd28bc7fe884c3768e37e435d");
    expect(findings).toContain("1790083696998-uk4r5sxu");
    expect(findings).toContain("5527f154");
    expect(findings).toContain("66a0df1a");
    expect(findings).toContain("Origin is `1b172544`");
    expect(findings).not.toContain("Origin is `44b02cb3`");
    expect(findings).toContain("bottom-4");
    expect(findings).toContain("right-4");
    expect(findings).toContain("Có update mới");
    expect(findings).toContain("MỚI");
    expect(findings).toContain("SW waiting");
    expect(findings).toContain("not a miss-ship");
    expect(findings).toContain("PARKED");
    expect(findings).toContain("invalid_state");
    expect(findings).toContain("NOT VERIFIED");
    expect(findings).toContain("in-repo only");
    expect(findings).toContain("Do **not** claim Edge XOR live PASS");
    expect(findings).toContain("This is not SQL 240, not Realtime, not soak-complete.");

    expect(client).toContain("This Home create path is live on origin `1b172544`");
    expect(client).toContain("bottom-4");
    expect(backend).toContain("Live origin is `1b172544`");
    expect(worker).toContain("Origin SPA hiện là `1b172544`");
    expect(adr).toContain("Live origin `1b172544`");
    expect(aPrime).toContain("Current live origin `1b172544` / Pages `5527f154`");
    expect(cutover).toContain("1b1725446120ce9dd28bc7fe884c3768e37e435d");
    expect(runbook).toContain("1b172544");
    expect(runbook).toContain("5527f154");
    expect(contract).toContain("origin `1b172544` / Pages `5527f154`");
    expect(preflight).toContain("1790083696998-uk4r5sxu");
    expect(preflight).toContain("5527f154");
    expect(rollout).toContain("Origin remains `1b172544`");
  });
});
