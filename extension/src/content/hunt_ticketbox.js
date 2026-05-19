// src/content/hunt_ticketbox.js
// Hunt vé Ticketbox — port từ bot_ticketbox.py
// Flow: poll event API → tìm showing mở bán → direct nav vào select-ticket
// Queue-aware: nếu bị queue/waiting room thì chờ tự redirect

const HUNT_API_TB = "https://api-v2.ticketbox.vn";
const HUNT_WEB_TB = "https://ticketbox.vn";

let _huntStopTb = false;

// ── Lấy event ID từ URL Ticketbox ────────────────────────────────────────────

function getTbEventId() {
  // Dạng /slug-25845 hoặc /events/25845/...
  let m = location.href.match(/-(\d{4,})(?:\?|$|\/)/);
  if (m) return m[1];
  m = location.href.match(/\/events\/(\d{4,})(?:\/|\?|$)/);
  return m ? m[1] : "";
}

// ── Lấy date từ trang ────────────────────────────────────────────────────────

function getTbDate() {
  try {
    for (const e of performance.getEntriesByType("resource")) {
      const m = e.name.match(/showings\/\d+\?date=(\d{4}-\d{2}-\d{2})/);
      if (m) return m[1];
    }
  } catch {}
  // Fallback: ngày hôm nay
  return new Date().toISOString().slice(0, 10);
}

// ── Detect queue / page state ────────────────────────────────────────────────

function getTbPageState() {
  const url = location.href.toLowerCase();
  const txt = (document.body?.innerText || "").toLowerCase();

  const isQueue = url.includes("queue") || url.includes("waiting") ||
    txt.includes("hàng chờ") || txt.includes("waiting room") ||
    txt.includes("đang xếp hàng") || txt.includes("vui lòng đợi");
  if (isQueue) return "queue";

  const isCaptcha = (txt.includes("captcha") || txt.includes("xác minh")) &&
    !!document.querySelector("canvas, img[src^='data:image']");
  if (isCaptcha) return "captcha";

  if (txt.includes("thông tin người mua") || txt.includes("họ và tên")) return "form";

  const isSelect = url.includes("select-ticket") || url.includes("/bookings/") ||
    txt.includes("chọn vé") || txt.includes("số lượng") || txt.includes("hạng vé");
  if (isSelect) return "select";

  return "unknown";
}

// ── Chờ thoát queue Ticketbox ────────────────────────────────────────────────

async function waitTbQueueExit(timeoutMs = 180000) {
  svpLog("⏳ Ticketbox đang trong queue — chờ tự redirect...", "yellow");
  const start = Date.now();
  let lastLog = 0;

  while (Date.now() - start < timeoutMs) {
    if (_huntStopTb) return false;
    const state = getTbPageState();
    if (state === "select" || state === "captcha" || state === "form") {
      svpLog(`✅ Đã thoát queue Ticketbox — state=${state}`, "green");
      return true;
    }
    const remaining = Math.round((timeoutMs - (Date.now() - start)) / 1000);
    if (Date.now() - lastLog > 10000) {
      svpLog(`⏳ Vẫn trong queue TB... (còn ~${remaining}s)`, "yellow");
      lastLog = Date.now();
    }
    await sleep(500);
  }
  svpLog("⏰ Queue Ticketbox timeout", "red");
  return false;
}

// ── Showing helpers ───────────────────────────────────────────────────────────

