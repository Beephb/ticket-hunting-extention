// src/popup/popup.js
const API_BASE = "http://127.0.0.1:9279";
const LOGS = [];

// ── Main tab switching (Săn Vé / Captcha) ────────────────────────────────────
function initMainTabs() {
  const tabs = document.querySelectorAll(".main-tab");
  tabs.forEach(tab => {
    tab.addEventListener("click", () => {
      const target = tab.dataset.tab;
      tabs.forEach(t => t.classList.toggle("active", t.dataset.tab === target));
      document.querySelectorAll(".tab-panel").forEach(p => {
        p.classList.toggle("active", p.id === `panel-${target}`);
      });
      if (target === "captcha") initCdpTab();
    });
  });
}

// ── CDP Toggle (Tab Captcha) ──────────────────────────────────────────────────
async function initCdpTab() {
  const btn      = document.getElementById("btn-cdp");
  const dot      = document.getElementById("cdp-dot");
  const statusTx = document.getElementById("cdp-status-text");
  const card     = document.getElementById("cdp-card");
  const btnIcon  = document.getElementById("btn-cdp-icon");
  const btnTitle = document.getElementById("btn-cdp-title");
  const btnSub   = document.getElementById("btn-cdp-sub");
  if (!btn) return;

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  let connected = false;

  function _render(isConnected) {
    connected = isConnected;
    if (isConnected) {
      dot.className      = "cdp-dot connected";
      statusTx.className = "cdp-status-text connected";
      statusTx.textContent = "⚡ Đang kết nối";
      card.className     = "captcha-card connected";
      btn.className      = "btn-cdp connected";
      btnIcon.textContent  = "✕";
      btnTitle.textContent = "Ngắt kết nối";
      btnSub.textContent   = "Bấm để tắt chuột phần cứng";
    } else {
      dot.className      = "cdp-dot";
      statusTx.className = "cdp-status-text";
      statusTx.textContent = "Chưa kết nối";
      card.className     = "captcha-card";
      btn.className      = "btn-cdp";
      btnIcon.textContent  = "⚡";
      btnTitle.textContent = "Kết nối CDP";
      btnSub.textContent   = "Bấm để bật chuột phần cứng";
    }
  }

  // Lấy trạng thái hiện tại
  chrome.runtime.sendMessage({ type: "CDP_CHECK_STATUS", tabId: tab.id }, res => {
    _render(!!res?.isConnected);
  });

  btn.addEventListener("click", async () => {
    btn.disabled = true;
    const action = connected ? "CDP_DETACH" : "CDP_ATTACH";
    chrome.runtime.sendMessage({ type: action, tabId: tab.id }, res => {
      btn.disabled = false;
      _render(res?.status === "connected");
    });
  });
}

initMainTabs();

const PLATFORM_KEY_MAP = { "1Zone": "1zone", "Ticketbox": "ticketbox", "Ctiket": "ctiket" };

// ── Detect platform theo tab đang active trong window hiện tại ───────────────
async function detectActivePlatform() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tab?.url || "";
    if (url.includes("1zone.vn")) return "1Zone";
    if (url.includes("ticketbox.vn")) return "Ticketbox";
    if (url.includes("cticket.vn")) return "Ctiket";
  } catch {}
  return null; // tab hiện tại không phải trang nào trong 3 platform
}

function renderPlatformTabs(activePlatform) {
  for (const [platform] of Object.entries(PLATFORM_KEY_MAP)) {
    const el = document.getElementById(`tab-${PLATFORM_KEY_MAP[platform]}`);
    if (!el) continue;
    if (platform === activePlatform) {
      el.classList.add("active");
      el.classList.remove("inactive-dim");
    } else {
      el.classList.remove("active");
      if (activePlatform) {
        el.classList.add("inactive-dim");
      } else {
        el.classList.remove("inactive-dim");
      }
    }
  }
}

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

function renderConfig(cfg, activePlatform) {
  const pk = PLATFORM_KEY_MAP[activePlatform];
  const as_ = pk ? (cfg?.auto_seat?.[pk] || {}) : {};

  document.getElementById("cfg-platform").textContent = activePlatform || "—";
  document.getElementById("cfg-mode").textContent = as_.seat_mode || "—";
  const zones = (as_.zone_priority || as_.priority_targets || []).slice(0, 3).join(", ") || "—";
  document.getElementById("cfg-zones").textContent = zones;
  document.getElementById("cfg-qty").textContent = as_.quantity || 1;
}

function addLog(msg) {
  LOGS.push(msg);
  if (LOGS.length > 20) LOGS.shift();
  const box = document.getElementById("log-box");
  box.textContent = LOGS.slice(-4).join("\n");
  box.scrollTop = box.scrollHeight;
}

// ── Content script connection status ─────────────────────────────────────────

