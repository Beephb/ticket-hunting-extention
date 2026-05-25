// src/content/hunt_1zone.js
// Convert từ bot_1zone.py — giữ nguyên toàn bộ logic
//
// Flow:
//   1) Extract event_id + calendarId + booking_url từ trang
//   2) API Poller: fetch mỗi 200ms, khi availableTickets > 0 → direct nav
//   3) Direct nav: goto booking_url
//      - Nếu bị queue → chờ DOM detect thoát queue (tối đa 120s), không reload
//      - Nếu direct nav fail hoàn toàn → fallback JS clicker
//   4) Fallback JS Clicker: MutationObserver + setInterval(150ms) click nút "Mua vé"

const API_1Z_HUNT = "https://prod.1zone.vn/ticketing/api/v4/ticket-summary/get-summary-event";
const WEB_1Z_HUNT = "https://ticket.1zone.vn";

let _hunt1ZStop = false;
let _hunt1ZPollerStop = false;

// ── Extract info từ trang ─────────────────────────────────────────────────────

function extract1ZHuntInfo() {
  const out = { eventId: "", calendarId: "", bookingUrl: "", slug: "" };

  // Slug từ URL
  try {
    const m = location.pathname.match(/\/events\/([^/?#]+)/);
    if (m) out.slug = m[1];
  } catch {}

  // calendarId từ URL trực tiếp
  try {
    out.calendarId = new URL(location.href).searchParams.get("calendarId") || "";
  } catch {}

  // Quét performance resources + __NEXT_DATA__ + innerHTML
  try {
    const d = window.__NEXT_DATA__?.props?.pageProps;
    const candidates = [d?.event?.id, d?.eventId, d?.event?.eventId, d?.event?.calendarId, d?.calendarId, d?.selectedCalendarId];
    for (const x of candidates) {
      const s = String(x || "");
      if (!out.eventId) {
        let m = s.match(/get-summary-event\/([A-Za-z0-9]{4,20})/);
        if (m) out.eventId = m[1];
        m = s.match(/\/event\/([A-Za-z0-9]{4,20})(?:\/|\?|$)/);
        if (m) out.eventId = m[1];
      }
      if (!out.calendarId) {
        const m = s.match(/[?&]calendarId=([A-Za-z0-9]+)/);
        if (m) out.calendarId = m[1];
      }
    }
  } catch {}

  try {
    for (const e of performance.getEntriesByType("resource")) {
      const name = e.name;
      if (!out.eventId) {
        let m = name.match(/get-summary-event\/([A-Za-z0-9]{4,20})/);
        if (m) { out.eventId = m[1]; }
        if (!out.eventId) {
          m = name.match(/\/event\/([A-Za-z0-9]{4,20})(?:\/tickets|\/seatmap|\/)/);
          if (m) out.eventId = m[1];
        }
        if (!out.eventId) {
          m = name.match(/\/ticketing\/api\/v\d+\/event\/([A-Za-z0-9]{4,20})/);
          if (m) out.eventId = m[1];
        }
      }
      if (!out.calendarId) {
        let m = name.match(/[?&]calendarId=([A-Za-z0-9]+)/);
        if (m) out.calendarId = m[1];
        if (!out.calendarId) {
          m = name.match(/\/event\/[A-Za-z0-9]{4,20}\/seatmap\/([A-Za-z0-9]+)/);
          if (m) out.calendarId = m[1];
        }
      }
      if (out.eventId && out.calendarId) break;
    }
  } catch {}

  // Fallback: quét innerHTML
  if (!out.calendarId || !out.eventId) {
    try {
      const html = document.documentElement.innerHTML;
      if (!out.calendarId) {
        const m = html.match(/calendarId["']?\s*[:=]\s*["']([A-Za-z0-9]+)["']/);
        if (m) out.calendarId = m[1];
      }
      if (!out.eventId) {
        const m = html.match(/eventId["']?\s*[:=]\s*["']([A-Za-z0-9]{4,20})["']/);
        if (m) out.eventId = m[1];
      }
    } catch {}
  }

  if (out.slug && out.calendarId) {
    out.bookingUrl = `${WEB_1Z_HUNT}/booking/${out.slug}?calendarId=${out.calendarId}`;
  }

  return out;
}

// ── Queue detection ───────────────────────────────────────────────────────────

function is1ZQueueUrl(url) {
  const u = (url || "").toLowerCase();
  return u.includes("queue") || u.includes("waiting") || u.includes("queue-it");
}

function is1ZBookingReadyDom() {
  try {
    const body = document.body;
    if (!body) return false;
    const url = location.href.toLowerCase();
    const text = (body.innerText || "").toLowerCase();

    // 1) seats.io thật
    if (
      document.querySelector("#seatio iframe") ||
      document.querySelector("#seatio") ||
      document.querySelector("iframe[src*='seatsio' i]") ||
      document.querySelector("iframe[src*='seats.io' i]") ||
      document.querySelector("iframe[src*='cdn-oc.seatsio.net' i]")
    ) return true;

    // 2) Strong zone signals
    if (
      document.querySelector("[data-id*='ticket-class' i]") ||
      document.querySelector("[data-id*='zone-id' i]") ||
      document.querySelector("[data-zone-id]") ||
      document.querySelector("[data-ticket-class-id]") ||
      document.querySelector("button[data-id*='plus' i]") ||
      document.querySelector("button[data-id*='minus' i]") ||
      document.querySelector("button[aria-label*='increase' i]") ||
      document.querySelector("button[aria-label*='decrease' i]") ||
      document.querySelector("input[type='number']")
    ) return true;

    // 3) Zone text signals
    const hasQueueUrl = url.includes("queue") || url.includes("waiting") || url.includes("queue-it");
    const hasQueueDom = !!(
      document.querySelector("[id*='queue' i]") ||
      document.querySelector("[class*='queue' i]") ||
      document.querySelector("iframe[src*='queue' i]") ||
      document.querySelector("iframe[src*='waiting' i]")
    );
    const hasQueueText = text.includes("queue") || text.includes("hàng chờ") || text.includes("waiting room");

    const zoneKeywords = ["chọn vé", "chọn ghế", "số lượng", "hạng vé", "khu vực", "zone"];
    let hit = 0;
    for (const k of zoneKeywords) { if (text.includes(k)) hit++; }

    if (hasQueueUrl || hasQueueDom || hasQueueText) {
      return hit >= 3 && !text.includes("waiting room");
    }
    return hit >= 2;
  } catch { return false; }
}

// ── Chờ thoát queue ───────────────────────────────────────────────────────────

async function wait1ZQueueExit(timeoutMs = 120000) {
  svpLog("⏳ Đang trong hàng chờ (queue) — chờ đến lượt...", "yellow");
  if (typeof showIndicator === "function")
    showIndicator("🟡 Trong hàng chờ...", "Chờ đến lượt tự động", "#facc15");
  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;

  while (Date.now() < deadline) {
    if (_hunt1ZStop) {
      svpLog("🛑 Đã dừng săn vé — thoát vòng chờ queue.", "yellow");
      return false;
    }

    const currUrl = location.href.toLowerCase();

    // Ưu tiên check DOM trước URL
    if (is1ZBookingReadyDom()) {
      svpLog("✅ Thoát queue — trang bán vé đã render.", "green");
      return true;
    }

    if (currUrl.includes("/booking/") && !is1ZQueueUrl(currUrl)) {
      svpLog("✅ Thoát queue — đã vào booking page!", "green");
      return true;
    }

    if (Date.now() - lastLog > 10000) {
      svpLog(`⏳ Vẫn trong queue... (${Math.round((deadline - Date.now()) / 1000)}s còn lại)`, "yellow");
      lastLog = Date.now();
    }
    await sleep(500);
  }

  svpLog("⏰ Queue timeout — chuyển fallback clicker.", "red");
  return false;
}

// ── Wait booking settled ──────────────────────────────────────────────────────

async function wait1ZBookingSettled(timeoutMs = 9000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (_hunt1ZStop) return false;
    const url = location.href.toLowerCase();
    if (is1ZQueueUrl(url)) return false;
    if (is1ZBookingReadyDom()) {
      svpLog("✅ Booking đã sẵn sàng (seatmap/zone flow).", "green");
      return true;
    }
    await sleep(200);
  }
  svpLog("⚠️ Vào booking nhưng chưa detect được seatmap/zone flow.", "yellow");
  return false;
}

// ── Fallback JS Clicker ───────────────────────────────────────────────────────

function inject1ZClicker() {
  // Inject vào page context thật qua runInPage
  runInPage(function() {
    window._1zStop = true;
    window._1zBot = false;
    if (window._1zObs) { window._1zObs.disconnect(); delete window._1zObs; }
    if (window._1zInterval) { clearInterval(window._1zInterval); delete window._1zInterval; }

    window._1zStop = false;
    window._1zBot = true;

    let busy = false;
    const findBtn = () =>
      document.querySelector('[data-id="btn-by-ticket"]') ||
      Array.from(document.querySelectorAll("button"))
        .find(b => b.innerText.trim().includes("Mua vé") && !b.disabled);

    const doClick = () => {
      if (window._1zStop || busy) return;
      const btn = findBtn();
      if (!btn) return;
      busy = true;
      btn.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, view: window }));
      setTimeout(() => { busy = false; }, 700);
    };

    window._1zObs = new MutationObserver(() => {
      if (!window._1zStop) doClick();
    });
    window._1zObs.observe(document.body, { childList: true, subtree: true, attributes: true });
    window._1zInterval = setInterval(() => {
      if (window._1zStop) { clearInterval(window._1zInterval); return; }
      doClick();
    }, 150);
    doClick();
  }, {});
}

