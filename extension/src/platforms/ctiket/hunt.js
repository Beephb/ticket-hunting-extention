// src/platforms/ctiket/hunt.js
// Pattern giống hunt_1zone.js: poll API event detail, khi selling_status
// chuyển sang "on_sale" thì direct nav vào /buy/{eid}.
//
// Flow Ctiket (khác 1Zone — không có calendarId riêng, dùng occurrence_id):
//   1) Extract eventId (slug → id) + occurrenceId từ trang
//   2) API Poller: GET /tix/public/events/v2/{slug} mỗi 250ms
//      check selling_status === "on_sale"
//   3) Direct nav: goto /buy/{eid}?ocid={occurrenceId}
//      - Nếu bị redirect sang /buy/{eid}/queue → để runner.js xử lý tiếp
//        (queue_watcher.js sẽ tự chạy enter() khi detect trang queue)
//
// NOTE từ HAR analysis:
//   - Trang event của Ctiket dùng /event/{slug} (KHÔNG có 's'), KHÔNG phải /events/
//   - API public vẫn là /tix/public/events/v2/{slug} hoặc /tix/public/events/v2/{id} — đều work
//   - occurrenceId nằm trong occurrences[0].id của response API

const API_CTIKET_EVENT = "https://cticket.vn/tix/public/events/v2";
const WEB_CTIKET = "https://cticket.vn";

let _huntCtkStop = false;
let _huntCtkPollerStop = false;

// ── Extract info từ trang ─────────────────────────────────────────────────────
// Ctiket dùng /event/{slug} (không có 's') cho trang UI,
// nhưng /tix/public/events/v2/{slug} cho API.

