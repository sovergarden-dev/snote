# Cloudflare Worker — crawler containment

Worker này đang chạy ở chế độ containment tạm thời cho tới khi capability
backend/client được cutover. Slug cũ vẫn là edit credential, vì vậy crawler
không được nhận nội dung, slug, token hay canonical URL của một note.

Source Worker trong thư mục này khớp với Worker production `syrin-prerender`
đang chạy: git SHA `931430c0`, Cloudflare Version ID
`5f94ab6c-fde5-4416-a3aa-74daaa2e6094` (PR #89, 2026-09-03).
Committed `wrangler.toml` khớp production ở observability/logs
(`enabled = true`, `invocation_logs = true`); traces và `workers_dev` vẫn tắt.
Origin SPA hiện là `4e23fe22` (xem §3e / §3k / §3l / §3m / §3n / §3o / §3p / §3q); bulk Legacy OFF
(`capability_note_bulk_disable_secure`, historical Go C HOLD at #144 on
`0cdcdc0f`) không đổi origin at apply time; Go C #145 later shipped on `9a80930a`;
re-bulk OFF ALL 6 (2026-09-22) không đổi origin (vẫn `9a80930a` at that attest);
Go SQL allowlist `p_slugs` (2026-09-22, tip `46ddaf01`) không đổi origin
(vẫn `9a80930a`);
Go Ops allowlist bulk OFF 2→0 (2026-09-22; `aggadagdade`, `pbhcusvb`) không đổi origin
(vẫn `9a80930a`);
#151 Origin SPA later shipped on `44b02cb3` / Pages `b44849c4` (Edge XOR not shipped);
#153 Origin SPA later shipped on `1b172544` / Pages `5527f154`;
#155 Origin SPA later shipped on `3b4ea9f9` / Pages `62f641c7`;
#157 Origin SPA later shipped on `610662a9` / Pages `33667a6a`;
#159 Origin SPA later shipped on `08c25172` / Pages `1db84523`;
#161 Origin SPA later shipped on `a6756188` / Pages `cf94d1b2`;
#163 Origin SPA later shipped on `4e23fe22` / Pages `b53b133a`;
Worker identity HOLD; không được coi origin là `931430c0`.
Observability và invocation logs đã live trên production, không chỉ committed.
Việc ghi nhận identity này không cho phép một deployment mới.
Xem `docs/security-findings.md` §1c.

## Routing production bắt buộc

Canonical origin là `https://note.syrin.online`. Worker phải phủ cả ba host:

- `note.syrin.online/*`
- `syrin.online/*`
- `www.syrin.online/*`

Origin Pages đã được review là `snote-g4-origin.pages.dev`;
`snote.lovable.app` không phải origin hoặc rollback target. Không được cho alias
nào đi vòng qua Worker.

## Hành vi

- Browser bình thường: pass-through tới `ORIGIN_HOST`. Runtime/immutable
  asset chỉ forward query `__WB_REVISION__` hợp lệ; locator, token, home,
  public, note và share query vẫn bị strip.
- Crawler ở `/s/*`: generic HTML, `no-store`,
  `noindex,nofollow,noarchive,nosnippet`; không metadata/cache/redirect.
- Crawler ở `/<legacy-note-locator>`: generic HTML với cùng giới hạn; không
  đọc cache cũ và không gọi `note-meta`. Điều này chặn plaintext preview còn
  sống sau khi note được mã hóa.
- Crawler ở trang chủ: metadata tĩnh của sản phẩm; có thể cache ngắn hạn.
- Logs tùy chỉnh chỉ chứa loại route/bot/status/timing. Không log path, locator,
  token, nội dung hoặc IP thô.
- `invocation_logs = true` đang live trên production Worker. Invocation logs
  có thể chứa raw URL trước khi mã Worker chạy; đó là rủi ro đã chấp nhận.
- Traces, `workers.dev` và preview URLs vẫn tắt. Observability và invocation
  logs đã khớp giữa file committed và Worker live.
- Các secret binding hiện do provider quản lý không được lưu trong repository.

## Triển khai

Dùng duy nhất `cloudflare-worker/wrangler.toml` đã commit:

```toml
name = "syrin-prerender"
main = "worker.js"
compatibility_date = "2024-11-01"
workers_dev = false
preview_urls = false

routes = [
  { pattern = "note.syrin.online/*", zone_name = "syrin.online" },
  { pattern = "syrin.online/*", zone_name = "syrin.online" },
  { pattern = "www.syrin.online/*", zone_name = "syrin.online" },
]

[vars]
ORIGIN_HOST = "snote-g4-origin.pages.dev"
SITE_URL = "https://note.syrin.online"

[observability]
enabled = true

[observability.logs]
enabled = true
invocation_logs = true

[observability.traces]
enabled = false
```

Một deployment mới phải có checkpoint phê duyệt riêng. Trước bất kỳ deployment
nào đã được phê duyệt, phải kiểm kê Workers Logs, Tail Workers, Workers Logpush,
traces và zone-level HTTP request datasets. Giữ traces disabled; không tiếp
tục nếu pipeline nào còn giữ raw note/share path ngoài invocation logs đã
được phê duyệt trong wrangler.toml.

## Thứ tự rollout

1. Tạo và xác minh backup/PITR checkpoint.
2. Deploy Worker mới trong staging.
3. Chứng minh crawler note/share nhận generic `no-store` trên mọi hostname,
   kể cả encoded separator, mixed case, trailing slash và asset-looking token.
4. Purge toàn bộ cache HTML preview note/share cũ và mọi cache của
   `note-meta`, không chỉ `note-meta?token=*`.
5. Chờ qua verified maximum expiry nếu không thể wildcard purge.
6. Chỉ sau đó mới tombstone `note-meta` và kiểm tra endpoint trả generic
   `410 no-store`.
7. Lặp lại test trên production trong checkpoint review riêng.

## Kiểm tra tối thiểu

```bash
curl -A "Slackbot-LinkExpanding 1.0" https://note.syrin.online/private-note -i
curl -A "Slackbot-LinkExpanding 1.0" https://note.syrin.online/s/<token> -i
curl -A "meta-externalagent/1.1" https://syrin.online/private-note -i
curl -A "Mozilla/5.0" https://note.syrin.online/private-note -I
```

Ba request crawler phải không chứa locator/token trong body hoặc headers, phải
có `Cache-Control: no-store` và `X-Robots-Tag:
noindex,nofollow,noarchive,nosnippet`. Request browser vẫn pass-through.

## Rollback

Rollback vẫn phải giữ generic containment cho cả note locator và `/s/*`.
Không bật lại content-bearing prerender/cache hoặc legacy `note-meta`. Nếu
Worker không thể phục vụ containment, vô hiệu hóa public aliases thay vì
pass-through private paths.
