// src/background/background.js
// Singleton — inject content scripts 1 lần duy nhất per tab navigation

const API_PORT = 9279;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const CONFIG_POLL_MS = 3000;

// ── CDP Captcha Solver (Auto Slider) ─────────────────────────────────────────
// Quản lý danh sách các Tab đang giữ kết nối Debugger CDP
const _cdpAttachedTabs = new Set();

async function _cdpDragSlider(tabId, startX, startY, distanceX) {
  try {
    const targetX = startX + distanceX;
    const overshootX = targetX + (Math.random() * 2 + 2);

    // Đè chuột trái xuống (40ms)
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: Math.round(startX), y: Math.round(startY),
      button: "left", buttons: 1, clickCount: 1
    });
    await new Promise(r => setTimeout(r, 40));

    // Lướt nhanh sang phải (10 bước, delay 5ms)
    const steps1 = 10;
    for (let i = 1; i <= steps1; i++) {
      const t = i / steps1;
      const ease = 1 - Math.pow(1 - t, 2);
      const curX = startX + ((overshootX - startX) * ease);
      const jitterY = startY + (Math.random() * 0.8 - 0.4);
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: Math.round(curX), y: Math.round(jitterY),
        button: "none", buttons: 1
      });
      await new Promise(r => setTimeout(r, 5));
    }
    await new Promise(r => setTimeout(r, 20));

    // Sửa lỗi khớp khít về đích (3 bước, delay 6ms)
    const steps2 = 3;
    for (let i = 1; i <= steps2; i++) {
      const t = i / steps2;
      const curX = overshootX + ((targetX - overshootX) * t);
      await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
        type: "mouseMoved", x: Math.round(curX), y: Math.round(startY),
        button: "none", buttons: 1
      });
      await new Promise(r => setTimeout(r, 6));
    }
    await new Promise(r => setTimeout(r, 40));

    // Thả chuột
    await chrome.debugger.sendCommand({ tabId }, "Input.dispatchMouseEvent", {
      type: "mouseReleased", x: Math.round(targetX), y: Math.round(startY),
      button: "left", buttons: 0, clickCount: 1
    });
    console.log("✅ [CDP] Đã kéo xong mục tiêu.");
  } catch (error) {
    console.error("❌ [CDP Error]:", error);
  }
}

// Dọn cdp khi tab đóng
chrome.tabs.onRemoved.addListener(tabId => {
  if (_cdpAttachedTabs.has(tabId)) {
    chrome.debugger.detach({ tabId }).catch(() => {});
    _cdpAttachedTabs.delete(tabId);
  }
});

// ── API auth token (handshake-based, Fix #2) ────────────────────────────────
// Desktop gen random token mỗi lần start. Extension fetch /handshake (public)
// để lấy token, cache vào chrome.storage.local. Mọi request sau kèm X-SVP-Auth.
// Nếu desktop restart → token mới → request 401 → tự re-handshake.
let _apiToken = null;

async function _loadCachedToken() {
  try {
    const r = await chrome.storage.local.get("svp_api_token");
    if (r?.svp_api_token) {
      _apiToken = r.svp_api_token;
      return true;
    }
  } catch {}
  return false;
}

async function _saveToken(token) {
  _apiToken = token;
  try { await chrome.storage.local.set({ svp_api_token: token }); } catch {}
}

