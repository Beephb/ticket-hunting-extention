// src/injected/page_bridge.js
// CHẠY TRONG MAIN WORLD (page context, không phải content script isolated world).
// Cầu nối giữa page context và content script qua window.postMessage.
//
// Content script lắng nghe qua window.addEventListener("message", ...)
// chỉ accept message có source === "SVP_BRIDGE".

(function() {
  if (window.__SVP_BRIDGE_INSTALLED__) return;
  window.__SVP_BRIDGE_INSTALLED__ = true;

  const SOURCE = "SVP_BRIDGE";

  function emit(event, data) {
    try {
      window.postMessage({ source: SOURCE, event, data, ts: Date.now() }, "*");
    } catch (e) {
      // Không log gì — tránh ảnh hưởng page
    }
  }

  // Expose minimal API cho injected scripts khác (như network_hook.js) dùng
  window.__SVP_BRIDGE__ = {
    source: SOURCE,
    emit,
    version: "1.0.0",
  };

  // Báo content script: bridge ready
  emit("bridge.ready", { ts: Date.now() });
})();
