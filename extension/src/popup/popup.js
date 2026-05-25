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

  bind("btn-hunt-auto", () => sendToTab("HUNT_NOW", "Bắt đầu Hunt + auto chọn ghế"));
  bind("btn-hunt-only", () => sendToTab("HUNT_ONLY", "Bắt đầu Hunt (chỉ navigate)"));
  bind("btn-seat",      () => sendToTab("RUN_NOW", "Gửi lệnh chọn ghế"));
  bind("btn-form",      () => sendToTab("FILL_FORM_NOW", "Gửi lệnh điền form"));
  bind("btn-stop",      () => sendToTab("STOP_HUNT", "Đã gửi dừng Hunt"));
  bind("btn-open-app",  () => addLog("ℹ️ Hãy mở main.py thủ công để khởi động Desktop App"));
}

init();

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