async function _handshake() {
  try {
    const res = await fetch(`${API_BASE}/handshake`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return false;
    const d = await res.json();
    if (d?.token) {
      await _saveToken(d.token);
      console.log("[BG] ✅ Handshake OK — token cached");
      return true;
    }
  } catch (e) {
    console.log("[BG] ⚠️ Handshake fail:", e.message);
  }
  return false;
}

// Wrapper fetch — auto include token, auto re-handshake on 401
async function apiFetch(path, opts = {}) {
  if (!_apiToken) await _loadCachedToken();
  if (!_apiToken) await _handshake();

  const headers = { ...(opts.headers || {}) };
  if (_apiToken) headers["X-SVP-Auth"] = _apiToken;

  let res = await fetch(`${API_BASE}${path}`, { ...opts, headers });

  // 401 → token stale (desktop restarted) → re-handshake + retry
  if (res.status === 401) {
    console.log("[BG] 🔑 Token stale, re-handshake...");
    const ok = await _handshake();
    if (ok) {
      headers["X-SVP-Auth"] = _apiToken;
      res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
    }
  }
  return res;
}

// Isolated world content scripts (load theo thứ tự dependencies)
const CONTENT_SCRIPTS = [
  // Tier 0 — utils + logger (phải load TRƯỚC mọi file dùng svpLog/SVP_MASK)
  "src/utils/mask.js",
  "src/shared/logger.js",
  "src/utils/rate_limit.js",
  // Tier 1 — content utilities chung
  "src/content/utils.js",
  "src/content/page_bridge_client.js",
  "src/content/api.js",
  "src/content/zone_matcher.js",
  "src/content/konva_clicker.js",
  // Tier 2 — platform infrastructure (xhr capture + token manager + reserve API + captcha)
  "src/platforms/1zone/xhr_intercept.js",
  "src/platforms/ticketbox/xhr_intercept.js",
  "src/platforms/ticketbox/token_manager.js",
  "src/platforms/ticketbox/reserve_api.js",
  "src/platforms/ticketbox/captcha.js",
  "src/platforms/ticketbox/queue_watcher.js",  // poll queue API, tự resume khi BOOKING
  // Tier 3 — platform modules
  "src/platforms/1zone/hunt.js",
  "src/platforms/ticketbox/hunt.js",
  "src/platforms/ctiket/hunt.js",
  "src/platforms/1zone/seat_zone.js",
  "src/platforms/1zone/seat_map.js",
  "src/platforms/ticketbox/seat_zone.js",
  "src/platforms/ticketbox/seat_map.js",
  "src/platforms/ctiket/seat_zone.js",
  "src/platforms/ctiket/queue_watcher.js",  // poll enter(), tự navigate khi people_ahead=0
  // Tier 3 — shared form filler
  "src/content/form_filler.js",
  // Tier 3 — captcha solver (chỉ inject trên Ticketbox, xem injectTab())
  "src/captcha/puzzle-solver.js",
  "src/captcha/rotation-solver.js",
  "src/captcha/content.js",
  // Tier 4 — entry orchestrator
  "src/content/runner.js",
];

// MAIN world scripts (chạy trong page context — bypass isolated world cho XHR/fetch hook)
const MAIN_WORLD_SCRIPTS = [
  "src/injected/page_bridge.js",
  "src/injected/network_hook.js",
  "src/injected/ctiket_captcha_bridge.js",  // expose window.__ckGetCaptchaToken() cho queue_watcher
];

const TARGET_URLS = [
  "https://ticket.1zone.vn/",
  "https://queue.1zone.vn/",
  "https://ticketbox.vn/",
  "https://cticket.vn/",
];

// Scripts nhẹ chỉ inject vào queue.1zone.vn
const QUEUE_MAIN_SCRIPTS = [
  "src/platforms/1zone/queue_hook_main.js",  // MAIN world: hook fetch/XHR
];
const QUEUE_ISOLATED_SCRIPTS = [
  "src/utils/mask.js",
  "src/shared/logger.js",
  "src/platforms/1zone/queue_watcher.js",    // ISOLATED world: UI + logic
];

// Tab nào đã được inject rồi (key: tabId, value: url đã inject)
const _injected = new Map();

let _cachedConfig = null;
let _cachedSlots = [];          // cache danh sách slots từ /slots
let _appOnline = false;

// Tab → slot index mapping (tabId → slotIndex, -1 = dùng config global)
const _tabSlot = new Map();

// Lấy config đã merge slot cho 1 tab cụ thể
function _configForTab(tabId) {
  if (!_cachedConfig) return null;
  const slotIdx = _tabSlot.get(tabId);
  if (slotIdx == null || slotIdx < 0 || slotIdx >= _cachedSlots.length) {
    return _cachedConfig; // dùng global
  }
  const slot = _cachedSlots[slotIdx];
  return { ..._cachedConfig, auto_seat: slot.auto_seat };
}

// ── Inject content scripts vào tab ───────────────────────────────────────────

async function injectTab(tabId, url) {
  const isTicket  = url.startsWith("https://ticket.1zone.vn/");
  const isQueue   = url.startsWith("https://queue.1zone.vn/");
  const isTB      = url.startsWith("https://ticketbox.vn/");
  const isCk      = url.startsWith("https://cticket.vn/");

  if (!isTicket && !isQueue && !isTB && !isCk) return;

  // Đã inject cho URL này rồi → skip
  if (_injected.get(tabId) === url) {
    console.log(`[BG] Tab ${tabId} đã inject cho ${url.slice(0,50)} — skip`);
    return;
  }

  console.log(`[BG] Inject tab ${tabId}: ${url.slice(0,60)}`);
  _injected.set(tabId, url);

  try {
    if (isQueue) {
      // queue.1zone.vn: inject MAIN world hook trước, sau đó isolated world
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        files: QUEUE_MAIN_SCRIPTS,
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: QUEUE_ISOLATED_SCRIPTS,
      });
      qLog(`[BG] ✅ Queue watcher injected tab ${tabId}`);
    } else {
      // ticket.1zone.vn + ticketbox.vn + cticket.vn (trang /buy chính): inject full stack
      await chrome.scripting.executeScript({
        target: { tabId },
        world: "MAIN",
        files: MAIN_WORLD_SCRIPTS,
      });
      await chrome.scripting.executeScript({
        target: { tabId },
        files: CONTENT_SCRIPTS,
      });
      console.log(`[BG] ✅ Inject xong tab ${tabId}`);

      // Gửi config ngay sau inject
      if (_cachedConfig) {
        setTimeout(() => {
          chrome.tabs.sendMessage(tabId, {
            type: "CONFIG_UPDATE",
            config: _cachedConfig,
          }).catch(() => {});
        }, 500);
      }
    }
  } catch (e) {
    console.log(`[BG] ❌ Inject lỗi tab ${tabId}: ${e.message}`);
    _injected.delete(tabId);
  }
}

