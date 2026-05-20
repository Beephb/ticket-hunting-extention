// src/content/runner.js
// Guard chống double inject
if (window.__SVP_INJECTED__) {
  console.log("[SVP] Already injected, skip");
} else {
window.__SVP_INJECTED__ = true;

const _HUNT_FLAG_KEY = "__svp_hunt_done__";
const _HUNT_FLAG_TTL = 30000; // 30 giây

let _cfg = null;
let _enabled = false;
let _running = false;

// ── Config ────────────────────────────────────────────────────────────────────

async function initConfig() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_CONFIG" }, res => {
      if (res && res.config) {
        _cfg = res.config;
        _enabled = !!res.config?.auto_seat?.enabled;
        svpLog(`⚙️ Config loaded | platform=${_cfg?.auto_seat?.platform} | enabled=${_enabled}`, "blue");
      }
      resolve(_cfg);
    });
  });
}

// ── Hunt flag (sessionStorage + TTL 30s) ─────────────────────────────────────

function setHuntFlag() {
  sessionStorage.setItem(_HUNT_FLAG_KEY, String(Date.now()));
}

function checkAndClearHuntFlag() {
  const val = sessionStorage.getItem(_HUNT_FLAG_KEY);
  if (!val) return false;
  const age = Date.now() - parseInt(val);
  sessionStorage.removeItem(_HUNT_FLAG_KEY);
  return age < _HUNT_FLAG_TTL;
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "CONFIG_UPDATE") {
    const wasEnabled = _enabled;
    _cfg = msg.config;
    _enabled = !!msg.config?.auto_seat?.enabled;
    if (!wasEnabled && _enabled) {
      svpLog("🟢 Bot được bật — bắt đầu check trang...", "green");
      maybeRun();
    } else if (wasEnabled && !_enabled) {
      svpLog("⏸ Bot tắt", "gray");
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "CONFIG_RELOAD") {
    initConfig().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "RUN_NOW") {
    maybeRun(true);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "HUNT_NOW") {
    if (!_cfg) { initConfig().then(() => startHunt(true)); }
    else startHunt(true);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "HUNT_ONLY") {
    if (!_cfg) { initConfig().then(() => startHunt(false)); }
    else startHunt(false);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "FILL_FORM_NOW") {
    if (!_cfg) { initConfig().then(() => runFillForm()); }
    else runFillForm();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "STOP_HUNT") {
    stopHunt1Zone?.();
    stopHuntTicketbox?.();
    _running = false;
    svpLog("🛑 Hunt đã dừng", "yellow");
    sendResponse({ ok: true });
    return;
  }
  sendResponse({ ok: false });
});

// ── Fill form thủ công ────────────────────────────────────────────────────────

async function runFillForm() {
  if (_running) { svpLog("⏳ Đang chạy, bỏ qua", "gray"); return; }
  if (!_cfg) { svpLog("❌ Chưa có config", "red"); return; }
  _running = true;
  try {
    await autoFillForm(_cfg);
  } catch(e) {
    svpLog(`❌ Fill form lỗi: ${e.message}`, "red");
  } finally {
    _running = false;
  }
}

// ── Hunt ─────────────────────────────────────────────────────────────────────

async function startHunt(autoSeat = true) {
  if (_running) { svpLog("⏳ Đang chạy, bỏ qua", "gray"); return; }
  if (!_cfg) { svpLog("❌ Chưa có config", "red"); return; }
  const platform = detectPlatform();
  if (!platform) { svpLog("⚠️ Không phải trang 1Zone/Ticketbox", "yellow"); return; }
  _running = true;
  svpLog(`🏹 Bắt đầu Hunt: ${platform}${autoSeat ? " (+ auto chọn ghế)" : " (chỉ hunt)"}`, "blue");
  try {
    if (autoSeat) setHuntFlag();
    if (platform === "1Zone") await hunt1Zone(_cfg);
    else if (platform === "Ticketbox") await huntTicketbox(_cfg);
  } catch (e) {
    svpLog(`❌ Hunt lỗi: ${e.message}`, "red");
    if (autoSeat) sessionStorage.removeItem(_HUNT_FLAG_KEY);
  } finally {
    _running = false;
  }
}

// ── Main router ───────────────────────────────────────────────────────────────

async function maybeRun(force = false) {
  if (_running) { svpLog("⏳ Bot đang chạy, bỏ qua", "gray"); return; }
  if (!_enabled && !force) return;
  if (!_cfg) { await initConfig(); }
  if (!_cfg) { svpLog("❌ Không lấy được config từ App", "red"); return; }

  const platform = detectPlatform();
  if (!platform) return;

  const pageType = detectPageType();
  const cfgPlatform = _cfg?.auto_seat?.platform || "";
  const mode = _cfg?.auto_seat?.seat_mode || "seat_zone";

  svpLog(`🚀 Platform=${platform} | PageType=${pageType} | mode=${mode}`, "blue");

  if (pageType === "checkout") {
    _running = true;
    try {
      await sleep(1000);
      await autoFillForm(_cfg);
    } finally {
      _running = false;
    }
    return;
  }

  if (cfgPlatform && platform !== cfgPlatform) {
    svpLog(`⚠️ Platform trang (${platform}) ≠ config (${cfgPlatform})`, "yellow");
    return;
  }

  const isBookingPage = pageType === "booking_1zone" || pageType === "select_ticket_tb";
  if (!isBookingPage) {
    svpLog(`ℹ️ Trang hiện tại (${pageType}) không phải trang chọn vé — chờ điều hướng`, "gray");
    return;
  }

  _running = true;
  await sleep(800);
  try {
    svpLog(`🪑 Route: ${platform} + ${mode}`, "blue");
    if (platform === "1Zone" && mode === "seat_zone") await run1ZoneSeatZone(_cfg);
    else if (platform === "1Zone" && mode === "seat_map") await run1ZoneSeatMap(_cfg);
    else if (platform === "Ticketbox" && mode === "seat_zone") await runTicketboxSeatZone(_cfg);
    else if (platform === "Ticketbox" && mode === "seat_map") await runTicketboxSeatMap(_cfg);
    else svpLog(`⚠️ Không có flow cho: ${platform} + ${mode}`, "yellow");
  } catch (e) {
    svpLog(`❌ Lỗi trong flow: ${e.message}`, "red");
    console.error("[SVP]", e);
  } finally {
    _running = false;
  }
}

// ── Watch SPA navigation ─────────────────────────────────────────────────────

let _lastUrl = location.href;

function watchNavigation() {
  setInterval(() => {
    if (location.href !== _lastUrl) {
      _lastUrl = location.href;
      _running = false;
      svpLog(`🔄 SPA nav → ${location.href.slice(0, 80)}`, "gray");
      setTimeout(() => maybeRun(), 1500);
    }
  }, 500);
}

// ── Khởi động ─────────────────────────────────────────────────────────────────

(async () => {
  svpLog(`✅ Săn Vé Pro v${SVP_VERSION} injected`, "green");
  await initConfig();
  watchNavigation();

  // Kiểm tra hunt flag — nếu vừa hunt xong thì tự chạy seat dù enabled=false
  const huntDone = checkAndClearHuntFlag();
  if (huntDone) {
    svpLog("🎯 Hunt flag detected — tự động chạy seat selector...", "green");
    await sleep(1000);
    await maybeRun(true);
    return;
  }

  if (_enabled) {
    svpLog("🟢 Bot đang bật, check trang...", "green");
    await sleep(800);
    maybeRun();
  }
})();

} // end __SVP_INJECTED__ guard
