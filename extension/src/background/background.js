// src/background/background.js
// Singleton — inject content scripts 1 lần duy nhất per tab navigation

const API_PORT = 9279;
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const CONFIG_POLL_MS = 3000;

const CONTENT_SCRIPTS = [
  "src/content/utils.js",
  "src/content/api.js",
  "src/content/zone_matcher.js",
  "src/content/konva_clicker.js",
  "src/content/hunt_1zone.js",
  "src/content/hunt_ticketbox.js",
  "src/content/seat_1zone_zone.js",
  "src/content/seat_1zone_map.js",
  "src/content/seat_ticketbox_zone.js",
  "src/content/seat_ticketbox_map.js",
  "src/content/form_filler.js",
  "src/content/runner.js",
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
  // Kiểm tra URL có phải target không
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

chrome.webNavigation.onCommitted.addListener(({ tabId, url, frameId }) => {
  if (frameId !== 0) return; // chỉ main frame
  const isTarget = TARGET_URLS.some(t => url.startsWith(t));
  if (!isTarget) return;
  // URL mới → xóa cache inject cũ để inject lại
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
    const res = await fetch(`${API_BASE}/config`, {
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
    await fetch(`${API_BASE}/log`, {
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
    chrome.tabs.sendMessage(tab.id, { type: "HUNT_ONLY" }).catch(() => {});
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
