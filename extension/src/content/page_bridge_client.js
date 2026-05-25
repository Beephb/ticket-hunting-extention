// src/content/page_bridge_client.js
// Content script (isolated world). Lắng nghe postMessage từ injected scripts (MAIN world).
// Forward event qua background → desktop log.

(function() {
  if (window.__SVP_BRIDGE_CLIENT_INSTALLED__) return;
  window.__SVP_BRIDGE_CLIENT_INSTALLED__ = true;

  const SOURCE = "SVP_BRIDGE";
  const _handlers = new Map(); // event name → array of callback

  function on(event, cb) {
    if (!_handlers.has(event)) _handlers.set(event, []);
    _handlers.get(event).push(cb);
    return () => off(event, cb);
  }

  function off(event, cb) {
    const arr = _handlers.get(event);
    if (!arr) return;
    const i = arr.indexOf(cb);
    if (i >= 0) arr.splice(i, 1);
  }

  function _dispatch(event, data) {
    const arr = _handlers.get(event);
    if (!arr) return;
    for (const cb of arr) {
      try { cb(data); } catch (e) {
        console.warn("[SVP-BRIDGE-CLIENT] handler error", event, e);
      }
    }
  }

  // DEBUG flag — bật khi cần trace từng step bridge message
  // Khi prod để false để tránh noise console + perf.
  const DEBUG = false;
  if (DEBUG) console.log("[SVP-CLIENT-DEBUG] mounted, listener attached");

  // ── Receive postMessage from injected scripts ────────────────────────────────
  // NOTE: KHÔNG check ev.source === window. Trong MV3 isolated world, message
  // từ MAIN world có ev.source là WindowProxy của page, không identity-equal với
  // window reference của content script qua V8 boundary. Filter source bằng
  // msg.source === "SVP_BRIDGE" là đủ (chỉ inject scripts của ta mới gửi key này).
  window.addEventListener("message", (ev) => {
    try {
      const msg = ev.data;
      if (DEBUG && msg?.source === SOURCE) {
        console.log("[SVP-CLIENT-DEBUG] received:", msg.event, msg.data);
      }
      if (!msg || typeof msg !== "object" || msg.source !== SOURCE) return;

      const { event, data } = msg;
      _dispatch(event, data);

      // Forward toàn bộ event lên background dạng structured log
      // (background sẽ relay về desktop /log)
      _forwardToBackground(event, data);
    } catch (e) {
      if (DEBUG) console.warn("[SVP-CLIENT-DEBUG] listener error:", e);
    }
  }, false);

  function _forwardToBackground(event, data) {
    // Skip noise events (high-volume) — chỉ forward event quan trọng
    const NOISE_EVENTS = new Set(["bridge.ready"]);
    if (NOISE_EVENTS.has(event)) return;

    try {
      // Mask data nếu có
      const safeData = window.SVP_MASK ? window.SVP_MASK.maskPayload(data) : data;

      chrome.runtime.sendMessage({
        type: "BRIDGE_EVENT",
        event,
        data: safeData,
        ts: Date.now(),
      }, (resp) => {
        // Capture sendMessage callback để bắt error
        if (chrome.runtime.lastError) {
          if (DEBUG) console.warn("[SVP-CLIENT-DEBUG] sendMessage err:", chrome.runtime.lastError.message);
        } else if (DEBUG) {
          console.log("[SVP-CLIENT-DEBUG] forwarded:", event);
        }
      });
    } catch (e) {
      if (DEBUG) console.warn("[SVP-CLIENT-DEBUG] forward exception:", e);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  window.__SVP_BRIDGE_CLIENT__ = {
    on,
    off,
    version: "1.0.0",
  };

  // Auto-register: nhận event "hook.installed" → log
  on("hook.installed", (data) => {
    if (window.svpLog) window.svpLog(`🪝 Network hook installed (patterns=${data?.patternCount})`, "blue");
  });
  on("hook.error", (data) => {
    if (window.svpLog) window.svpLog(`⚠️ Hook error: ${data?.phase} ${data?.err}`, "yellow");
  });
})();