async function checkContentScript() {
  const dot     = document.getElementById("conn-dot");
  const text    = document.getElementById("conn-text");
  const btn     = document.getElementById("btn-reconnect");
  if (!dot || !text || !btn) return;

  // Checking state
  dot.className  = "dot checking";
  text.textContent = "⏳ Đang kiểm tra trang...";
  btn.style.display = "none";

  let tab;
  try {
    [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  } catch {}

  if (!tab?.id) {
    dot.className    = "dot offline";
    text.textContent = "⚫ Không xác định được tab hiện tại";
    return;
  }

  const url = tab.url || "";
  const isSupportedPage =
    url.includes("ticket.1zone.vn") ||
    url.includes("ticketbox.vn")    ||
    url.includes("cticket.vn");

  if (!isSupportedPage) {
    dot.className    = "dot";  // grey
    text.textContent = "⚫ Không phải trang 1Zone / Ticketbox / Ctiket";
    return;
  }

  // Ping content script
  let alive = false;
  try {
    alive = await new Promise(resolve => {
      chrome.tabs.sendMessage(tab.id, { type: "PING" }, res => {
        if (chrome.runtime.lastError) resolve(false);
        else resolve(!!res?.ok);
      });
    });
  } catch {}

  const hostname = new URL(url).hostname;

  if (alive) {
    dot.className    = "dot online";
    text.textContent = `🟢 Đã kết nối — ${hostname}`;
    btn.style.display = "none";
  } else {
    dot.className    = "dot offline";
    text.textContent = `🔴 Chưa kết nối — ${hostname}`;
    btn.style.display = "";

    btn.disabled = false;
    btn.onclick  = async () => {
      btn.disabled     = true;
      btn.textContent  = "⏳ Đang kết nối...";
      dot.className    = "dot checking";
      text.textContent = "⏳ Đang inject content script...";

      // Yêu cầu background re-inject
      chrome.runtime.sendMessage({ type: "REINJECT_TAB", tabId: tab.id }, async () => {
        // Chờ 1.5s để script load xong rồi ping lại
        await new Promise(r => setTimeout(r, 1500));
        btn.textContent = "🔄 Kết nối lại";
        await checkContentScript();
      });
    };
  }
}

async function initSlotSelector(currentTab) {
  const sel = document.getElementById("slot-select");
  if (!sel || !currentTab) return;

  // Lấy danh sách slots + slot đang active của tab này
  const res = await new Promise(resolve => {
    chrome.runtime.sendMessage({ type: "GET_SLOTS", tabId: currentTab.id }, r => resolve(r || {}));
  });

  const slots = res.slots || [];
  const activeSlot = res.activeSlot ?? -1;

  // Build options
  sel.innerHTML = `<option value="-1">— Config chung —</option>`;
  slots.forEach((slot, i) => {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = slot.name || `Slot ${i + 1}`;
    sel.appendChild(opt);
  });
  sel.value = activeSlot;

  sel.addEventListener("change", () => {
    const slotIndex = parseInt(sel.value);
    chrome.runtime.sendMessage({
      type: "SET_TAB_SLOT",
      tabId: currentTab.id,
      slotIndex,
    }, () => {
      // Lấy config đã merge slot từ background (không fetch /config global)
      chrome.runtime.sendMessage({ type: "GET_CONFIG", tabId: currentTab.id }, res => {
        if (res?.config) renderConfig(res.config, currentTab._detectedPlatform);
      });
    });
  });
}

async function init() {
  const [currentTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const activePlatform = await detectActivePlatform();
  if (currentTab) currentTab._detectedPlatform = activePlatform;
  renderPlatformTabs(activePlatform);

  const cfg = await fetchConfig();
  const dot = document.getElementById("app-dot");
  const status = document.getElementById("app-status");

  if (cfg) {
    dot.className = "dot online";
    status.textContent = "Desktop App đang chạy";
    document.getElementById("sub-text").textContent = "v2.0.0 · Kết nối OK";
    renderConfig(cfg, activePlatform);
    addLog(activePlatform
      ? `Platform: ${activePlatform} — Config loaded`
      : "Mở 1 trang 1Zone/Ticketbox/Ctiket để xem config");
  } else {
    dot.className = "dot offline";
    status.textContent = "Desktop App chưa chạy (port 9279)";
    addLog("⚠️ Không kết nối được App — hãy mở main.py");
  }

  // Init slot selector
  await initSlotSelector(currentTab);

  // Kiểm tra content script
  await checkContentScript();

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

// Refresh config mỗi 5 giây — re-detect platform vì user có thể đổi tab trình duyệt
setInterval(async () => {
  const activePlatform = await detectActivePlatform();
  renderPlatformTabs(activePlatform);
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (tab) {
    chrome.runtime.sendMessage({ type: "GET_CONFIG", tabId: tab.id }, res => {
      if (res?.config) renderConfig(res.config, activePlatform);
    });
  }
}, 5000);