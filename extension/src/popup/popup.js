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

  // Seat availability panel
  initSeatPanel();

  bind("btn-hunt-auto", () => sendToTab("HUNT_NOW", "Bắt đầu Hunt + auto chọn ghế"));
  bind("btn-hunt-only", () => sendToTab("HUNT_ONLY", "Bắt đầu Hunt (chỉ navigate)"));
  bind("btn-seat",      () => sendToTab("RUN_NOW", "Gửi lệnh chọn ghế"));
  bind("btn-form",      () => sendToTab("FILL_FORM_NOW", "Gửi lệnh điền form"));
  bind("btn-stop",      () => sendToTab("STOP_HUNT", "Đã gửi dừng Hunt"));
  bind("btn-open-app",  () => addLog("ℹ️ Hãy mở main.py thủ công để khởi động Desktop App"));
}

init();

// ── Seat availability panel ──────────────────────────────────────────────────
let _seatPollInterval = null;

async function _get1ZoneSeatData() {
  // Ưu tiên đọc từ chrome.storage.session — được lưu khi hunt chạy, tồn tại qua mọi domain
  const stored = await chrome.storage.session.get("svp_event_info");
  let cachedEventId = stored?.svp_event_info?.eventId || null;
  let cachedCalendarId = stored?.svp_event_info?.calendarId || null;

  const tabs = await chrome.tabs.query({ url: ["https://ticket.1zone.vn/*", "https://queue.1zone.vn/*"] });
  if (!tabs.length && !cachedEventId) return null;

  let eventId = cachedEventId, calendarId = cachedCalendarId;

  // Nếu chưa có từ storage, thử lấy từ tab ticket.1zone.vn
  if (!eventId) {
    for (const tab of tabs) {
      if (!tab.url.includes('ticket.1zone.vn')) continue;
      try {
        const url = new URL(tab.url);
        calendarId = url.searchParams.get('calendarId') || calendarId;
        const results = await chrome.scripting.executeScript({
          target: { tabId: tab.id },
          func: () => {
            const el = document.querySelector('[id^="seatmap-container-"]');
            const m = el?.id?.match(/seatmap-container-(\w+)/);
            return m?.[1] || null;
          },
        });
        eventId = results?.[0]?.result || null;
        if (eventId) break;
      } catch {}
    }
  }

  if (!eventId || !calendarId) return null;

  try {
    const res = await fetch(
      `https://prod.1zone.vn/ticketing/api/v4/ticket-summary/get-summary-event/${eventId}/zones?calendarId=${calendarId}`,
      { credentials: "include", headers: { "Accept": "application/json" }, signal: AbortSignal.timeout(5000) }
    );
    if (!res.ok) return null;
    const json = await res.json();
    if (!json.data?.length) return null;

    return json.data.map(z => ({
      name: z.name,
      available: z.countTicketsAvailable ?? 0,
    }));
  } catch {}

  return null;
}

function renderSeatList(zones) {
  const list = document.getElementById("seat-drop-list");
  const btn = document.getElementById("btn-seat-toggle");
  if (!list || !btn) return;

  if (!zones || !zones.length) {
    list.innerHTML = '<div class="seat-drop-empty">Mở trang seatmap để xem</div>';
    btn.textContent = "🪑 —";
    btn.className = "btn-seat-toggle";
    return;
  }

  const hasSoldout = zones.some(z => z.available === 0);
  const allSoldout = zones.every(z => z.available === 0);

  // Cập nhật nút: chỉ hiện icon + trạng thái tổng
  if (allSoldout) {
    btn.textContent = "🪑 Hết";
    btn.className = "btn-seat-toggle has-soldout";
  } else if (hasSoldout) {
    btn.textContent = "🪑 Còn/Hết";
    btn.className = "btn-seat-toggle has-soldout";
  } else {
    btn.textContent = "🪑 Còn";
    btn.className = "btn-seat-toggle all-available";
  }

  // Render dropdown list — chỉ hiện còn/hết, không hiện số
  list.innerHTML = zones.map(z => {
    const soldout = z.available === 0;
    return `<div class="seat-drop-row">
      <span class="seat-drop-name">${z.name}</span>
      <span class="seat-drop-status ${soldout ? 'soldout' : 'available'}">${soldout ? 'Hết' : 'Còn'}</span>
    </div>`;
  }).join("");
}

function initSeatPanel() {
  pollSeatAvailability();
  _seatPollInterval = setInterval(pollSeatAvailability, 3000);

  // Toggle dropdown xổ sang trái
  const seatBtn = document.getElementById("btn-seat-toggle");
  const dropdown = document.getElementById("seat-dropdown");
  if (seatBtn && dropdown) {
    seatBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      dropdown.classList.toggle("open");
    });
    // Click ngoài để đóng
    document.addEventListener("click", () => dropdown.classList.remove("open"));
  }

  // Nút overlay
  const overlayBtn = document.getElementById("btn-overlay-toggle");
  if (overlayBtn) overlayBtn.addEventListener("click", toggleOverlay);

  // Khôi phục state overlay
  chrome.storage.local.get("svp_overlay_on", r => {
    _overlayOn = !!r.svp_overlay_on;
    _updateOverlayBtn(overlayBtn);
  });

  // Queue status
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
}