function qLog(msg) { console.log(msg); }

// ── Listen navigation events ──────────────────────────────────────────────────

// ── Listen navigation events ──────────────────────────────────────────────────

chrome.webNavigation.onCommitted.addListener(({ tabId, url, frameId }) => {
  if (frameId !== 0) return;
  const isTarget = TARGET_URLS.some(t => url.startsWith(t));
  if (!isTarget) return;
  if (_injected.get(tabId) !== url) {
    _injected.delete(tabId);
  }
});

chrome.webNavigation.onDOMContentLoaded.addListener(({ tabId, url, frameId }) => {
  if (frameId !== 0) return;
  injectTab(tabId, url);
}, {
  url: [
    { hostSuffix: "ticket.1zone.vn" },
    { hostSuffix: "queue.1zone.vn" },
    { hostSuffix: "ticketbox.vn" },
    { hostSuffix: "cticket.vn" },
  ]
});

// Xóa inject cache khi tab đóng
chrome.tabs.onRemoved.addListener(tabId => {
  _injected.delete(tabId);
  _tabSlot.delete(tabId);
});

// ── Config API ────────────────────────────────────────────────────────────────

async function fetchConfig() {
  try {
    const res = await apiFetch("/config", {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const cfg = await res.json();
    _cachedConfig = cfg;
    _appOnline = true;

    // Fetch slots song song
    try {
      const sRes = await apiFetch("/slots", { signal: AbortSignal.timeout(2000) });
      if (sRes.ok) {
        const sData = await sRes.json();
        _cachedSlots = sData.slots || [];
      }
    } catch {}

    return cfg;
  } catch {
    _appOnline = false;
    return null;
  }
}

async function sendLog(msg, color = "white") {
  if (!_appOnline) return;
  try {
    await apiFetch("/log", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ msg, color }),
      signal: AbortSignal.timeout(1500),
    });
  } catch {}
}