function stop1ZClicker() {
  try {
    runInPage(function() {
      window._1zStop = true;
      window._1zBot = false;
      if (window._1zObs) window._1zObs.disconnect();
      if (window._1zInterval) clearInterval(window._1zInterval);
    }, {});
  } catch {}
}

// ── Direct Navigation ─────────────────────────────────────────────────────────

async function direct1ZNav(bookingUrl) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    if (_hunt1ZStop) return false;

    if (attempt > 1) {
      const wait = (150 + Math.random() * 200) * attempt;
      svpLog(`🔄 Retry direct nav ${attempt}/3 sau ${Math.round(wait)}ms...`, "yellow");
      await sleep(wait);
    }

    svpLog(`🚀 Direct nav vào booking (lần ${attempt})...`, "green");

    try {
      location.href = bookingUrl;
      // Chờ navigation hoàn tất
      await sleep(3000);

      const curr = location.href.toLowerCase();

      if (is1ZQueueUrl(curr)) {
        svpLog("⚠️ Bị queue redirect. Chờ đến lượt...", "yellow");
        const ok = await wait1ZQueueExit(120000);
        if (ok) {
          await wait1ZBookingSettled(9000);
          return true;
        }
        if (_hunt1ZStop) return false;
        return false;
      }

      if (curr.includes("/booking/")) {
        svpLog("✅ Vào booking page thành công.", "green");
        await wait1ZBookingSettled(9000);
        return true;
      }

      svpLog(`⚠️ Direct nav redirect tới: ${location.href}`, "yellow");
      return false;

    } catch(e) {
      svpLog(`⚠️ Direct nav lỗi: ${e.message}`, "yellow");
    }
  }
  return false;
}

