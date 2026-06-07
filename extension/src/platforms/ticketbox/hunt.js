// src/content/hunt_ticketbox.js
// Convert từ bot_ticketbox.py — giữ nguyên toàn bộ logic
//
// Flow:
//   1) Extract event_id từ URL
//   2) Extract preferred date từ performance resource + body text
//   3) API Poller: fetch event API mỗi 300ms, tìm showing mở bán tốt nhất
//   4) Khi showing mở bán:
//      - GET showings/{showing_id}?date={date}
//      - GET showings/{showing_id}/seatmap (fail không sao)
//      - Direct nav tới /events/{event_id}/bookings/{showing_id}/select-ticket
//   5) Detect state: queue | captcha | select | form | unknown
//      - queue → chờ tự redirect tối đa 180s
//      - captcha → dừng bot, để user giải tay
//      - select/form → xong

const API_TB_HUNT = "https://api-v2.ticketbox.vn";
const WEB_TB_HUNT = "https://ticketbox.vn";

let _huntStopTb = false;
let _huntPollerStopTb = false;

// ── Extract event_id ──────────────────────────────────────────────────────────

function extractTbHuntEventId() {
  try {
    const url = location.href;
    // dạng /slug-25845?... hoặc -25845
    let m = url.match(/-(\d{4,})(?:\?|$|\/)/);
    if (m) return m[1];
    // dạng /events/25845/...
    m = url.match(/\/events\/(\d{4,})(?:\/|\?|$)/);
    if (m) return m[1];
  } catch {}
  return "";
}

// ── Extract date từ trang ─────────────────────────────────────────────────────

function extractTbHuntDate() {
  try {
    for (const e of performance.getEntriesByType("resource")) {
      const m = e.name.match(/showings\/\d+\?date=(\d{4}-\d{2}-\d{2})/);
      if (m) return m[1];
    }
  } catch {}
  try {
    const txt = document.body.innerText || "";
    const m = txt.match(/(20\d{2}-\d{2}-\d{2})/);
    if (m) return m[1];
  } catch {}
  return new Date().toISOString().slice(0, 10);
}

// ── Showing helpers ───────────────────────────────────────────────────────────