async function pollConfig() {
  await fetchConfig();
  if (_cachedConfig) {
    const tabs = await chrome.tabs.query({
      url: ["https://ticket.1zone.vn/*", "https://ticketbox.vn/*"]
    });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, {
        type: "CONFIG_UPDATE",
        config: _configForTab(tab.id),
      }).catch(() => {});
    }
  }

  // ── Scan fields poll ───────────────────────────────────────────────────────
  // Nếu desktop đang chờ scan → lấy tab active → gửi SCAN_FIELDS → POST kết quả về
  try {
    if (_appOnline) {
      const pollRes = await apiFetch("/scan-fields/poll", { signal: AbortSignal.timeout(1500) });
      if (pollRes.ok) {
        const d = await pollRes.json();
        if (d?.pending) {
          const [activeTab] = await chrome.tabs.query({ active: true, currentWindow: true });
          if (activeTab?.id) {
            chrome.tabs.sendMessage(activeTab.id, { type: "SCAN_FIELDS" }, async (resp) => {
              if (chrome.runtime.lastError || !resp?.fields) return;
              await apiFetch("/scan-fields", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ fields: resp.fields }),
                signal: AbortSignal.timeout(2000),
              }).catch(() => {});
            });
          }
        }
      }
    }
  } catch {}

  // ── Hunt-all poll — broadcast HUNT_NOW nếu desktop yêu cầu ────────────────
  try {
    if (_appOnline) {
      const huntRes = await apiFetch("/hunt-all", { signal: AbortSignal.timeout(1500) });
      if (huntRes.ok) {
        const d = await huntRes.json();
        if (d?.pending) {
          const allTabs = await chrome.tabs.query({
            url: [
              "https://ticket.1zone.vn/*",
              "https://queue.1zone.vn/*",
              "https://ticketbox.vn/*",
              "https://cticket.vn/*",
            ]
          });
          for (const tab of allTabs) {
            chrome.tabs.sendMessage(tab.id, { type: "HUNT_NOW" }).catch(() => {});
          }
          qLog(`[BG] 🚀 HUNT_ALL → broadcast HUNT_NOW vào ${allTabs.length} tab`);
        }
      }
    }
  } catch {}

  setTimeout(pollConfig, CONFIG_POLL_MS);
}

// ── executeScript trong page context (cho Konva) ──────────────────────────────

async function runInPageContext(tabId, fnString, args) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      func: (fnStr, fnArgs) => {
        try {
          const fn = eval(`(${fnStr})`);
          return fn(fnArgs);
        } catch(e) {
          return { __svp_error: String(e) };
        }
      },
      args: [fnString, args],
    });
    const r = results?.[0];
    if (r?.error) return { error: String(r.error) };
    const val = r?.result;
    if (val && val.__svp_error) return { error: val.__svp_error };
    return { result: val };
  } catch (e) {
    return { error: String(e) };
  }
}

