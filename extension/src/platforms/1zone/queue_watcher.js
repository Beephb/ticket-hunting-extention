// src/platforms/1zone/queue_watcher.js
// Chạy trong ISOLATED world — nhận postMessage từ queue_hook_main.js
// Xử lý prequeue → queue → detect redirect → follow redirect

(function () {
  if (window.__SVP_1Z_WATCHER_ISOLATED__) return;
  window.__SVP_1Z_WATCHER_ISOLATED__ = true;

  // BUG cũ: key cố định cho MỌI event — hunt event A xong, trong vòng 10 phút
  // chuyển sang hunt event B khác sẽ bị "loadZonesCache() thấy có cache" (thực
  // ra là cache của A) → skip fetch zones thật của B → dùng nhầm data event cũ
  // (sai zone ID, giá, tình trạng còn/hết vé) cho toàn bộ logic chọn ghế của B.
  // Giờ: key gồm eventId+calendarId, mỗi event có ô cache riêng.
  const ZONES_CACHE_KEY_PREFIX = "__svp_1z_zones_cache__";
  function _zonesCacheKey(eventId, calendarId) {
    return `${ZONES_CACHE_KEY_PREFIX}:${eventId || ""}:${calendarId || ""}`;
  }
  const ZONES_CACHE_TTL = 10 * 60 * 1000; // 10 phút
  const API_BASE = "https://prod.1zone.vn/ticketing/api";

  let _redirectFollowed = false;
  let _phase = "prequeue"; // "prequeue" | "queue" | "done"

  // ── Indicator UI ─────────────────────────────────────────────────────────────

  const INDICATOR_ID = "__svp_q_indicator__";

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
        box-shadow:0 4px 20px rgba(0,0,0,0.4);
        animation:__svp_q_fadein .3s ease;
      }
      @keyframes __svp_q_fadein{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      #${INDICATOR_ID} .qi-row{display:flex;align-items:center;gap:8px;}
      #${INDICATOR_ID} .qi-dot{width:8px;height:8px;border-radius:50%;flex-shrink:0;}
      #${INDICATOR_ID} .qi-title{font-size:12px;font-weight:600;color:#e2e8f0;flex:1;}
      #${INDICATOR_ID} .qi-sub{font-size:10px;color:#64748b;margin-top:3px;line-height:1.4;}
    `;
    document.head.appendChild(style);

    el = document.createElement("div");
    el.id = INDICATOR_ID;
    el.innerHTML = `
      <div class="qi-row">
        <div class="qi-dot" id="__svp_q_dot__"></div>
        <div class="qi-title" id="__svp_q_title__">Săn Vé Pro</div>
      </div>
      <div class="qi-sub" id="__svp_q_sub__"></div>
    `;
    document.body.appendChild(el);
    return el;
  }

  function showIndicator(title, sub, color) {
    _getOrCreateIndicator();
    const dot = document.getElementById("__svp_q_dot__");
    const t   = document.getElementById("__svp_q_title__");
    const s   = document.getElementById("__svp_q_sub__");
    const el  = document.getElementById(INDICATOR_ID);
    if (el)  el.style.borderColor = (color || "#1e293b") + "88";
    if (dot) dot.style.background = color || "#64748b";
    if (t)   t.textContent = title;
    if (s)   s.textContent = sub || "";
  }

  // ── Log ──────────────────────────────────────────────────────────────────────

  function qLog(msg, color = "blue") {
    if (typeof svpLog === "function") svpLog(msg, color);
    else console.log(`[SVP-Q] ${msg}`);
    try {
      chrome.runtime.sendMessage({ type: "LOG", msg: `[1Z-Q] ${msg}`, color }).catch?.(() => {});
    } catch {}
  }

  // ── Zones cache (chrome.storage.session — share cross-domain) ────────────────

  async function saveZonesCache(eventId, calendarId, data) {
    try {
      await chrome.storage.session.set({
        [_zonesCacheKey(eventId, calendarId)]: { ts: Date.now(), data }
      });
      qLog("✅ Zones cached vào chrome.storage.session", "green");
    } catch (e) {
      qLog(`⚠️ Không lưu zones cache: ${e.message}`, "yellow");
    }
  }

  async function loadZonesCache(eventId, calendarId) {
    try {
      const key = _zonesCacheKey(eventId, calendarId);
      const result = await chrome.storage.session.get(key);
      const obj = result?.[key];
      if (!obj) return null;
      if (Date.now() - obj.ts > ZONES_CACHE_TTL) {
        await chrome.storage.session.remove(key);
        return null;
      }
      return obj.data;
    } catch { return null; }
  }

  // ── Extract eventId + calendarId từ URL ───────────────────────────────────────

  function extractQueueInfo() {
    const params = new URLSearchParams(location.search);
    const targetUrl = params.get("t") || "";
    const eventId = params.get("e") || "";
    let calendarId = "";
    try {
      calendarId = new URL(targetUrl).searchParams.get("calendarId") || "";
    } catch {}
    return { eventId, calendarId, targetUrl };
  }

  // ── Fetch zones trong background ──────────────────────────────────────────────

  async function fetchAndCacheZones(eventId, calendarId) {
    if (!eventId || !calendarId) {
      qLog("⚠️ Thiếu eventId/calendarId — skip fetch zones", "yellow");
      return;
    }
    if (await loadZonesCache(eventId, calendarId)) {
      qLog("📦 Zones đã có cache — skip fetch", "blue");
      return;
    }
    try {
      qLog(`📡 Fetch zones: ${eventId} / ${calendarId}`, "blue");
      const url = `${API_BASE}/v4/ticket-summary/get-summary-event/${eventId}/zones?calendarId=${encodeURIComponent(calendarId)}`;
      const res = await fetch(url, {
        credentials: "include",
        headers: { "Accept": "application/json", "x-accept-language": "vi" },
        signal: AbortSignal.timeout(6000),
      });
      if (!res.ok) { qLog(`⚠️ Zones API ${res.status}`, "yellow"); return; }
      saveZonesCache(eventId, calendarId, await res.json());
    } catch (e) {
      qLog(`⚠️ Fetch zones lỗi: ${e.message}`, "yellow");
    }
  }

  // ── Xử lý status data ────────────────────────────────────────────────────────

  function onStatusReceived(data) {
    if (_redirectFollowed) return;

    const isBeforeOrIdle = data?.isBeforeOrIdle;
    const redirectUrl    = data?.redirectUrl || data?.targetUrl;
    const isReady        = data?.isClientReadyToRedirect || data?.isClientRedayToRedirect;

    // Prequeue → Queue
    if (isBeforeOrIdle === false && _phase === "prequeue") {
      _phase = "queue";
      qLog("🟡 Đã vào hàng chờ!", "yellow");
      showIndicator("🟡 Đang trong hàng chờ...", "Bot sẵn sàng — chờ đến lượt", "#facc15");
    }

    // Queue pass → redirect
    if (isReady === true && redirectUrl && redirectUrl.includes("ticket.1zone.vn")) {
      _redirectFollowed = true;
      _phase = "done";
      qLog(`🚀 Queue pass! → ${redirectUrl.slice(0, 80)}`, "green");
      showIndicator("🟢 Đã đến lượt!", "Đang vào trang mua vé...", "#22c55e");
      setTimeout(() => { window.location.href = redirectUrl; }, 50);
    }
  }

  // ── Detect phase từ DOM ───────────────────────────────────────────────────────

  function detectPhaseFromDom() {
    const txt = (document.body?.innerText || "").toLowerCase();
    if (
      txt.includes("sự kiện sẽ mở bán") ||
      txt.includes("trang sẽ tự động") ||
      document.querySelector("[class*='before']") ||
      document.querySelector("[id*='before']")
    ) return "prequeue";

    if (
      txt.includes("hàng chờ") ||
      txt.includes("số thứ tự") ||
      txt.includes("you are number") ||
      document.querySelector("[class*='queue-number']")
    ) return "queue";

    return "prequeue";
  }

  // ── Main init ────────────────────────────────────────────────────────────────

  async function init() {
    if (document.readyState === "loading") {
      await new Promise(r => document.addEventListener("DOMContentLoaded", r, { once: true }));
    }

    const info = extractQueueInfo();
    qLog(`🎯 Queue watcher init | eventId=${info.eventId} calendarId=${info.calendarId}`, "blue");

    _phase = detectPhaseFromDom();
    qLog(`📍 Phase: ${_phase}`, "blue");

    if (_phase === "prequeue") {
      showIndicator("⏳ Đang chờ mở bán...", "Bot sẵn sàng — chờ đến giờ", "#64748b");
    } else {
      showIndicator("🟡 Đang trong hàng chờ...", "Bot sẵn sàng — chờ đến lượt", "#facc15");
    }

    // Fetch zones trong background
    fetchAndCacheZones(info.eventId, info.calendarId);

    // ── Nhận postMessage từ MAIN world (queue_hook_main.js) ──────────────────
    window.addEventListener("message", (e) => {
      if (e.source !== window) return;
      if (e.data?.__svp_type !== "QUEUE_STATUS") return;
      onStatusReceived(e.data.data);
    });

    // ── MutationObserver detect DOM thay đổi prequeue → queue ────────────────
    const observer = new MutationObserver(() => {
      if (_redirectFollowed) { observer.disconnect(); return; }
      const newPhase = detectPhaseFromDom();
      if (newPhase === "queue" && _phase === "prequeue") {
        _phase = "queue";
        qLog("🟡 DOM: chuyển sang queue!", "yellow");
        showIndicator("🟡 Đang trong hàng chờ...", "Bot sẵn sàng — chờ đến lượt", "#facc15");
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    qLog("✅ Queue watcher sẵn sàng", "green");
  }

  init().catch(e => console.error("[SVP-Q] Init lỗi:", e));
})();