function tbHuntShowingDate(showing) {
  for (const key of ["startTime", "startDate", "date", "showingDate"]) {
    const v = String((showing || {})[key] || "");
    const m = v.match(/(20\d{2}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return "";
}

function isTbHuntShowingOpen(showing) {
  try {
    const status = String(showing?.status || "").toLowerCase();
    const statusName = String(showing?.statusName || "").toLowerCase();
    return showing?.isSalable === true || status === "book_now" || statusName.includes("mua vé");
  } catch { return false; }
}

function findBestTbShowing(eventJson, preferredDate) {
  try {
    const result = eventJson?.data?.result || {};
    // ⚠️ FIX: loại showingId = 0 (chưa mở bán, placeholder)
    // Dùng kiểm tra explicit thay vì || "" để tránh falsy trap
    const showings = (result.showings || []).filter(s => {
      const id = s?.id;
      if (id === null || id === undefined) return false;
      if (String(id) === "0") return false; // placeholder chưa mở bán
      return true;
    });
    if (!showings.length) return null;

    const salable = showings.filter(isTbHuntShowingOpen);
    let pool = salable.length ? salable : showings;

    if (preferredDate) {
      const sameDate = pool.filter(s => tbHuntShowingDate(s) === preferredDate);
      if (sameDate.length) pool = sameDate;
    }

    return pool.sort((a, b) => {
      const aOpen = isTbHuntShowingOpen(a) ? 1 : 0;
      const bOpen = isTbHuntShowingOpen(b) ? 1 : 0;
      if (aOpen !== bOpen) return bOpen - aOpen;
      const aDate = tbHuntShowingDate(a);
      const bDate = tbHuntShowingDate(b);
      if (aDate !== bDate) return bDate.localeCompare(aDate);
      return (parseInt(b.id) || 0) - (parseInt(a.id) || 0);
    })[0];
  } catch { return null; }
}

// ── Queue detection ───────────────────────────────────────────────────────────

function isTbHuntQueueUrl(url) {
  const u = (url || "").toLowerCase();
  return ["queue", "waiting", "waiting-room", "line", "queue-it", "queue.ticketbox", "waitingroom"].some(k => u.includes(k));
}

function detectTbPageState() {
  try {
    const url = location.href.toLowerCase();
    if (isTbHuntQueueUrl(url)) return "queue";

    const txt = (document.body?.innerText || "").toLowerCase();
    const href = location.href.toLowerCase();

    const hasQueue = href.includes("queue") || href.includes("waiting") ||
      txt.includes("hàng chờ") || txt.includes("hang cho") ||
      txt.includes("waiting room") || txt.includes("queue") ||
      txt.includes("đang xếp hàng") || txt.includes("vui lòng đợi");

    const hasCaptchaText = txt.includes("captcha") || txt.includes("xác minh") || txt.includes("trượt") || txt.includes("slide");
    const hasCaptchaImg = !!(document.querySelector("img[src^='data:image'], canvas"));

    const hasForm = txt.includes("thông tin người mua") || txt.includes("họ và tên") ||
      txt.includes("số điện thoại") || txt.includes("email");

    const hasSelect = href.includes("select-ticket") || href.includes("/bookings/") ||
      txt.includes("chọn vé") || txt.includes("select ticket") ||
      txt.includes("số lượng") || txt.includes("hạng vé") || txt.includes("khu vực");

    if (hasQueue) return "queue";
    if (hasCaptchaText && hasCaptchaImg) return "captcha";
    if (hasForm) return "form";
    if (hasSelect) return "select";
    return "unknown";
  } catch { return "unknown"; }
}

// ── Chờ thoát queue Ticketbox ─────────────────────────────────────────────────
//
// Ưu tiên dùng __SVP_TB_QUEUE__.waitForBookingTurn() — poll API trực tiếp.
// Fallback sang DOM-watch nếu module chưa load.

async function waitTbQueueExit(showingId, captchaToken, timeoutMs = 900000) {
  // Thử dùng queue watcher API-based (chính xác hơn, biết position)
  const queueModule = window.__SVP_TB_QUEUE__;
  if (queueModule && captchaToken && showingId) {
    svpLog("⏳ Dùng Queue Watcher API (poll /queue/v1/showing/status)...", "yellow");
    const result = await queueModule.waitForBookingTurn(showingId, captchaToken, {
      timeoutMs,
      onPosition: pos => {
        // Position cập nhật → svpLog đã log trong module rồi
      },
    });
    if (result.ok) {
      svpLog(`✅ Queue → BOOKING! expireIn=${result.expireIn}s`, "green");
      return true;
    }
    if (result.reason === "stopped") return false;
    svpLog(`⚠️ Queue watcher kết thúc: ${result.reason}`, "yellow");
    return false;
  }

  // Fallback: DOM watch (cũ) — khi không có captcha token hoặc module chưa load
  svpLog("⏳ Fallback DOM-watch queue (chờ tự redirect)...", "yellow");
  if (typeof showIndicator === "function")
    showIndicator("🟡 Trong hàng chờ...", "Chờ Ticketbox redirect tự động", "#facc15");

  const deadline = Date.now() + timeoutMs;
  let lastLog = 0;

  while (Date.now() < deadline) {
    if (_huntStopTb) {
      svpLog("🛑 Đã dừng khi đang chờ queue.", "red");
      return false;
    }

    const state = detectTbPageState();
    if (["captcha", "select", "form"].includes(state)) {
      svpLog("✅ Đã thoát queue Ticketbox (DOM detect).", "green");
      return true;
    }

    if (Date.now() - lastLog > 10000) {
      svpLog(`⏳ Vẫn trong queue... (${Math.round((deadline - Date.now()) / 1000)}s còn lại)`, "yellow");
      lastLog = Date.now();
    }
    await sleep(500);
  }

  svpLog("⏰ Queue timeout — dừng để kiểm tra tay.", "red");
  return false;
}

// ── Direct showings + nav ─────────────────────────────────────────────────────

async function directTbShowingsAndNav(eventId, showingId, date) {
  const showingsUrl = `${API_TB_HUNT}/event/api/v1/events/showings/${showingId}?date=${date}`;
  const seatmapUrl = `${API_TB_HUNT}/event/api/v1/events/showings/${showingId}/seatmap`;
  const targetUrl = `${WEB_TB_HUNT}/events/${eventId}/bookings/${showingId}/select-ticket`;

  // Lấy captcha token (nếu có) để truyền vào queue watcher
  const tokenMgr = window.__SVP_TB_TOKEN__;
  const captchaToken = tokenMgr?.getCaptchaToken?.(showingId) || null;

  svpLog(`🚀 GET trực tiếp showings/${showingId}?date=${date}`, "green");
  try {
    const res = await fetch(showingsUrl, {
      credentials: "include",
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    svpLog(`📡 Showings API HTTP=${res.status}`, res.ok ? "blue" : "yellow");
    if (!res.ok) {
      svpLog(`⚠️ Showings fail HTTP=${res.status}`, "yellow");
      return false;
    }
  } catch(e) {
    svpLog(`⚠️ Showings fetch lỗi: ${e.message}`, "yellow");
    return false;
  }

  // Seatmap — fail không chặn nav
  svpLog(`🗺️ GET seatmap/${showingId}`, "blue");
  try {
    const res = await fetch(seatmapUrl, {
      credentials: "include",
      headers: { "Accept": "application/json" },
      signal: AbortSignal.timeout(6000),
    });
    svpLog(`📡 Seatmap API HTTP=${res.status}`, res.ok ? "blue" : "yellow");
  } catch {}

  svpLog(`🚀 Direct nav select-ticket: ${targetUrl}`, "green");
  location.href = targetUrl;
  await sleep(3000);

  // Detect state sau navigate
  const deadline = Date.now() + 15000;
  let lastState = "unknown";

  while (Date.now() < deadline) {
    if (_huntStopTb) {
      svpLog("🛑 Đã dừng khi đang xử lý Ticketbox.", "red");
      return false;
    }

    const state = detectTbPageState();
    lastState = state;

    if (state === "queue") {
      const ok = await waitTbQueueExit(showingId, captchaToken, 900000);
      if (!ok) return false;
      // Sau khi thoát queue, loop tiếp để nhận captcha/select/form
      const newDeadline = Date.now() + 15000;
      while (Date.now() < newDeadline) {
        if (_huntStopTb) return false;
        const s2 = detectTbPageState();
        if (s2 === "captcha") { svpLog("🧩 Đã tới captcha — dừng bot, giải tay.", "yellow"); return true; }
        if (s2 === "select") { svpLog("✅ Đã tới trang chọn vé/chọn ghế.", "green"); return true; }
        if (s2 === "form") { svpLog("✅ Đã tới form.", "green"); return true; }
        await sleep(300);
      }
      break;
    }

    if (state === "captcha") {
      svpLog("🧩 Đã tới captcha — dừng bot, giải tay.", "yellow");
      if (typeof showIndicator === "function")
        showIndicator("🟠 Captcha! Cần giải tay", "Bot đã dừng, bạn tự giải captcha", "#f97316");
      return true;
    }
    if (state === "select") {
      svpLog("✅ Đã tới trang chọn vé/chọn ghế — dừng bot.", "green");
      if (typeof showIndicator === "function")
        showIndicator("🟡 Đang chọn ghế...", "Đã vào trang booking", "#facc15");
      return true;
    }
    if (state === "form") {
      svpLog("✅ Đã tới form — có thể điền thông tin.", "green");
      if (typeof showIndicator === "function")
        showIndicator("🟢 Đã vào checkout!", "Đang điền form...", "#22c55e");
      return true;
    }
    await sleep(300);
  }

  svpLog(`⚠️ Goto xong nhưng chưa xác định được màn hình (${lastState}).`, "yellow");
  return true;
}

// ── API Poller ────────────────────────────────────────────────────────────────

async function pollTbEventApi(eventId, preferredDate) {
  const eventUrl = `${API_TB_HUNT}/gin/api/v2/events/${eventId}`;
  svpLog("📡 Ticketbox API Poller — poll event mỗi 300ms", "yellow");

  // Rate limit tracker
  const rl = window.SVP_RATE_LIMIT?.forHost("api-v2.ticketbox.vn");
  if (rl) rl.reset();
  let lastWaitLog = 0, lastErrLog = 0;

  while (!_huntPollerStopTb) {
    try {
      const res = await fetch(eventUrl, {
        method: "GET",
        headers: {
          "Accept": "application/json, text/plain, */*",
          "Accept-Language": "vi,en-US;q=0.9,en;q=0.8",
          "Origin": WEB_TB_HUNT,
          "Referer": WEB_TB_HUNT + "/",
        },
        signal: AbortSignal.timeout(4000),
      });

      if (res.ok) {
        rl?.onSuccess();
        const data = await res.json();
        const showing = findBestTbShowing(data, preferredDate);

        if (showing) {
          const showingId = String(showing.id || "");
          const statusName = showing.statusName || showing.status || "";

          if (isTbHuntShowingOpen(showing)) {
            svpLog(`🎯 Showing mở bán: ${showingId} (${statusName})`, "green");
            return { showingId, showingDate: tbHuntShowingDate(showing), showing };
          }

          if (Date.now() - lastWaitLog > 3000) {
            svpLog(`⏳ Chưa mở bán: ${showingId} (${statusName})`, "yellow");
            lastWaitLog = Date.now();
          }
        } else {
          if (Date.now() - lastErrLog > 5000) {
            svpLog("⚠️ Event API 200 nhưng chưa thấy showings[]", "yellow");
            lastErrLog = Date.now();
          }
        }
      } else if (res.status === 429 || res.status === 503 || res.status === 502) {
        // Rate limit: exponential backoff
        if (rl) {
          const wait = rl.onError429(res.status);
          if (wait < 0) {
            svpLog("🛑 Hunt Ticketbox abort — server block IP để tránh ban vĩnh viễn", "red");
            return null;
          }
          await sleep(wait);
        } else {
          await sleep(300 + Math.random() * 500);
        }
        continue;
      } else {
        if (Date.now() - lastErrLog > 5000) {
          svpLog(`⚠️ Event API HTTP=${res.status}`, "yellow");
          lastErrLog = Date.now();
        }
      }
    } catch(e) {
      if (Date.now() - lastErrLog > 5000) {
        svpLog(`⚠️ Poll error: ${e.message}`, "yellow");
        lastErrLog = Date.now();
      }
    }
    await sleep(300);
  }
  return null;
}

// ── Main hunt Ticketbox ───────────────────────────────────────────────────────

async function huntTicketbox(cfg) {
  _huntStopTb = false;
  _huntPollerStopTb = false;

  svpLog("🎯 Ticketbox Direct Nav v3 — không click button + queue-aware", "yellow");

  const eventId = extractTbHuntEventId();
  if (!eventId) {
    svpLog("❌ Không lấy được event_id từ URL Ticketbox.", "red");
    return;
  }

  const date = extractTbHuntDate();
  svpLog(`🔎 Event ID: ${eventId}`, "blue");
  svpLog(`📅 Date dùng để test: ${date}`, "blue");

  // Poll API
  const result = await pollTbEventApi(eventId, date);
  if (_huntStopTb) return;

  if (!result) {
    svpLog("❌ API báo mở nhưng không có showing_id.", "red");
    return;
  }

  const { showingId, showingDate, showing } = result;
  if (!showingId) {
    svpLog("❌ Không có showing_id.", "red");
    return;
  }

  // Dùng date từ showing nếu có, tránh lấy nhầm ngày hiện tại
  let navDate = showingDate || date;
  if (showingDate && showingDate !== date) {
    svpLog(`📅 Override date theo showing: ${navDate}`, "blue");
  }

  _huntPollerStopTb = true;
  await directTbShowingsAndNav(eventId, showingId, navDate);
}

function stopHuntTicketbox() {
  _huntStopTb = true;
  _huntPollerStopTb = true;
  svpLog("🛑 Đã dừng hunt Ticketbox", "yellow");
}
