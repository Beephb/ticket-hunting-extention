// src/popup/popup.js
const API_BASE = "http://127.0.0.1:9279";
const LOGS = [];

// ── Auth helper — lấy token từ chrome.storage (set bởi background.js) ───────
async function _authHeaders() {
  try {
    const r = await chrome.storage.local.get("svp_api_token");
    if (r?.svp_api_token) return { "X-SVP-Auth": r.svp_api_token };
  } catch {}
  return {};
}

// ── Clock realtime — sync với desktop's time offset ─────────────────────────
let _timeOffsetMs = 0;
let _lastSyncTs = 0;
let _syncSource = "local";

async function syncTimeOffset() {
  // Ưu tiên 1: lấy từ desktop /status (đã sync với Google)
  try {
    const headers = await _authHeaders();
    const res = await fetch(`${API_BASE}/status`, {
      headers,
      signal: AbortSignal.timeout(1500),
    });
    if (res.ok) {
      const d = await res.json();
      if (d?.timeOffsetMs != null) {
        _timeOffsetMs = d.timeOffsetMs;
        _lastSyncTs = Date.now();
        _syncSource = "desktop";
        return true;
      }
    }
  } catch {}

  // Fallback: sync trực tiếp HTTP Date của Google
  try {
    const t0 = Date.now();
    const res = await fetch("https://www.google.com/generate_204", {
      method: "HEAD", mode: "no-cors", cache: "no-store",
      signal: AbortSignal.timeout(2000),
    }).catch(() => null);
    // no-cors → không đọc được header → bỏ qua, dùng local
    _syncSource = "local";
    _lastSyncTs = Date.now();
  } catch {}
  return false;
}

function tickClock() {
  const now = Date.now() + _timeOffsetMs;
  const d = new Date(now);
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  const el = document.getElementById("clock-value");
  if (el) el.textContent = `${hh}:${mm}:${ss}.${ms}`;
  const syncEl = document.getElementById("clock-sync");
  if (syncEl) {
    if (_syncSource === "desktop") {
      const offsetStr = Math.abs(_timeOffsetMs) > 50
        ? `(sync ${_timeOffsetMs > 0 ? "+" : ""}${Math.round(_timeOffsetMs)}ms)`
        : "(đã sync)";
      syncEl.textContent = offsetStr;
      syncEl.style.color = "#22c55e";
    } else {
      syncEl.textContent = "(giờ máy)";
      syncEl.style.color = "#64748b";
    }
  }
}

