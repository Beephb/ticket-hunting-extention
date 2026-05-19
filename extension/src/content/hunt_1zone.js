// src/content/hunt_1zone.js
// Hunt vé 1Zone — port từ bot_1zone.py
// Flow: poll API ticket-summary → khi có vé → navigate thẳng vào /booking/{slug}?calendarId=...
// Queue-aware: nếu bị queue thì chờ tự redirect, không reload/click lại

const HUNT_API_1ZONE = "https://prod.1zone.vn/ticketing/api/v4/ticket-summary/get-summary-event";
const HUNT_WEB_1ZONE = "https://ticket.1zone.vn";

let _huntStop1Zone = false;

// ── Lấy slug từ URL hiện tại ─────────────────────────────────────────────────

function get1ZoneSlug() {
  const m = location.pathname.match(/\/events\/([^/?#]+)/);
  return m ? m[1] : "";
}

// ── Detect queue page ─────────────────────────────────────────────────────────

function is1ZoneQueuePage() {
  const url = location.href.toLowerCase();
  const txt = (document.body?.innerText || "").toLowerCase();
  return url.includes("queue") || url.includes("waiting") ||
    txt.includes("hàng chờ") || txt.includes("waiting room") ||
    !!document.querySelector("iframe[src*='queue'], [id*='queue']");
}

// ── Detect booking page đã sẵn sàng ─────────────────────────────────────────

async function is1ZoneBookingReady() {
  const url = location.href.toLowerCase();
  if (is1ZoneQueuePage()) return false;
  if (document.querySelector("#seatio iframe, iframe[src*='seatsio'], iframe[src*='seats.io']")) return true;
  if (document.querySelector('[data-id*="zone"], [data-zone-id], button[data-id="btn-add"]')) return true;
  // Konva check qua background executeScript
  try {
    const r = await runInPage(function() {
      const stage = window.Konva?.stages?.[0];
      if (!stage) return false;
      return Array.from(stage.find ? stage.find("Path") : []).length > 0;
    });
    if (r) return true;
  } catch {}
  return url.includes("/booking/") && !is1ZoneQueuePage();
}

// ── Chờ thoát queue ──────────────────────────────────────────────────────────

async function wait1ZoneQueueExit(timeoutMs = 120000) {
  svpLog("⏳ Đang trong queue 1Zone — chờ đến lượt...", "yellow");
  const start = Date.now();
  let lastLog = 0;

  while (Date.now() - start < timeoutMs) {
    if (_huntStop1Zone) return false;
    if (await is1ZoneBookingReady()) {
      svpLog("✅ Thoát queue — trang booking đã ready!", "green");
      return true;
    }
    if (!is1ZoneQueuePage() && location.href.toLowerCase().includes("/booking/")) {
      svpLog("✅ Thoát queue — URL /booking/ detected", "green");
      return true;
    }
    const remaining = Math.round((timeoutMs - (Date.now() - start)) / 1000);
    if (Date.now() - lastLog > 10000) {
      svpLog(`⏳ Vẫn trong queue... (còn ~${remaining}s)`, "yellow");
      lastLog = Date.now();
    }
    await sleep(500);
  }

  svpLog("⏰ Queue timeout — dừng", "red");
  return false;
}

// ── Poll API ticket-summary ──────────────────────────────────────────────────

async function poll1ZoneApi(eventId, calendarId) {
  const url = `${HUNT_API_1ZONE}/${eventId}?type=group&calendarId=${encodeURIComponent(calendarId)}`;
  svpLog("📡 1Zone API Poller — poll mỗi 200ms", "blue");

  let errors = 0;
  while (!_huntStop1Zone) {
    try {
      const res = await fetch(url, {
        credentials: "include",
        headers: { "Accept": "application/json", "x-accept-language": "vi" },
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = await res.json();
        errors = 0;
        const items = data?.data || [];
        const total = items.reduce((s, i) => s + (parseInt(i?.availableTickets) || 0), 0);
        if (total > 0) {
          svpLog(`🎯 ${total} vé available! Navigate vào booking...`, "green");
          return true;
        }
      }
    } catch (e) {
      errors++;
      if (errors > 20) {
        svpLog("❌ Poller lỗi liên tục — dừng", "red");
        return false;
      }
    }
    await sleep(200);
  }
  return false;
}

// ── Navigate vào booking ─────────────────────────────────────────────────────

async function nav1ZoneBooking(slug, calendarId) {
  const target = `${HUNT_WEB_1ZONE}/booking/${slug}?calendarId=${calendarId}`;
  svpLog(`🚀 Navigate → ${target}`, "green");
  location.href = target;

  // Chờ trang load sau navigate
  await sleep(3000);

  // Nếu bị queue
  if (is1ZoneQueuePage()) {
    svpLog("⚠️ Bị queue redirect — chờ tự thoát...", "yellow");
    return await wait1ZoneQueueExit(120000);
  }
  return true;
}

// ── Main hunt 1Zone ──────────────────────────────────────────────────────────

async function hunt1Zone(cfg) {
  _huntStop1Zone = false;
  svpLog("🎯 1Zone Hunt — bắt đầu...", "blue");

  // Lấy info từ trang hiện tại
  const info = extract1ZoneInfo();
  svpLog(`🔎 slug=${info.slug} | eventId=${info.eventId} | calendarId=${info.calendarId}`, "blue");

  if (!info.eventId || !info.calendarId) {
    svpLog("❌ Không lấy được eventId/calendarId — hãy vào trang event 1Zone trước", "red");
    return false;
  }

  if (!info.slug) {
    // Lấy slug từ URL hiện tại (event page)
    const m = location.pathname.match(/\/events\/([^/?#]+)/);
    info.slug = m ? m[1] : "";
  }

  if (!info.slug) {
    svpLog("❌ Không lấy được slug event", "red");
    return false;
  }

  svpLog(`🔗 Booking URL: ${HUNT_WEB_1ZONE}/booking/${info.slug}?calendarId=${info.calendarId}`, "blue");

  // Poll API cho đến khi có vé
  const hasTickets = await poll1ZoneApi(info.eventId, info.calendarId);
  if (!hasTickets) return false;

  // Navigate vào booking
  return await nav1ZoneBooking(info.slug, info.calendarId);
}

function stopHunt1Zone() {
  _huntStop1Zone = true;
  svpLog("🛑 Đã dừng hunt 1Zone", "yellow");
}
