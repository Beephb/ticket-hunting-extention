// src/content/runner.js
// Guard chống double inject
if (window.__SVP_INJECTED__) {
  console.log("[SVP] Already injected, skip");
} else {
window.__SVP_INJECTED__ = true;

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
    if (!_cfg) { initConfig().then(() => startHunt()); }
    else startHunt();
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

// ── Hunt ─────────────────────────────────────────────────────────────────────

async function startHunt() {
  if (_running) { svpLog("⏳ Đang chạy, bỏ qua", "gray"); return; }
  if (!_cfg) { svpLog("❌ Chưa có config", "red"); return; }
  const platform = detectPlatform();
  if (!platform) { svpLog("⚠️ Không phải trang 1Zone/Ticketbox", "yellow"); return; }
  _running = true;
  svpLog(`🏹 Bắt đầu Hunt: ${platform}`, "blue");
  try {
    if (platform === "1Zone") await hunt1Zone(_cfg);
    else if (platform === "Ticketbox") await huntTicketbox(_cfg);
  } catch (e) {
    svpLog(`❌ Hunt lỗi: ${e.message}`, "red");
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
  await sleep(800); // giảm từ 1500 xuống 800 vì inject sau DOM ready
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
  if (_enabled) {
    svpLog("🟢 Bot đang bật, check trang...", "green");
    await sleep(800);
    maybeRun();
  }
})();

} // end __SVP_INJECTED__ guard