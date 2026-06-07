// src/background/background.js
// Singleton — inject content scripts 1 lần duy nhất per tab navigation

const API_PORT = 9279;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const CONFIG_POLL_MS = 3000;

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
  "src/platforms/1zone/seat_zone.js",
  "src/platforms/1zone/seat_map.js",
  "src/platforms/ticketbox/seat_zone.js",
  "src/platforms/ticketbox/seat_map.js",
  // Tier 3 — shared form filler
  "src/content/form_filler.js",
  // Tier 4 — entry orchestrator
  "src/content/runner.js",
];

// MAIN world scripts (chạy trong page context — bypass isolated world cho XHR/fetch hook)
const MAIN_WORLD_SCRIPTS = [
  "src/injected/page_bridge.js",
  "src/injected/network_hook.js",
];

const TARGET_URLS = [
  "https://ticket.1zone.vn/",
  "https://ticketbox.vn/",
];

// Tab nào đã được inject rồi (key: tabId, value: url đã inject)
const _injected = new Map();

let _cachedConfig = null;
let _appOnline = false;

// ── Inject content scripts vào tab ───────────────────────────────────────────

async function injectTab(tabId, url) {
  const isTarget = TARGET_URLS.some(t => url.startsWith(t));
  if (!isTarget) return;

  // Đã inject cho URL này rồi → skip
  if (_injected.get(tabId) === url) {
    console.log(`[BG] Tab ${tabId} đã inject cho ${url.slice(0,50)} — skip`);
    return;
  }

  console.log(`[BG] Inject tab ${tabId}: ${url.slice(0,60)}`);
  _injected.set(tabId, url);

  try {
    // 1) Inject MAIN world scripts TRƯỚC (page_bridge → network_hook)
    //    Hook phải sẵn sàng trước khi content scripts dispatch action.
    await chrome.scripting.executeScript({
      target: { tabId },
      world: "MAIN",
      files: MAIN_WORLD_SCRIPTS,
    });

    // 2) Inject content scripts (isolated world)
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
  } catch (e) {
    console.log(`[BG] ❌ Inject lỗi tab ${tabId}: ${e.message}`);
    _injected.delete(tabId);
  }
}

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
    { hostSuffix: "ticketbox.vn" },
  ]
});

// Xóa inject cache khi tab đóng
chrome.tabs.onRemoved.addListener(tabId => {
  _injected.delete(tabId);
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
        config: _cachedConfig,
      }).catch(() => {});
    }
  }
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
    if (_cachedConfig) {
      sendResponse({ ok: true, config: _cachedConfig, appOnline: _appOnline });
    } else {
      fetchConfig().then(cfg => {
        sendResponse({ ok: !!cfg, config: cfg, appOnline: _appOnline });
      });
      return true;
    }
  }

  if (msg.type === "LOG") {
    sendLog(msg.msg, msg.color);
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
chrome.tabs.query({ url: ["https://ticket.1zone.vn/*", "https://ticketbox.vn/*"] })
  .then(tabs => tabs.forEach(tab => injectTab(tab.id, tab.url)));

console.log("[BG] Săn Vé Pro started — inject mode");