async function pollSeatAvailability() {
  const zones = await _get1ZoneSeatData();
  renderSeatList(zones);
}

function _overlayInjectFn() {
  if (window.__svpOverlayRunning) return;
  window.__svpOverlayRunning = true;

  const overlayRoot = document.createElement('div');
  overlayRoot.id = '__svp_overlay__';
  overlayRoot.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;pointer-events:none;z-index:9999';
  document.body.appendChild(overlayRoot);

  async function fetchZones(eventId, calendarId) {
    // Dùng /zones API — trả về số thật hơn /get-summary-event
    const res = await fetch(
      'https://prod.1zone.vn/ticketing/api/v4/ticket-summary/get-summary-event/' + eventId + '/zones?calendarId=' + calendarId,
      { credentials: 'include', headers: { 'Accept': 'application/json' }, signal: AbortSignal.timeout(5000) }
    );
    const json = await res.json();
    // Map ticketClassId → tổng số vé còn
    const map = {};
    for (const z of (json.data || [])) {
      const tcId = z.ticketClassId;
      if (!tcId) continue;
      if (!(tcId in map)) map[tcId] = 0;
      map[tcId] += z.countTicketsAvailable ?? 0;
    }
    return map;
  }

  function render(zoneMap) {
    const stage = window.Konva?.stages?.[0];
    if (!stage) return;
    const canvas = document.querySelector('.konvajs-content canvas');
    if (!canvas) return;
    const cr = canvas.getBoundingClientRect();
    overlayRoot.innerHTML = '';
    stage.find('Path').forEach(p => {
      const tcId = p.attrs?.ticketClassId;
      if (tcId == null || !(tcId in zoneMap)) return;
      const r = p.getClientRect({ skipShadow: true });
      if (!r || r.width < 5) return;
      const cx = cr.left + r.x + r.width / 2;
      const cy = cr.top + r.y + r.height / 2;
      const available = zoneMap[tcId];
      const soldout = available === 0;
      const el = document.createElement('div');
      el.style.cssText = 'position:fixed;pointer-events:none;transform:translate(-50%,-50%);' +
        'background:rgba(0,0,0,0.82);border-radius:5px;padding:3px 8px;white-space:nowrap;' +
        'font-size:12px;font-weight:800;font-family:sans-serif;' +
        'color:' + (soldout ? '#ef4444' : '#22c55e') + ';' +
        'left:' + cx + 'px;top:' + cy + 'px;';
      el.textContent = soldout ? 'Hết' : 'Còn';
      overlayRoot.appendChild(el);
    });
  }

  async function loop() {
    const el = document.querySelector('[id^="seatmap-container-"]');
    const m = el?.id?.match(/seatmap-container-(\w+)/);
    const calM = location.href.match(/calendarId=([^&]+)/);
    const eventId = m?.[1], calendarId = calM?.[1];
    if (!eventId || !calendarId) { if (window.__svpOverlayRunning) setTimeout(loop, 2000); return; }

    try {
      const zoneMap = await fetchZones(eventId, calendarId);
      render(zoneMap);
    } catch(e) {}

    if (window.__svpOverlayRunning) setTimeout(loop, 3000);
  }

  window.__svpOverlayStop = () => {
    window.__svpOverlayRunning = false;
    document.getElementById('__svp_overlay__')?.remove();
  };

  loop();
}

function _overlayStopFn() {
  if (typeof window.__svpOverlayStop === 'function') window.__svpOverlayStop();
  else { window.__svpOverlayRunning = false; document.getElementById('__svp_overlay__')?.remove(); }
}

let _overlayOn = false;

async function _getActiveOrFirstTab(urlPatterns) {
  const allTabs = await chrome.tabs.query({ url: urlPatterns });
  if (!allTabs.length) return null;
  const active = allTabs.find(t => t.active);
  return active || allTabs[0];
}

async function toggleOverlay() {
  const btn = document.getElementById("btn-overlay-toggle");
  const tab = await _getActiveOrFirstTab(["https://ticket.1zone.vn/*"]);

  if (!tab) {
    addLog("❌ Không tìm thấy tab 1Zone");
    return;
  }

  _overlayOn = !_overlayOn;
  await chrome.storage.local.set({ svp_overlay_on: _overlayOn });

  try {
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: _overlayOn ? _overlayInjectFn : _overlayStopFn,
      world: "MAIN",
    });
    addLog(_overlayOn ? "👁 Overlay bật" : "👁 Overlay tắt");
  } catch(e) {
    addLog(`❌ Inject lỗi: ${e.message}`);
    _overlayOn = !_overlayOn; // rollback
  }

  _updateOverlayBtn(btn);
}

function _updateOverlayBtn(btn) {
  if (!btn) return;
  if (_overlayOn) {
    btn.style.background = "#14532d";
    btn.style.color = "#22c55e";
    btn.style.borderColor = "#166534";
    btn.title = "Tắt overlay trên seatmap";
  } else {
    btn.style.background = "#1e293b";
    btn.style.color = "#64748b";
    btn.style.borderColor = "#334155";
    btn.title = "Bật overlay trên seatmap";
  }
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