function tbShowingDate(showing) {
  for (const key of ["startTime", "startDate", "date", "showingDate"]) {
    const v = String(showing?.[key] || "");
    const m = v.match(/(20\d{2}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return "";
}

function tbIsShowingOpen(showing) {
  const status = String(showing?.status || "").toLowerCase();
  const statusName = String(showing?.statusName || "").toLowerCase();
  return showing?.isSalable === true || status === "book_now" || statusName.includes("mua vé");
}

function tbFindBestShowing(eventData, preferredDate) {
  try {
    const result = eventData?.data?.result || {};
    const showings = (result.showings || []).filter(s => s?.id && String(s.id) !== "0");
    if (!showings.length) return null;

    const salable = showings.filter(tbIsShowingOpen);
    let pool = salable.length ? salable : showings;

    if (preferredDate) {
      const sameDate = pool.filter(s => tbShowingDate(s) === preferredDate);
      if (sameDate.length) pool = sameDate;
    }

    return pool.sort((a, b) => {
      const aOpen = tbIsShowingOpen(a) ? 1 : 0;
      const bOpen = tbIsShowingOpen(b) ? 1 : 0;
      if (aOpen !== bOpen) return bOpen - aOpen;
      return (parseInt(b.id) || 0) - (parseInt(a.id) || 0);
    })[0];
  } catch {
    return null;
  }
}

// ── Poll Ticketbox event API ─────────────────────────────────────────────────

async function pollTbEventApi(eventId, preferredDate) {
  const url = `${HUNT_API_TB}/gin/api/v2/events/${eventId}`;
  svpLog("📡 Ticketbox API Poller — poll event mỗi 300ms", "blue");

  let lastErrLog = 0;
  let lastWaitLog = 0;

  while (!_huntStopTb) {
    try {
      const res = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(4000),
      });

      if (res.ok) {
        const data = await res.json();
        const showing = tbFindBestShowing(data, preferredDate);

        if (showing) {
          const showingId = String(showing.id);
          const statusName = showing.statusName || showing.status || "";

          if (tbIsShowingOpen(showing)) {
            svpLog(`🎯 Showing mở bán: ${showingId} (${statusName})`, "green");
            return { showingId, showingDate: tbShowingDate(showing) || preferredDate };
          }

          if (Date.now() - lastWaitLog > 3000) {
            svpLog(`⏳ Chưa mở bán: ${showingId} (${statusName})`, "yellow");
            lastWaitLog = Date.now();
          }
        } else if (Date.now() - lastErrLog > 5000) {
          svpLog("⚠️ Event API 200 nhưng chưa có showings", "yellow");
          lastErrLog = Date.now();
        }
      } else if (Date.now() - lastErrLog > 5000) {
        svpLog(`⚠️ Event API HTTP=${res.status}`, "yellow");
        lastErrLog = Date.now();
      }
    } catch (e) {
      if (Date.now() - lastErrLog > 5000) {
        svpLog(`⚠️ Poll error: ${e.message}`, "yellow");
        lastErrLog = Date.now();
      }
    }
    await sleep(300);
  }
  return null;
}

// ── Direct nav vào select-ticket ─────────────────────────────────────────────

async function navTbSelectTicket(eventId, showingId, date) {
  // 1. Pre-fetch showings + seatmap (giống Python: không click button)
  try {
    const showUrl = `${HUNT_API_TB}/event/api/v1/events/showings/${showingId}?date=${date}`;
    svpLog(`🗺️ GET showings/${showingId}?date=${date}`, "blue");
    const r = await fetch(showUrl, { signal: AbortSignal.timeout(6000) });
    svpLog(`📡 Showings API HTTP=${r.status}`, r.ok ? "blue" : "yellow");
  } catch {}

  // 2. Navigate thẳng vào select-ticket
  const target = `${HUNT_WEB_TB}/events/${eventId}/bookings/${showingId}/select-ticket`;
  svpLog(`🚀 Navigate → ${target}`, "green");
  location.href = target;

  await sleep(3000);

  // 3. Xử lý state sau navigate
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (_huntStopTb) return false;
    const state = getTbPageState();

    if (state === "queue") {
      svpLog("⚠️ Bị queue redirect — chờ...", "yellow");
      const ok = await waitTbQueueExit(180000);
      if (!ok) return false;
      continue;
    }
    if (state === "captcha") {
      svpLog("🧩 Đến trang captcha — dừng bot, giải tay", "yellow");
      return true;
    }
    if (state === "select") {
      svpLog("✅ Đã vào trang chọn vé!", "green");
      return true;
    }
    if (state === "form") {
      svpLog("✅ Đã vào trang form", "green");
      return true;
    }
    await sleep(300);
  }
  svpLog("⚠️ Goto xong nhưng không detect được trang", "yellow");
  return true;
}

// ── Main hunt Ticketbox ──────────────────────────────────────────────────────

async function huntTicketbox(cfg) {
  _huntStopTb = false;
  svpLog("🎯 Ticketbox Hunt — Direct Nav, không click button", "blue");

  const eventId = getTbEventId();
  if (!eventId) {
    svpLog("❌ Không lấy được event_id từ URL Ticketbox", "red");
    return false;
  }

  const date = getTbDate();
  svpLog(`🔎 Event ID: ${eventId} | Date: ${date}`, "blue");

  // Poll cho đến khi showing mở bán
  const result = await pollTbEventApi(eventId, date);
  if (!result) return false;

  const { showingId, showingDate } = result;
  svpLog(`🎯 Showing: ${showingId} | Date: ${showingDate}`, "green");

  return await navTbSelectTicket(eventId, showingId, showingDate);
}

function stopHuntTicketbox() {
  _huntStopTb = true;
  svpLog("🛑 Đã dừng hunt Ticketbox", "yellow");
}
