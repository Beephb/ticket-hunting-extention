// src/content/runner.js
// Guard chống double inject
if (window.__SVP_INJECTED__) {
  console.log("[SVP] Already injected, skip");
} else {
window.__SVP_INJECTED__ = true;

const _HUNT_FLAG_KEY = "__svp_hunt_done__";
const _HUNT_FLAG_TTL = 90 * 60 * 1000; // 90 phút — đủ cover queue dài nhất

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
    // Set global stop flag — seat_*.js loops sẽ check và abort
    svpRequestStop?.();
    stopHunt1Zone?.();
    stopHuntTicketbox?.();
    _running = false;
    // Dừng indicator và clear interval
    hideIndicator();
    showIndicator("⚪ Đã dừng", "Hunt đã được tắt", "#64748b");
    svpLog("🛑 Hunt + seat selection đã dừng (stop flag set)", "yellow");
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "TB_CAPTCHA_STATUS") {
    const captcha = window.__SVP_TB_CAPTCHA__;
    const tokenMgr = window.__SVP_TB_TOKEN__;
    if (!captcha || !tokenMgr) { sendResponse({ ok: false, reason: "modules_missing" }); return; }
    // Lấy showingId từ URL hoặc API
    (async () => {
      try {
        // Thử lấy showingId từ URL trước
        const urlM = location.href.match(/\/bookings\/(\d{6,})|\/queue\/(\d{6,})/);
        const showingId = urlM ? (urlM[1] || urlM[2]) : null;
        if (!showingId) { sendResponse({ ok: false, reason: "no_showing" }); return; }
        const remainingMs = tokenMgr.captchaTokenRemainingMs(showingId);
        sendResponse({ ok: true, showingId, hasToken: remainingMs > 0, remainingMs });
      } catch(e) { sendResponse({ ok: false, reason: e.message }); }
    })();
    return true;
  }
  if (msg.type === "TB_CAPTCHA_CHECK") {
    // Popup manual solve: user kéo tay → popup gọi /capt/check qua đây
    const tokenMgr = window.__SVP_TB_TOKEN__;
    if (!tokenMgr) { sendResponse({ ok: false, reason: "token_mgr_missing" }); return; }
    const headers = tokenMgr.buildHeaders();
    (async () => {
      try {
        const res = await fetch(
          `https://api-v2.ticketbox.vn/sapporo/api/v2/capt/check/${msg.showingId}`,
          { method: "POST", credentials: "include", headers,
            body: JSON.stringify({ key: msg.key, value: msg.value }),
            signal: AbortSignal.timeout(8000) }
        );
        if (!res.ok) { sendResponse({ ok: false, reason: `http_${res.status}` }); return; }
        const json = await res.json();
        const token = json?.data?.token;
        if (!token?.startsWith("eyJ")) {
          sendResponse({ ok: false, reason: "no_token", message: json?.message }); return;
        }
        // Lưu token
        const userId = tokenMgr.getUserId();
        try { localStorage.setItem(`tkc_${userId}${msg.showingId}`, token); } catch {}
        let remainingMs = 0;
        try {
          const b64 = token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/");
          const pl = JSON.parse(atob(b64 + "=".repeat((4-b64.length%4)%4)));
          if (pl?.exp) remainingMs = Math.max(0, pl.exp*1000 - Date.now());
        } catch {}
        svpLog(`✅ Captcha manual solved — TTL ${Math.round(remainingMs/1000)}s`, "green");
        sendResponse({ ok: true, remainingMs });
      } catch(e) { sendResponse({ ok: false, reason: "fetch_error", message: e.message }); }
    })();
    return true;
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
  svpResetStop?.();  // reset stop flag khi start mới
  _running = true;
  svpLog(`🏹 Bắt đầu Hunt: ${platform}${autoSeat ? " (+ auto chọn ghế)" : " (chỉ hunt)"}`, "blue");
  startHuntIndicator(_cfg);
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

// ── Indicator badge ───────────────────────────────────────────────────────────

const INDICATOR_ID = "__svp_indicator__";
let _indicatorInterval = null;
let _indicatorStartTime = null;
let _indicatorPollCount = 0;

function _getOrCreateIndicator() {
  let el = document.getElementById(INDICATOR_ID);
  if (el) return el;

  const style = document.createElement("style");
  style.textContent = `
    #${INDICATOR_ID} {
      position:fixed;bottom:16px;right:16px;z-index:999998;
      background:#0f172a;border:1.5px solid #1e293b;border-radius:12px;
      padding:10px 14px;min-width:200px;max-width:280px;
      font-family:-apple-system,'Segoe UI',sans-serif;
      box-shadow:0 4px 20px rgba(0,0,0,0.4);cursor:default;
      animation:__svp_fadein .3s ease;
    }
    @keyframes __svp_fadein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
    #${INDICATOR_ID} .si-row{display:flex;align-items:center;gap:8px;}
    #${INDICATOR_ID} .si-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
    #${INDICATOR_ID} .si-title{font-size:12px;font-weight:600;color:#e2e8f0;flex:1;}
    #${INDICATOR_ID} .si-close{font-size:11px;color:#475569;cursor:pointer;padding:0 2px;}
    #${INDICATOR_ID} .si-close:hover{color:#94a3b8;}
    #${INDICATOR_ID} .si-sub{font-size:10px;color:#64748b;margin-top:3px;line-height:1.4;}
  `;
  document.head.appendChild(style);

  el = document.createElement("div");
  el.id = INDICATOR_ID;
  el.innerHTML = `
    <div class="si-row">
      <div class="si-dot" id="__svp_dot__"></div>
      <div class="si-title" id="__svp_ititle__">Săn Vé Pro</div>
      <span class="si-close" id="__svp_iclose__">✕</span>
    </div>
    <div class="si-sub" id="__svp_isub__"></div>
  `;
  document.body.appendChild(el);
  document.getElementById("__svp_iclose__")?.addEventListener("click", hideIndicator);
  return el;
}

function showIndicator(title, sub, color) {
  const el = _getOrCreateIndicator();
  el.style.display = "block";
  el.style.borderColor = (color || "#1e293b") + "88";
  const dot = document.getElementById("__svp_dot__");
  const t = document.getElementById("__svp_ititle__");
  const s = document.getElementById("__svp_isub__");
  if (dot) dot.style.background = color || "#64748b";
  if (t) t.textContent = title;
  if (s) s.textContent = sub || "";
}

function hideIndicator() {
  document.getElementById(INDICATOR_ID)?.remove();
  if (_indicatorInterval) { clearInterval(_indicatorInterval); _indicatorInterval = null; }
}

function startHuntIndicator(cfg) {
  _indicatorStartTime = Date.now();
  _indicatorPollCount = 0;
  const zone = (cfg?.auto_seat?.zone_priority || [])[0] || "—";
  const qty = cfg?.auto_seat?.quantity || 1;
  if (_indicatorInterval) clearInterval(_indicatorInterval);
  _indicatorInterval = setInterval(() => {
    _indicatorPollCount++;
    const elapsed = Math.floor((Date.now() - _indicatorStartTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    showIndicator("🔴 Đang săn vé...",
      `Poll #${_indicatorPollCount.toLocaleString()} | ${mm}:${ss} | ${zone} · ${qty} vé`, "#ef4444");
  }, 500);
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

  svpResetStop?.();  // reset stop flag khi start seat selection
  _running = true;
  await sleep(800);
  try {
    svpLog(`🪑 Route: ${platform} + ${mode}`, "blue");
    let seatOk = false;
    showIndicator("🟡 Đang chọn ghế...", `${platform} · ${mode}`, "#facc15");
    if (platform === "1Zone" && mode === "seat_zone") seatOk = await run1ZoneSeatZone(_cfg);
    else if (platform === "1Zone" && mode === "seat_map") seatOk = await run1ZoneSeatMap(_cfg);
    else if (platform === "Ticketbox" && mode === "seat_zone") seatOk = await runTicketboxSeatZone(_cfg);
    else if (platform === "Ticketbox" && mode === "seat_map") seatOk = await runTicketboxSeatMap(_cfg);
    else { svpLog(`⚠️ Không có flow cho: ${platform} + ${mode}`, "yellow"); return; }

    if (!seatOk) {
      const msg = "⚠️ Chọn ghế không thành công (hết ghế hoặc lỗi). Bấm Alt+2 để thử lại thủ công.";
      svpLog(msg, "red");
      chrome.runtime.sendMessage({ type: "LOG", msg, color: "red" });
      showIndicator("⚠️ Không chọn được ghế", "Bấm Alt+2 để tự chọn thủ công", "#ef4444");
      showSeatFailToast(mode);
    } else {
      showIndicator("🟢 Đã vào checkout!", "Đang điền form...", "#22c55e");
      setTimeout(hideIndicator, 5000);
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
      if (location.href.includes("/checkout") || location.href.includes("/order/") || location.href.includes("/question-form")) {
        setTimeout(async () => {
          if (!_cfg) await initConfig();
          if (!_cfg) return;
          svpLog("📝 Tự động điền form checkout...", "blue");
          try {
            await autoFillForm(_cfg);
          } catch(e) {
            svpLog(`⚠️ Fill form lỗi: ${e.message}`, "yellow");
          }
        }, 2000);
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

  // Nếu đang ở trang checkout/form → điền form luôn
  const currUrl = location.href;
  if (currUrl.includes("/checkout") || currUrl.includes("/order/") || currUrl.includes("/question-form")) {
    svpLog("📝 Detect trang form — tự động điền...", "blue");
    await sleep(1500); // chờ form load
    try {
      await autoFillForm(_cfg);
    } catch(e) {
      svpLog(`⚠️ Fill form lỗi: ${e.message}`, "yellow");
    }
    return;
  }

  if (_enabled) {
    svpLog("🟢 Bot đang bật, check trang...", "green");
    await sleep(800);
    maybeRun();
  }
})();

} // end __SVP_INJECTED__ guard
