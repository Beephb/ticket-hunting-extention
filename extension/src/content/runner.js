// src/content/runner.js
// Guard chống double inject
if (window.__SVP_INJECTED__) {
  console.log("[SVP] Already injected, skip");
} else {

// ── Platform config helpers ───────────────────────────────────────────────────
// Config moi luu theo platform key: auto_seat.{key}.zone_priority v.v.
// Helper tu dong lookup dung key theo platform display name.

const _PLATFORM_KEY_MAP = { "1Zone": "1zone", "Ticketbox": "ticketbox", "Ctiket": "ctiket" };

function _getPlatformKey(platform) {
  return _PLATFORM_KEY_MAP[platform] || "1zone";
}

// Tra ve platform-specific config, fallback ve auto_seat flat (cau truc cu)
function _getPlatformCfg(cfg, platform) {
  const pk = _getPlatformKey(platform);
  return cfg?.auto_seat?.[pk] || cfg?.auto_seat || {};
}
window.__SVP_INJECTED__ = true;

const _HUNT_FLAG_KEY = "__svp_hunt_done__";
const _HUNT_FLAG_TTL = 90 * 60 * 1000; // 90 phút — đủ cover queue dài nhất

// Flag riêng đánh dấu "user đã chủ động bấm 1 nút trong popup" (RUN_NOW / HUNT_NOW / HUNT_ONLY).
// Dùng để chặn maybeRun() tự kích hoạt seat-selection khi chỉ đơn thuần SPA-navigate
// (vd: user tự bấm xem trang chọn vé trên Ticketbox mà không hề mở popup SVP).
const _RUN_TRIGGERED_KEY = "__svp_run_triggered__";

// Flag rieng: cho phep queue_watcher (Ctiket) kich hoat khi mode "chi san ve"
// (autoSeat=false) — TACH BIET voi _HUNT_FLAG_KEY vi flag do con duoc dung de
// gate auto-chon-ghe o buoc sau (xem watchNavigation), khong the dung chung.
const _CK_QUEUE_ONLY_KEY = "__svp_ck_queue_only__";
function isCkQueueOnlyActive() {
  const val = sessionStorage.getItem(_CK_QUEUE_ONLY_KEY);
  if (!val) return false;
  return (Date.now() - parseInt(val)) < _HUNT_FLAG_TTL;
}

let _cfg = null;
let _running = false;

// ── Config ────────────────────────────────────────────────────────────────────

async function initConfig() {
  return new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_CONFIG" }, res => {
      if (res && res.config) {
        _cfg = res.config;
        const _initPlatform = res.config?.active_platform || "1Zone";
        svpLog(`⚙️ Config loaded | platform=${_initPlatform}`, "blue");
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

// User đã bấm nút trong popup chưa? (RUN_NOW / HUNT_NOW / HUNT_ONLY)
// Dùng cùng TTL với hunt flag — đủ cover các bước SPA-nav trung gian.
function setRunTriggered() {
  sessionStorage.setItem(_RUN_TRIGGERED_KEY, String(Date.now()));
}

function isRunTriggered() {
  const val = sessionStorage.getItem(_RUN_TRIGGERED_KEY);
  if (!val) return false;
  const age = Date.now() - parseInt(val);
  return age < _HUNT_FLAG_TTL;
}

// ── Message listener ──────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "CONFIG_UPDATE") {
    const prevSlot = _cfg?._activeSlotLabel;
    _cfg = msg.config;
    _cfg._activeSlotLabel = msg.slotLabel || null;
    // Chỉ báo khi slot THỰC SỰ đổi (khác lần trước) — tránh spam mỗi lần
    // background broadcast lại config định kỳ dù slot không đổi.
    if (msg.slotLabel !== undefined && msg.slotLabel !== prevSlot) {
      const label = msg.slotLabel ? `Slot: ${msg.slotLabel}` : "Config chung";
      svpLog(`🔀 Đã đổi sang ${label} — config mới đã áp dụng`, "blue");
      showIndicator("🔀 Đã đổi cấu hình", label, "#38bdf8");
      setTimeout(() => {
        // Không ghi đè nếu đã có hoạt động khác (hunt/retry) cập nhật indicator sau đó
        if (document.getElementById("__svp_ititle__")?.textContent === "🔀 Đã đổi cấu hình") hideIndicator();
      }, 3000);
    }
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "CONFIG_RELOAD") {
    initConfig().then(() => sendResponse({ ok: true }));
    return true;
  }
  if (msg.type === "RUN_NOW") {
    setRunTriggered();
    maybeRun(true);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "HUNT_NOW") {
    setRunTriggered();
    if (!_cfg) { initConfig().then(() => startHunt(true)); }
    else startHunt(true);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "HUNT_ONLY") {
    // KHÔNG setRunTriggered() — "Chỉ hunt" nghĩa là không tự auto chọn ghế.
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
  if (msg.type === "SCAN_FIELDS") {
    const fields = svpScanFields();
    sendResponse({ ok: true, fields });
    return;
  }
  if (msg.type === "PING") {
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "STOP_HUNT") {
    // Set global stop flag — seat_*.js loops sẽ check và abort
    svpRequestStop?.();
    stopHunt1Zone?.();
    stopHuntTicketbox?.();
    stopHuntCtiket?.();
    _running = false;
    // Xoá session flag — trước đây chỉ set stop-flag cho vòng lặp đang chạy,
    // KHÔNG xoá __svp_hunt_done__/__svp_run_triggered__ (TTL 90 phút). Nếu
    // sau khi bấm Dừng mà trang tự SPA-navigate/reload (vd Ticketbox tự
    // chuyển từ queue sang trang chọn vé), checkAndClearHuntFlag() ở lần
    // load mới vẫn thấy flag còn hạn → tự resume chọn ghế dù đã bấm dừng.
    try {
      sessionStorage.removeItem(_HUNT_FLAG_KEY);
      sessionStorage.removeItem(_RUN_TRIGGERED_KEY);
    } catch {}
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
    else if (platform === "Ctiket") await huntCtiket(_cfg, autoSeat);
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
let _currentTarget = "—"; // zone/ghế đang thử lúc này — cập nhật live bởi updateHuntTarget()

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
    #${INDICATOR_ID} .si-stop{
      display:none;margin-top:8px;width:100%;background:#ef4444;color:#fff;border:none;
      border-radius:7px;padding:6px 0;font-size:11px;font-weight:600;cursor:pointer;
    }
    #${INDICATOR_ID} .si-stop:hover{background:#dc2626;}
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
    <button class="si-stop" id="__svp_istop__">Dừng chọn thủ công</button>
  `;
  document.body.appendChild(el);
  document.getElementById("__svp_iclose__")?.addEventListener("click", hideIndicator);
  document.getElementById("__svp_istop__")?.addEventListener("click", () => {
    svpRequestStop();
    svpLog("🛑 User bấm 'Dừng chọn thủ công' trên indicator", "yellow");
    showStopButton(false);
  });
  return el;
}

// showStopBtn: hiện/ẩn nút "Dừng chọn thủ công" ngay trong indicator — trước đây
// nút này chỉ có trên toast riêng ở giữa-trên màn hình (đã gộp về đây, xem
// lịch sử: 2 nơi hiện trùng lặp y hệt info "chưa chọn được ghế, đang retry").
function showIndicator(title, sub, color, showStopBtn = false) {
  const el = _getOrCreateIndicator();
  el.style.display = "block";
  el.style.borderColor = (color || "#1e293b") + "88";
  const dot = document.getElementById("__svp_dot__");
  const t = document.getElementById("__svp_ititle__");
  const s = document.getElementById("__svp_isub__");
  if (dot) dot.style.background = color || "#64748b";
  if (t) t.textContent = title;
  if (s) s.textContent = sub || "";
  showStopButton(showStopBtn);
}

function showStopButton(visible) {
  const btn = document.getElementById("__svp_istop__");
  if (btn) btn.style.display = visible ? "block" : "none";
}

function hideIndicator() {
  document.getElementById(INDICATOR_ID)?.remove();
  if (_indicatorInterval) { clearInterval(_indicatorInterval); _indicatorInterval = null; }
}

// Gọi bởi platform code (1zone/ticketbox seat_zone.js + seat_map.js) mỗi khi
// bot chuyển sang thử 1 zone/ghế ưu tiên khác, để indicator hiện đúng zone
// đang chạy THỰC TẾ thay vì luôn hiện cố định zone ưu tiên #1 lúc mới bắt đầu.
function updateHuntTarget(label) {
  _currentTarget = label || "—";
}
window.svpUpdateHuntTarget = updateHuntTarget;

function startHuntIndicator(cfg) {
  _indicatorStartTime = Date.now();
  _indicatorPollCount = 0;
  const zp = (_getPlatformCfg(cfg, cfg?.active_platform || "1Zone")?.zone_priority || [])[0];
  // zp có thể là string (khu, seat_zone mode) hoặc object {raw, quantity} (seat_map mode)
  // — dùng làm giá trị khởi đầu, sẽ bị updateHuntTarget() ghi đè ngay khi vòng lặp
  // thật sự bắt đầu thử zone cụ thể.
  _currentTarget = (zp && typeof zp === "object") ? (zp.raw || "—") : (zp || "—");
  const qty = _getPlatformCfg(cfg, cfg?.active_platform || "1Zone")?.quantity || 1;
  if (_indicatorInterval) clearInterval(_indicatorInterval);
  _indicatorInterval = setInterval(() => {
    _indicatorPollCount++;
    const elapsed = Math.floor((Date.now() - _indicatorStartTime) / 1000);
    const mm = String(Math.floor(elapsed / 60)).padStart(2, "0");
    const ss = String(elapsed % 60).padStart(2, "0");
    showIndicator("🔴 Đang săn vé...",
      `Poll #${_indicatorPollCount.toLocaleString()} | ${mm}:${ss} | ${_currentTarget} · ${qty} vé`, "#ef4444");
  }, 500);
}