function extractCtiketHuntInfo() {
  const out = { eventId: "", occurrenceId: "", slug: "", buyUrl: "" };

  // 1) Slug từ /event/{slug}  ← pattern thực tế (HAR confirm: /event/sao-concert-tram-2)
  try {
    const m = location.pathname.match(/\/event\/([^/?#]+)/);
    if (m) out.slug = m[1];
  } catch {}

  // 2) Fallback: slug từ /events/{slug} (phòng trường hợp Ctiket đổi routing)
  if (!out.slug) {
    try {
      const m = location.pathname.match(/\/events\/([^/?#]+)/);
      if (m) out.slug = m[1];
    } catch {}
  }

  // 3) Fallback: slug/id từ __NEXT_DATA__ (Next.js server-side props)
  if (!out.slug) {
    try {
      const d = window.__NEXT_DATA__?.props?.pageProps;
      out.slug = d?.event?.slug || d?.eventSlug || d?.slug || "";
    } catch {}
  }

  // 4) Fallback: quét JSON embedded trong HTML
  if (!out.slug) {
    try {
      const html = document.documentElement.innerHTML;
      const m = html.match(/"slug"\s*:\s*"([a-z0-9][a-z0-9-]{3,80})"/)
        || html.match(/"eventSlug"\s*:\s*"([a-z0-9][a-z0-9-]{3,80})"/);
      if (m) out.slug = m[1];
    } catch {}
  }

  // 5) Fallback cuối: nếu đang ở /buy/{eventId} thì dùng eventId làm slug
  //    (API /tix/public/events/v2/{id} accept cả id lẫn slug)
  if (!out.slug) {
    try {
      const m = location.pathname.match(/\/buy\/([a-zA-Z0-9_-]+)/);
      if (m) {
        out.slug = m[1];
        svpLog(`⚠️ [Ctiket] Dùng eventId làm slug fallback: ${out.slug}`, "yellow");
      }
    } catch {}
  }

  // occurrenceId: thử ?ocid= query param trước
  try {
    out.occurrenceId = new URL(location.href).searchParams.get("ocid") || "";
  } catch {}

  // Fallback occurrenceId từ __NEXT_DATA__
  if (!out.occurrenceId) {
    try {
      const d = window.__NEXT_DATA__?.props?.pageProps;
      out.occurrenceId = d?.occurrence?.id || d?.occurrenceId || "";
    } catch {}
  }

  // Fallback occurrenceId từ innerHTML
  if (!out.occurrenceId) {
    try {
      const html = document.documentElement.innerHTML;
      const m = html.match(/occurrence_id["']?\s*[:=]\s*["']([A-Za-z0-9]+)["']/)
        || html.match(/occurrenceId["']?\s*[:=]\s*["']([A-Za-z0-9]+)["']/);
      if (m) out.occurrenceId = m[1];
    } catch {}
  }

  return out;
}

// ── API Poller ────────────────────────────────────────────────────────────────
// Poll bằng slug (endpoint public không cần eventId thật).
// Response cũng chứa occurrences[0].id nếu trang event chưa có ?ocid= sẵn.

async function pollCtiketApi(slug) {
  const apiUrl = `${API_CTIKET_EVENT}/${slug}`;
  svpLog("📡 [Ctiket] API Poller — poll mỗi 250ms", "yellow");

  const rl = window.SVP_RATE_LIMIT?.forHost("cticket.vn");
  if (rl) rl.reset();
  let errors = 0;
  let lastStatus = "";

  while (!_huntCtkPollerStop) {
    if (_huntCtkStop) return null;
    try {
      const res = await fetch(apiUrl, {
        method: "GET",
        credentials: "include",
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(2500),
      });

      if (res.ok) {
        rl?.onSuccess();
        const data = await res.json();
        errors = 0;
        const status = data?.selling_status || "";
        if (status !== lastStatus) {
          svpLog(`ℹ️ [Ctiket] selling_status = ${status}`, "blue");
          lastStatus = status;
        }
        if (status === "on_sale") {
          svpLog("🎯 [Ctiket] Đã mở bán! Chuyển sang direct nav...", "green");
          // Trả về { eventId, occurrenceId } từ API response
          const eventId = data?.id || "";
          // occurrenceId: lấy từ occurrences[0].id nếu có (tránh cần phải detect từ DOM)
          const occurrenceId = data?.occurrences?.[0]?.id || "";
          return { eventId, occurrenceId };
        }
      } else if (res.status === 429 || res.status === 503 || res.status === 502) {
        if (rl) {
          const wait = rl.onError429(res.status);
          if (wait < 0) {
            svpLog("🛑 [Ctiket] Hunt abort — server block IP để tránh ban vĩnh viễn", "red");
            return null;
          }
          await sleep(wait);
        } else {
          await sleep(250 + Math.random() * 400);
        }
        continue;
      }
    } catch (e) {
      errors++;
      if (errors > 20) {
        svpLog("❌ [Ctiket] Poller lỗi liên tục — dừng.", "red");
        return null;
      }
    }
    await sleep(250);
  }
  return null;
}

// ── Direct Navigation ─────────────────────────────────────────────────────────

async function directCtiketNav(eventId, occurrenceId) {
  const buyUrl = occurrenceId
    ? `${WEB_CTIKET}/buy/${eventId}?ocid=${encodeURIComponent(occurrenceId)}`
    : `${WEB_CTIKET}/buy/${eventId}`;

  for (let attempt = 1; attempt <= 3; attempt++) {
    if (_huntCtkStop) return false;

    if (attempt > 1) {
      const wait = (150 + Math.random() * 200) * attempt;
      svpLog(`🔄 [Ctiket] Retry direct nav ${attempt}/3 sau ${Math.round(wait)}ms...`, "yellow");
      await sleep(wait);
    }

    svpLog(`🚀 [Ctiket] Direct nav vào ${buyUrl} (lần ${attempt})...`, "green");
    try {
      location.href = buyUrl;
      await sleep(2000);
      // Không tự xử lý queue ở đây — nếu redirect sang /buy/{eid}/queue,
      // runner.js sẽ detect pageType "queue_ctiket" và queue_watcher.js
      // tự chạy enter() khi grecaptcha sẵn sàng.
      return true;
    } catch (e) {
      svpLog(`⚠️ [Ctiket] Direct nav lỗi: ${e.message}`, "yellow");
    }
  }
  return false;
}

// ── Main hunt Ctiket ──────────────────────────────────────────────────────────

async function huntCtiket(cfg, autoSeat = true) {
  _huntCtkStop = false;
  _huntCtkPollerStop = false;

  svpLog("🎯 [Ctiket] Sniper — kích hoạt...", "yellow");

  const info = extractCtiketHuntInfo();
  let { slug, occurrenceId: ocidFromPage } = info;

  if (!slug) {
    svpLog("⚠️ [Ctiket] Không lấy được slug từ URL — dừng hunt.", "red");
    svpLog("ℹ️ [Ctiket] Cần đứng ở trang: cticket.vn/event/{ten-su-kien}", "blue");
    return;
  }

  svpLog(`🔗 [Ctiket] Slug: ${slug} | occurrenceId từ trang: ${ocidFromPage || "(chưa có, sẽ lấy từ API)"}`, "blue");

  const result = await pollCtiketApi(slug);
  if (_huntCtkStop) return;

  if (!result) {
    svpLog("⚠️ [Ctiket] Poller dừng mà chưa mở bán hoặc lỗi liên tục.", "yellow");
    return;
  }

  _huntCtkPollerStop = true;

  const { eventId, occurrenceId: ocidFromApi } = result;
  // Ưu tiên occurrenceId từ trang (user có thể đã chọn ngày cụ thể),
  // fallback sang occurrenceId từ API (occurrences[0].id)
  const finalOcid = ocidFromPage || ocidFromApi;

  svpLog(`✅ [Ctiket] eventId: ${eventId} | occurrenceId: ${finalOcid || "(không có)"}`, "green");

  // Set flag truoc khi navigate, de queue_watcher (runner.js) biet ma kich hoat:
  //  - autoSeat=true  → hunt_done flag (cho phep ca queue_watcher LAN auto-chon-ghe sau)
  //  - autoSeat=false → chi flag rieng cho queue_watcher (KHONG cho phep auto-chon-ghe,
  //    dung y dinh "chi san ve" — qua duoc queue nhung nguoi tu chon ghe thu cong)
  if (autoSeat) sessionStorage.setItem("__svp_hunt_done__", String(Date.now()));
  else sessionStorage.setItem("__svp_ck_queue_only__", String(Date.now()));

  await directCtiketNav(eventId, finalOcid);
}

function stopHuntCtiket() {
  _huntCtkStop = true;
  _huntCtkPollerStop = true;
  svpLog("🛑 [Ctiket] Đã dừng hunt", "yellow");
}