// ── Message handler ───────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.type === "GET_CONFIG") {
    // Luôn fetch fresh để đảm bảo custom_fields và mọi thay đổi mới nhất
    const tabId = sender?.tab?.id || msg.tabId;
    fetchConfig().then(cfg => {
      const tabCfg = tabId ? _configForTab(tabId) : (cfg || _cachedConfig);
      sendResponse({ ok: !!cfg, config: tabCfg, appOnline: _appOnline });
    });
    return true;
  }

  // Popup set slot cho tab
  if (msg.type === "SET_TAB_SLOT") {
    const { tabId, slotIndex } = msg;
    if (tabId != null) {
      if (slotIndex < 0) {
        _tabSlot.delete(tabId);
      } else {
        _tabSlot.set(tabId, slotIndex);
      }
      // Gửi config mới vào tab ngay
      const tabCfg = _configForTab(tabId);
      if (tabCfg) {
        chrome.tabs.sendMessage(tabId, { type: "CONFIG_UPDATE", config: tabCfg }).catch(() => {});
      }
    }
    sendResponse({ ok: true });
    return true;
  }

  // Popup hỏi danh sách slots + slot đang active của tab
  if (msg.type === "GET_SLOTS") {
    const tabId = msg.tabId;
    sendResponse({
      slots: _cachedSlots,
      activeSlot: tabId != null ? (_tabSlot.get(tabId) ?? -1) : -1,
    });
    return true;
  }

  if (msg.type === "LOG") {
    sendLog(msg.msg, msg.color);
  }

  if (msg.type === "SVP_GET_CK_TOKEN") {
    const key = "__svp_ck_booking_token__";
    chrome.storage.session.get(key).then(stored => {
      sendResponse({ ok: true, payload: stored?.[key] || null });
    }).catch(e => {
      sendResponse({ ok: false, payload: null });
    });
    return true;
  }

  if (msg.type === "SVP_SAVE_CK_TOKEN") {
    const key = "__svp_ck_booking_token__";
    chrome.storage.session.set({ [key]: msg.payload }).then(() => {
      console.log(`[BG] ✅ Đã lưu CK booking_token: eventId=${msg.payload?.eventId}`);
    }).catch(e => {
      console.log(`[BG] ❌ Lỗi lưu CK token: ${e.message}`);
    });
    sendResponse({ ok: true });
    return;
  }

  if (msg.type === "SVP_SAVE_EVENT_INFO") {
    // world:"MAIN" không có quyền chrome.storage, background lưu hộ
    chrome.storage.session.set({
      svp_event_info: { eventId: msg.eventId, calendarId: msg.calendarId },
    }).then(() => {
      console.log(`[BG] ✅ Đã lưu svp_event_info: ${msg.eventId} / ${msg.calendarId}`);
    }).catch(e => {
      console.log(`[BG] ❌ Lỗi lưu svp_event_info: ${e.message}`);
    });
  }

  if (msg.type === "EVENT") {
    // Structured event từ svpEvent() — forward TÊN tới /event endpoint
    // Desktop dispatch theo event name để update UI (reserve card, tokens card...)
    try {
      const p = msg.payload || {};
      // POST event endpoint (auth)
      apiFetch("/event", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(p),
        signal: AbortSignal.timeout(1500),
      }).catch(() => {});
      // Skip log noise events
      const NOISE = new Set(["token.status", "hunt.poll"]);
      if (!NOISE.has(p.event)) {
        const summary = `[EVT ${p.platform}/${p.phase || "-"}] ${p.event}` +
                        (p.durationMs != null ? ` (${Math.round(p.durationMs)}ms)` : "");
        sendLog(summary, "blue");
      }
    } catch {}
  }

  if (msg.type === "BRIDGE_EVENT") {
    // Event từ injected scripts (network_hook, page_bridge) → relay tóm tắt
    try {
      const ev = msg.event || "";
      const d = msg.data || {};
      // Chỉ log event reserve-critical, skip noise
      const RELAY_EVENTS = [
        "hook.installed", "hook.error", "hook.enabled", "hook.disabled",
        "net.fetch.response", "net.xhr.response",
        "net.fetch.error", "net.xhr.error",
      ];
      if (RELAY_EVENTS.includes(ev)) {
        const summary = `[HOOK] ${ev}` +
          (d.url ? ` ${d.method || ""} ${String(d.url).slice(0, 80)} → ${d.status || ""}` : "") +
          (d.durationMs != null ? ` (${Math.round(d.durationMs)}ms)` : "");
        sendLog(summary, ev.includes("error") ? "yellow" : "gray");
      }
    } catch {}
  }

  if (msg.type === "PING") {
    fetchConfig().then(() => {
      sendResponse({ ok: true, appOnline: _appOnline });
    });
    return true;
  }

  if (msg.type === "RUN_IN_PAGE") {
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse({ error: "no tabId" }); return true; }
    runInPageContext(tabId, msg.fn, msg.args || {})
      .then(sendResponse)
      .catch(e => sendResponse({ error: String(e) }));
    return true;
  }

  if (msg.type === "GET_TAB_ID") {
    sendResponse({ tabId: sender.tab?.id });
    return;
  }

  if (msg.type === "DEBUG_LOCKS") {
    sendResponse({ injected: Object.fromEntries(_injected) });
    return;
  }

  // ── CDP Captcha handlers ──────────────────────────────────────────────────

  if (msg.type === "REINJECT_TAB") {
    const tabId = msg.tabId;
    if (!tabId) { sendResponse({ ok: false }); return true; }
    chrome.tabs.get(tabId, tab => {
      if (chrome.runtime.lastError || !tab?.url) {
        sendResponse({ ok: false });
        return;
      }
      // Xóa cache để injectTab không bị skip do dedup
      _injected.delete(tabId);
      // Clear hunt flag trước khi inject lại — tránh auto chạy seat khi reconnect
      chrome.scripting.executeScript({
        target: { tabId },
        func: () => { try { sessionStorage.removeItem("__svp_hunt_done__"); } catch {} },
      }).catch(() => {}).finally(() => {
        injectTab(tabId, tab.url)
          .then(() => sendResponse({ ok: true }))
          .catch(() => sendResponse({ ok: false }));
      });
    });
    return true;
  }

  if (msg.type === "CDP_CHECK_STATUS") {
    const tabId = msg.tabId || sender.tab?.id;
    sendResponse({ isConnected: tabId ? _cdpAttachedTabs.has(tabId) : false });
    return true;
  }

  if (msg.type === "CDP_ATTACH") {
    const tabId = msg.tabId || sender.tab?.id;
    if (!tabId) { sendResponse({ status: "error", reason: "no_tabId" }); return true; }
    if (_cdpAttachedTabs.has(tabId)) { sendResponse({ status: "connected" }); return true; }
    chrome.debugger.attach({ tabId }, "1.3", () => {
      if (chrome.runtime.lastError) {
        console.warn("⚠️ [CDP] Attach lỗi:", chrome.runtime.lastError.message);
        sendResponse({ status: "error", reason: chrome.runtime.lastError.message });
      } else {
        _cdpAttachedTabs.add(tabId);
        console.log(`⚡ [CDP] Đã attach tab ${tabId}`);
        sendResponse({ status: "connected" });
      }
    });
    return true;
  }

  if (msg.type === "CDP_DETACH") {
    const tabId = msg.tabId || sender.tab?.id;
    if (!tabId || !_cdpAttachedTabs.has(tabId)) { sendResponse({ status: "disconnected" }); return true; }
    chrome.debugger.detach({ tabId }, () => {
      _cdpAttachedTabs.delete(tabId);
      console.log(`💤 [CDP] Đã detach tab ${tabId}`);
      sendResponse({ status: "disconnected" });
    });
    return true;
  }

  if (msg.action === "drag_slider" || msg.action === "CDP_DRAG_SLIDER") {
    const tabId = sender.tab?.id;
    if (!tabId) return;
    const startX    = msg.startX    ?? msg.params?.startX    ?? 0;
    const startY    = msg.startY    ?? msg.params?.startY    ?? 0;
    const distanceX = msg.distanceX ?? msg.distance ?? msg.params?.distanceX ?? 0;
    console.log(`🤖 [CDP] Kéo: startX=${Math.round(startX)}, distance=${Math.round(distanceX)}`);

    const dodrag = () => _cdpDragSlider(tabId, startX, startY, distanceX);

    if (!_cdpAttachedTabs.has(tabId)) {
      chrome.debugger.attach({ tabId }, "1.3", () => {
        if (!chrome.runtime.lastError) {
          _cdpAttachedTabs.add(tabId);
          dodrag();
        } else {
          console.warn("⚠️ [CDP] Auto-attach lỗi:", chrome.runtime.lastError.message);
        }
      });
    } else {
      dodrag();
    }
    return;
  }

  sendResponse({ ok: false });
});

// ── Keyboard commands ─────────────────────────────────────────────────────────

chrome.commands.onCommand.addListener(async (command) => {
  const tabs = await chrome.tabs.query({
    active: true, currentWindow: true,
    url: ["https://ticket.1zone.vn/*", "https://ticketbox.vn/*"]
  });
  const tab = tabs[0];
  if (!tab) return;

  if (command === "hunt") {
    chrome.tabs.sendMessage(tab.id, { type: "HUNT_NOW" }).catch(() => {});
  } else if (command === "select_seat") {
    chrome.tabs.sendMessage(tab.id, { type: "RUN_NOW" }).catch(() => {});
  } else if (command === "fill_form") {
    chrome.tabs.sendMessage(tab.id, { type: "FILL_FORM_NOW" }).catch(() => {});
  }
});

// ── Init ──────────────────────────────────────────────────────────────────────

pollConfig();

// Inject vào các tab đang mở sẵn
chrome.tabs.query({ url: ["https://ticket.1zone.vn/*", "https://queue.1zone.vn/*", "https://ticketbox.vn/*"] })
  .then(tabs => tabs.forEach(tab => injectTab(tab.id, tab.url)));

console.log("[BG] Săn Vé Pro started — inject mode");