async function maybeRun(force = false) {
  if (_running) { svpLog("⏳ Bot đang chạy, bỏ qua", "gray"); return; }

  // Luôn reload config để đảm bảo custom_fields và settings mới nhất
  await initConfig();
  if (!_cfg) { svpLog("❌ Không lấy được config từ App", "red"); return; }

  const platform = detectPlatform();
  if (!platform) return;

  const pageType = detectPageType();
  const _pcfg = _getPlatformCfg(_cfg, platform);
  const mode = _pcfg?.seat_mode || "seat_zone";

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

  // Ctiket queue page: khoi dong queue_watcher neu co hunt flag HOAC force=true
  // NOTE: checkAndClearHuntFlag() xoa flag truoc khi goi maybeRun(true),
  // nen phai dung tham so force de bien nguon thay vi doc lai sessionStorage
  if (pageType === "queue_ctiket") {
    const huntActive = force || !!sessionStorage.getItem(_HUNT_FLAG_KEY) || isCkQueueOnlyActive();
    if (huntActive) {
      svpLog("⏳ Detect trang Ctiket queue — khởi động queue_watcher...", "blue");
      watchLoop?.();
    }
    return;
  }

  const isBookingPage = pageType === "booking_1zone" || pageType === "select_ticket_tb" || pageType === "buy_ctiket";
  if (!isBookingPage) {
    svpLog(`ℹ️ Trang hiện tại (${pageType}) không phải trang chọn vé — chờ điều hướng`, "gray");
    return;
  }

  // Chỉ tự động chọn ghế nếu user đã chủ động bấm 1 nút trong popup
  // (RUN_NOW / HUNT_NOW / HUNT_ONLY) hoặc caller truyền force=true.
  // Tránh việc SPA-navigate đơn thuần (vd user tự bấm xem vé) cũng kích hoạt full flow.
  if (!force && !isRunTriggered()) {
    svpLog(`ℹ️ Trang chọn vé (${pageType}) nhưng chưa bấm Hunt/Run trên popup — không tự chạy`, "gray");
    return;
  }

  svpResetStop?.();  // reset stop flag khi start seat selection
  _running = true;
  await sleep(800);
  try {
    svpLog(`🪑 Route: ${platform} + ${mode}`, "blue");
    svpLog(`🚀 Bắt đầu phiên săn ghế mới`, "blue", { separator: true });
    let seatOk = false;
    let attempt = 0;
    const startUrl = location.href;
    showIndicator("🟡 Đang chọn ghế...", `${platform} · ${mode}`, "#facc15");

    while (true) {
      attempt++;
      if (svpShouldStop()) {
        svpLog("🛑 Dừng chọn ghế theo yêu cầu", "yellow");
        break;
      }
      if (location.href !== startUrl) {
        // Trang đã điều hướng đi (vd: vào checkout do nguyên nhân khác) — loop cũ vô nghĩa, để watchNavigation xử lý
        svpLog("↪️ Trang đã chuyển — dừng retry loop hiện tại", "gray");
        break;
      }

      if (platform === "1Zone" && mode === "seat_zone") seatOk = await run1ZoneSeatZone({ ..._cfg, _seatRetryAttempt: attempt });
      else if (platform === "1Zone" && mode === "seat_map") seatOk = await run1ZoneSeatMap(_cfg);
      else if (platform === "Ticketbox" && mode === "seat_zone") seatOk = await runTicketboxSeatZone(_cfg);
      else if (platform === "Ticketbox" && mode === "seat_map") seatOk = await runTicketboxSeatMap(_cfg);
      else if (platform === "Ctiket" && mode === "seat_zone") seatOk = await runCtiketSeatZone(_cfg);
      else { svpLog(`⚠️ Không có flow cho: ${platform} + ${mode}`, "yellow"); break; }

      if (seatOk) break;

      // Chưa chọn được — báo + retry liên tục cho tới khi có ghế hoặc user bấm dừng
      svpLog(`⏳ Lần ${attempt}: chưa chọn được ghế, đang retry...`, "yellow");
      showIndicator("🟠 Chưa có ghế — đang retry...", `Lần thử #${attempt} | ${platform} · ${mode}`, "#f97316", true);

      if (svpShouldStop()) {
        svpLog("🛑 Dừng chọn ghế theo yêu cầu", "yellow");
        break;
      }
      const slept = await svpSleep(700); // giam tu 1800ms — retry chon zone nhanh hon
                                          // khi vua het ve tam thoi (anh huong chung ca
                                          // 1Zone/Ticketbox/Ctiket vi dung chung outer loop nay)
      if (!slept) { svpLog("🛑 Dừng trong lúc chờ retry", "yellow"); break; }
    }

    if (!seatOk) {
      if (svpShouldStop()) {
        showIndicator("⚪ Đã dừng", "Bạn đã chọn dừng — tự chọn ghế thủ công", "#64748b");
      } else {
        showIndicator("⚠️ Không chọn được ghế", "Trang đã chuyển hoặc lỗi khác", "#ef4444");
      }
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
          // Luôn reload config để lấy custom_fields mới nhất
          await initConfig();
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

      // Ctiket SPA nav sang /queue — goi watchLoop chi khi co hunt flag
      // NOTE: flag co the da bi clear boi checkAndClearHuntFlag() nen
      // dat hunt flag moi truoc khi watchLoop check (chong mat flag)
      if (/\/buy\/[a-zA-Z0-9_-]+\/queue/.test(location.pathname)) {
        const huntActive = !!sessionStorage.getItem(_HUNT_FLAG_KEY) || isCkQueueOnlyActive();
        if (huntActive) {
          svpLog("⏳ SPA nav → Ctiket queue — khởi động queue_watcher...", "blue");
          setTimeout(() => watchLoop?.(), 800);
        }
        return;
      }

      // Ticketbox navigate sang /queue/{showingId} — xảy ra khi waiting room countdown = 0
      // Chạy khi: mày bấm tay vào waiting-room + bật tool, hoặc hunt flow redirect sang queue
      if (/\/queue\/\d+/.test(location.pathname) && location.hostname.includes("ticketbox")) {
        const huntActive = isRunTriggered() || !!sessionStorage.getItem(_HUNT_FLAG_KEY);
        if (huntActive) {
          svpLog("⏳ SPA nav → Ticketbox queue — bắt đầu poll queue...", "blue");
          setTimeout(async () => {
            const queueModule = window.__SVP_TB_QUEUE__;
            if (!queueModule) { svpLog("⚠️ TB queue module chưa load", "yellow"); return; }
            const showingId = location.href.match(/\/queue\/(\d+)/)?.[1];
            if (!showingId) { svpLog("⚠️ Không lấy được showingId từ URL queue", "yellow"); return; }
            const tokenMgr = window.__SVP_TB_TOKEN__;
            const captchaToken = tokenMgr?.getCaptchaToken?.(showingId) || null;
            svpLog(`⏳ Poll TB queue — showingId=${showingId}`, "yellow");
            const result = await queueModule.waitForBookingTurn(showingId, captchaToken, { timeoutMs: 900000 });
            if (result.ok) {
              svpLog(`✅ TB queue BOOKING — chờ Ticketbox navigate sang select-ticket`, "green");
              // Set hunt flag để khi Ticketbox tự navigate sang select-ticket
              // watchNavigation() → maybeRun(true) → chọn ghế tự động
              setHuntFlag();
              setRunTriggered();
            } else {
              svpLog(`⚠️ TB queue kết thúc: ${result.reason}`, "yellow");
            }
          }, 1000);
        }
        return;
      }

      // Ctiket SPA nav sang /buy (sau khi click button tu queue)
      // Uu tien check window.__svp_queue_passed__ (set boi queue_watcher khi click button)
      // vi sessionStorage flag da bi clear truoc do boi checkAndClearHuntFlag()
      if (/\/buy\/[a-zA-Z0-9_-]+/.test(location.pathname) && !/queue/.test(location.pathname)) {
        const queuePassed = !!window.__svp_queue_passed__;
        if (queuePassed) window.__svp_queue_passed__ = false;  // clear sau khi dung
        const huntActive = queuePassed || !!sessionStorage.getItem(_HUNT_FLAG_KEY);
        setTimeout(() => maybeRun(huntActive), 1500);
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
    // Nếu đang ở trang queue, đặt lại flag để watchNavigation vẫn có thể
    // kích hoạt watchLoop khi SPA nav sang /buy (sau khi click button queue)
    const currPageType = detectPageType();
    if (currPageType === "queue_ctiket") {
      setHuntFlag();  // re-set để watchNavigation /buy detect được
    }
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

  svpLog("🟢 Sẵn sàng, check trang...", "green");
  await sleep(800);
  maybeRun();
})();

} // end __SVP_INJECTED__ guard