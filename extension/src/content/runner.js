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

// ── Toast thông báo trên trang ────────────────────────────────────────────────

function showSeatFailToast(mode) {
  // Xóa toast cũ nếu có
  document.getElementById("__svp_toast__")?.remove();

  const toast = document.createElement("div");
  toast.id = "__svp_toast__";
  toast.style.cssText = `
    position: fixed;
    top: 16px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 999999;
    background: #1a1a2e;
    border: 2px solid #ef4444;
    border-radius: 12px;
    padding: 16px 20px;
    box-shadow: 0 8px 32px rgba(0,0,0,0.5);
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 340px;
    max-width: 90vw;
    font-family: -apple-system, 'Segoe UI', sans-serif;
    animation: __svp_slide_in 0.3s ease;
  `;

  const style = document.createElement("style");
  style.textContent = `
    @keyframes __svp_slide_in {
      from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
      to   { opacity: 1; transform: translateX(-50%) translateY(0); }
    }
    #__svp_toast__ button:hover { opacity: 0.85; }
  `;
  document.head.appendChild(style);

  toast.innerHTML = `
    <div style="font-size:28px;line-height:1">⚠️</div>
    <div style="flex:1">
      <div style="color:#ef4444;font-weight:700;font-size:15px;margin-bottom:4px">
        Không chọn được ghế!
      </div>
      <div style="color:#94a3b8;font-size:12px;line-height:1.4">
        Hết ghế hoặc lỗi khi chọn ${mode}.<br>Hãy tự chọn ghế thủ công trên trang.
      </div>
    </div>
    <button id="__svp_btn_close__" style="
      background:#ef4444;color:#fff;border:none;border-radius:8px;
      padding:10px 16px;font-size:13px;font-weight:600;cursor:pointer;
      white-space:nowrap;flex-shrink:0;
    ">Tự chọn ghế</button>
  `;

  document.body.appendChild(toast);

  // Nút tự chọn ghế — chỉ đóng toast
  document.getElementById("__svp_btn_close__")?.addEventListener("click", () => toast.remove());

  // Tự đóng sau 30s
  setTimeout(() => toast.remove(), 30000);
}



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
    let seatOk = false;
    if (platform === "1Zone" && mode === "seat_zone") seatOk = await run1ZoneSeatZone(_cfg);
    else if (platform === "1Zone" && mode === "seat_map") seatOk = await run1ZoneSeatMap(_cfg);
    else if (platform === "Ticketbox" && mode === "seat_zone") seatOk = await runTicketboxSeatZone(_cfg);
    else if (platform === "Ticketbox" && mode === "seat_map") seatOk = await runTicketboxSeatMap(_cfg);
    else { svpLog(`⚠️ Không có flow cho: ${platform} + ${mode}`, "yellow"); return; }

    if (!seatOk) {
      const msg = "⚠️ Chọn ghế không thành công (hết ghế hoặc lỗi). Bấm Alt+2 để thử lại thủ công.";
      svpLog(msg, "red");
      chrome.runtime.sendMessage({ type: "LOG", msg, color: "red" });
      showSeatFailToast(mode);
    }
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
      _running = false; // reset running khi navigate
      svpLog(`🔄 SPA nav → ${location.href.slice(0, 80)}`, "gray");

      // Nếu navigate sang checkout → điền form luôn, không qua maybeRun
      if (location.href.includes("/checkout") || location.href.includes("/order/")) {
        setTimeout(async () => {
          if (!_cfg) await initConfig();
          if (!_cfg) return;
          svpLog("📝 Tự động điền form checkout...", "blue");
          try {
            await autoFillForm(_cfg);
          } catch(e) {
            svpLog(`⚠️ Fill form lỗi: ${e.message}`, "yellow");
          }
        }, 800);
        return;
      }

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