async function fetchConfig() {
  try {
    const headers = await _authHeaders();
    const res = await fetch(`${API_BASE}/config`, {
      headers,
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function saveEnabled(val) {
  try {
    const headers = { "Content-Type": "application/json", ...(await _authHeaders()) };
    await fetch(`${API_BASE}/config`, {
      method: "POST",
      headers,
      body: JSON.stringify({ auto_seat: { enabled: val } }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

function renderConfig(cfg) {
  const as = cfg?.auto_seat || {};
  document.getElementById("cfg-platform").textContent = as.platform || "—";
  document.getElementById("cfg-mode").textContent = as.seat_mode || "—";
  const zones = (as.zone_priority || as.priority_targets || []).slice(0, 3).join(", ") || "—";
  document.getElementById("cfg-zones").textContent = zones;
  document.getElementById("cfg-qty").textContent = as.quantity || 1;
  document.getElementById("bot-toggle").checked = !!as.enabled;
}

function addLog(msg) {
  LOGS.push(msg);
  if (LOGS.length > 20) LOGS.shift();
  const box = document.getElementById("log-box");
  box.textContent = LOGS.slice(-4).join("\n");
  box.scrollTop = box.scrollHeight;
}

async function init() {
  const cfg = await fetchConfig();
  const dot = document.getElementById("app-dot");
  const status = document.getElementById("app-status");

  if (cfg) {
    dot.className = "dot online";
    status.textContent = "Desktop App đang chạy";
    document.getElementById("sub-text").textContent = "v2.0.0 · Kết nối OK";
    renderConfig(cfg);
    addLog(`Config loaded: ${cfg?.auto_seat?.platform} / ${cfg?.auto_seat?.seat_mode}`);
  } else {
    dot.className = "dot offline";
    status.textContent = "Desktop App chưa chạy (port 9279)";
    addLog("⚠️ Không kết nối được App — hãy mở main.py");
  }

  // Toggle bot
  document.getElementById("bot-toggle").addEventListener("change", async e => {
    await saveEnabled(e.target.checked);
    addLog(e.target.checked ? "🟢 Bot bật" : "⏸ Bot tắt");
    const tabs = await chrome.tabs.query({ url: ["https://ticket.1zone.vn/*", "https://ticketbox.vn/*"] });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "CONFIG_RELOAD" }).catch(() => {});
    }
  });

  // Helper gửi message tới tab hiện tại
  async function sendToTab(type, label) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type }).catch(() => {
        addLog(`❌ Tab chưa load content script`);
      });
      addLog(`✅ ${label}`);
    }
  }

  // Helper bind nếu element tồn tại — tránh crash khi HTML thiếu id
  function bind(id, handler) {
    const el = document.getElementById(id);
    if (el) el.addEventListener("click", handler);
  }

  // Captcha pre-solve
  initCaptchaUI();

  bind("btn-hunt-auto", () => sendToTab("HUNT_NOW", "Bắt đầu Hunt + auto chọn ghế"));
  bind("btn-hunt-only", () => sendToTab("HUNT_ONLY", "Bắt đầu Hunt (chỉ navigate)"));
  bind("btn-seat",      () => sendToTab("RUN_NOW", "Gửi lệnh chọn ghế"));
  bind("btn-form",      () => sendToTab("FILL_FORM_NOW", "Gửi lệnh điền form"));
  bind("btn-stop",      () => sendToTab("STOP_HUNT", "Đã gửi dừng Hunt"));
  bind("btn-open-app",  () => addLog("ℹ️ Hãy mở main.py thủ công để khởi động Desktop App"));
}

init();

// ── Captcha pre-solve module ────────────────────────────────────────────────
let _captchaState = null;       // last status from content script
let _solveCtx = null;           // { tab, showingId, key, type, angle? }
let _statusInterval = null;

async function _findTbTab() {
  try {
    const tabs = await chrome.tabs.query({ url: ["https://ticketbox.vn/*"] });
    if (!tabs.length) return null;
    // Ưu tiên active tab nếu là TB, fallback tab đầu tiên
    const active = tabs.find(t => t.active);
    return active || tabs[0];
  } catch { return null; }
}

function _fmtRemaining(ms) {
  if (ms <= 0) return "0:00";
  const s = Math.floor(ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, "0")}`;
}

async function _sendToTabAsync(tabId, msg, timeoutMs = 8000) {
  return new Promise(resolve => {
    let done = false;
    const t = setTimeout(() => { if (!done) { done = true; resolve(null); } }, timeoutMs);
    chrome.tabs.sendMessage(tabId, msg, res => {
      if (done) return;
      done = true; clearTimeout(t);
      if (chrome.runtime.lastError) resolve(null);
      else resolve(res);
    });
  });
}

async function refreshCaptchaStatus() {
  const statusEl = document.getElementById("captcha-status");
  const metaEl = document.getElementById("captcha-meta");
  const btn = document.getElementById("btn-captcha");
  if (!statusEl || !btn) return;

  const tab = await _findTbTab();
  if (!tab) {
    statusEl.innerHTML = `<span class="err">🧩 Captcha: chưa mở tab Ticketbox</span>`;
    metaEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "Giải";
    _captchaState = null;
    return;
  }

  const res = await _sendToTabAsync(tab.id, { type: "TB_CAPTCHA_STATUS" }, 6000);
  if (!res) {
    statusEl.innerHTML = `<span class="err">🧩 Captcha: tab chưa sẵn sàng (reload trang TB)</span>`;
    metaEl.textContent = "";
    btn.disabled = true;
    return;
  }

  _captchaState = { ...res, tabId: tab.id };

  if (!res.ok) {
    const reasons = {
      no_user: "Chưa login Ticketbox",
      no_showing: "Mở trang event hoặc booking",
      no_event: "Mở trang event Ticketbox",
      api_empty: "Event chưa có showing",
      solver_missing: "Content script chưa load (reload trang TB)",
      token_mgr_missing: "Token manager chưa load",
    };
    statusEl.innerHTML = `<span class="no-token">🧩 ${reasons[res.reason] || res.reason || "lỗi"}</span>`;
    metaEl.textContent = res.hint || "";
    btn.disabled = true;
    return;
  }

  if (res.hasToken && res.remainingMs > 0) {
    statusEl.innerHTML = `<span class="has-token">🧩 Còn ${_fmtRemaining(res.remainingMs)}</span>`;
    metaEl.textContent = `Showing ${res.showingId} · token valid`;
    btn.disabled = true;
    btn.textContent = "OK";
  } else {
    statusEl.innerHTML = `<span class="no-token">🧩 Chưa có captcha</span>`;
    metaEl.textContent = `Showing ${res.showingId}`;
    btn.disabled = false;
    btn.textContent = "Giải";
  }
}

async function startSolve() {
  const btn = document.getElementById("btn-captcha");
  if (!_captchaState || !_captchaState.ok || _captchaState.hasToken) return;
  btn.disabled = true;
  btn.textContent = "Đang load...";
  addLog("🧩 Gọi /capt/gen...");

  const res = await _sendToTabAsync(_captchaState.tabId,
    { type: "TB_CAPTCHA_GEN", showingId: _captchaState.showingId }, 10000);

  if (!res || !res.ok) {
    const detail = res ? JSON.stringify(res).slice(0, 200) : "timeout";
    addLog(`❌ Gen fail: ${detail}`);
    btn.disabled = false;
    btn.textContent = "Giải";
    return;
  }

  const captchaType = res.data.type; // "rotate" | "slide"
  addLog(`🧩 Captcha type=${captchaType}`);

  // Hiển thị overlay để user tự kéo/xoay
  _solveCtx = {
    tabId: _captchaState.tabId,
    showingId: _captchaState.showingId,
    key: res.data.key,
    type: captchaType,
    tile_y: res.data.tile_y ?? 0,
    tile_x: res.data.tile_x ?? 0,
    tile_width: res.data.tile_width ?? 68,
    tile_height: res.data.tile_height ?? 68,
    angle: 0,
  };
  _showSolveOverlay(res.data);
  btn.textContent = "Giải";
}

function _showSolveOverlay(data) {
  const overlay = document.getElementById("solve-overlay");
  const img = document.getElementById("solve-img");
  const thumb = document.getElementById("solve-thumb");
  const slider = document.getElementById("solve-slider");
  const aim = document.getElementById("solve-aim");
  const meta = document.getElementById("solve-meta");
  const wrap = document.getElementById("solve-img-wrap");

  const captchaType = _solveCtx?.type || "slide";
  const _normalize = src => src.startsWith("data:") ? src : `data:image/jpeg;base64,${src}`;

  if (captchaType === "rotate") {
    // Rotate: slider = 0–360°, thumb xoay theo góc
    img.onload = () => {
      const dispW = wrap.clientWidth || 280;
      slider.min = 0;
      slider.max = 360;
      slider.value = 180; // start giữa
      _solveCtx.angle = 180;
      if (data.thumb) {
        thumb.style.display = "block";
        // Căn giữa thumb trên master
        thumb.style.left = "50%";
        thumb.style.top = "50%";
        thumb.style.transform = `translate(-50%, -50%) rotate(${slider.value}deg)`;
        thumb.style.width = `${dispW * 0.35}px`;
        thumb.style.height = `${dispW * 0.35}px`;
        thumb.style.borderRadius = "50%";
      }
      aim.style.display = "none";
      meta.textContent = `Xoay: ${slider.value}° — kéo để khớp ảnh nhỏ với lỗ`;
    };

    slider.oninput = () => {
      const angle = parseInt(slider.value);
      _solveCtx.angle = angle;
      if (thumb.style.display !== "none") {
        thumb.style.transform = `translate(-50%, -50%) rotate(${angle}deg)`;
      }
      meta.textContent = `Xoay: ${angle}°`;
    };

  } else {
    // Slide captcha (cũ)
    const tileX = _solveCtx.tile_x || 0;
    const tileY = _solveCtx.tile_y || 0;
    const tileW = _solveCtx.tile_width || 68;

    img.onload = () => {
      const natW = img.naturalWidth || 300;
      const natH = img.naturalHeight || 160;
      const dispW = wrap.clientWidth || 280;
      const scale = dispW / natW;
      _solveCtx.naturalWidth = natW;
      _solveCtx.scale = scale;
      slider.min = 0;
      slider.max = Math.max(0, natW - tileW);
      slider.value = tileX;
      const startDispX = tileX * scale;
      aim.style.left = `${startDispX + tileW * scale / 2}px`;
      aim.style.display = "";
      if (data.thumb) {
        thumb.style.display = "block";
        thumb.style.borderRadius = "0";
        thumb.style.transform = "";
        thumb.style.left = `${startDispX}px`;
        thumb.style.top = `${tileY * scale}px`;
        thumb.style.width = `${tileW * scale}px`;
        thumb.style.height = `${(_solveCtx.tile_height || tileW) * scale}px`;
      }
      meta.textContent = `X = ${tileX} → kéo đến vị trí lỗ`;
    };

    slider.oninput = () => {
      const v = parseInt(slider.value);
      const scale = _solveCtx.scale || 1;
      const dispX = v * scale;
      aim.style.left = `${dispX + tileW * scale / 2}px`;
      if (data.thumb) thumb.style.left = `${dispX}px`;
      meta.textContent = `X = ${v} / ${_solveCtx.naturalWidth || "?"}`;
    };
  }

  img.src = _normalize(data.image);
  if (data.thumb) thumb.src = _normalize(data.thumb);
  else thumb.style.display = "none";

  overlay.classList.add("open");
  document.getElementById("btn-confirm").disabled = false;
}

function _hideSolveOverlay() {
  document.getElementById("solve-overlay").classList.remove("open");
  _solveCtx = null;
}

async function confirmSolve() {
  if (!_solveCtx) return;
  const slider = document.getElementById("solve-slider");
  const confirmBtn = document.getElementById("btn-confirm");
  confirmBtn.disabled = true;
  confirmBtn.textContent = "Đang verify...";

  // Rotate: value = góc (0–360), Slide: value = "x,y"
  let value;
  if (_solveCtx.type === "rotate") {
    value = String(_solveCtx.angle ?? parseInt(slider.value));
  } else {
    const x = parseInt(slider.value);
    const y = _solveCtx.tile_y ?? 0;
    value = `${x},${y}`;
  }

  const res = await _sendToTabAsync(_solveCtx.tabId, {
    type: "TB_CAPTCHA_CHECK",
    showingId: _solveCtx.showingId,
    key: _solveCtx.key,
    value,
  }, 10000);

  confirmBtn.textContent = "Xác nhận";
  confirmBtn.disabled = false;

  if (!res || !res.ok) {
    addLog(`❌ Captcha sai: ${res?.message || res?.reason || "timeout"} — thử lại`);
    return;
  }

  addLog(`✅ Captcha OK — TTL ${_fmtRemaining(res.remainingMs)}`);
  _hideSolveOverlay();
  await refreshCaptchaStatus();
}

function initCaptchaUI() {
  const btn = document.getElementById("btn-captcha");
  if (btn) btn.addEventListener("click", startSolve);
  const cancel = document.getElementById("btn-cancel");
  if (cancel) cancel.addEventListener("click", _hideSolveOverlay);
  const confirm = document.getElementById("btn-confirm");
  if (confirm) confirm.addEventListener("click", confirmSolve);

  // Queue status display — lắng nghe event từ content script qua background
  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === "SVP_QUEUE_UPDATE") {
      const queueEl = document.getElementById("queue-status");
      if (!queueEl) return;
      if (msg.status === "QUEUE") {
        queueEl.textContent = `⏳ Hàng đợi: vị trí #${msg.position}`;
        queueEl.style.color = "#facc15";
      } else if (msg.status === "BOOKING") {
        queueEl.textContent = `🚀 Đến lượt! Còn ${msg.expireIn}s`;
        queueEl.style.color = "#22c55e";
      } else {
        queueEl.textContent = "";
      }
    }
  });

  refreshCaptchaStatus();
  // Refresh status mỗi 5s
  _statusInterval = setInterval(refreshCaptchaStatus, 5000);
}

// Clock: sync 1 lần khi mở popup + tick mỗi 100ms
syncTimeOffset();
setInterval(tickClock, 100);
// Re-sync mỗi 30s nếu popup vẫn mở
setInterval(syncTimeOffset, 30000);

// Refresh config mỗi 5 giây
setInterval(async () => {
  const cfg = await fetchConfig();
  if (cfg) renderConfig(cfg);
}, 5000);