// ── API Poller ────────────────────────────────────────────────────────────────

async function poll1ZApi(eventId, calendarId) {
  const apiUrl = `${API_1Z_HUNT}/${eventId}?type=group&calendarId=${encodeURIComponent(calendarId)}`;
  svpLog("📡 API Poller — poll mỗi 200ms", "yellow");

  let errors = 0;

  while (!_hunt1ZPollerStop) {
    try {
      const res = await fetch(apiUrl, {
        method: "GET",
        credentials: "include",
        headers: {
          "Accept": "application/json",
          "Accept-Language": "vi",
          "x-accept-language": "vi",
          "Origin": WEB_1Z_HUNT,
          "Referer": WEB_1Z_HUNT + "/",
        },
        signal: AbortSignal.timeout(2000),
      });

      if (res.ok) {
        const data = await res.json();
        errors = 0;
        const total = (data?.data || []).reduce((s, i) => s + (parseInt(i?.availableTickets || 0)), 0);
        if (total > 0) {
          svpLog(`🎯 ${total} vé available! Chuyển sang direct nav...`, "green");
          return true;
        }
      } else if (res.status === 429 || res.status === 503 || res.status === 502) {
        await sleep(200 + Math.random() * 400);
        continue;
      }
    } catch(e) {
      errors++;
      if (errors > 20) {
        svpLog("❌ Poller lỗi liên tục — dừng, chuyển fallback clicker.", "red");
        return false;
      }
    }
    await sleep(200);
  }
  return false;
}

// ── Main hunt 1Zone ───────────────────────────────────────────────────────────

async function hunt1Zone(cfg) {
  _hunt1ZStop = false;
  _hunt1ZPollerStop = false;

  svpLog("🎯 1Zone Sniper — kích hoạt...", "yellow");

  // Dừng clicker cũ nếu còn
  stop1ZClicker();

  const info = extract1ZHuntInfo();
  const { eventId, calendarId, bookingUrl, slug } = info;

  svpLog(`🔗 Booking URL: ${bookingUrl || "(chưa có)"}`, "blue");

  if (!bookingUrl) {
    svpLog("⚠️ Không lấy được booking URL — bật fallback clicker.", "yellow");
    inject1ZClicker();
    return;
  }

  if (!eventId || !calendarId) {
    svpLog("⚠️ Thiếu eventId/calendarId — bật fallback clicker.", "yellow");
    inject1ZClicker();
    return;
  }

  // Poll API
  const hasTickets = await poll1ZApi(eventId, calendarId);
  if (_hunt1ZStop) return;

  if (!hasTickets) {
    // Poller lỗi liên tục → fallback clicker
    if (!_hunt1ZStop) {
      svpLog("🧩 Poller dừng — bật JS clicker fallback.", "yellow");
      try {
        if (!location.href.toLowerCase().includes("/events/") && !location.href.toLowerCase().includes("/booking/")) {
          location.reload();
          await sleep(2000);
        }
        inject1ZClicker();
      } catch {}
    }
    return;
  }

  _hunt1ZPollerStop = true;

  // Direct nav
  const ok = await direct1ZNav(bookingUrl);

  if (!ok && !_hunt1ZStop) {
    // Direct nav thất bại hoàn toàn → fallback clicker
    svpLog("🧩 Direct nav fail — bật JS clicker fallback.", "yellow");
    try {
      const curr = location.href.toLowerCase();
      if (!curr.includes("/events/") && !curr.includes("/booking/")) {
        location.reload();
        await sleep(2000);
      }
      inject1ZClicker();
    } catch {}
  }
}

function stopHunt1Zone() {
  _hunt1ZStop = true;
  _hunt1ZPollerStop = true;
  stop1ZClicker();
  svpLog("🛑 Đã dừng hunt 1Zone", "yellow");
}
