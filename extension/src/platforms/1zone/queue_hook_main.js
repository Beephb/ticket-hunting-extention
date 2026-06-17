// src/platforms/1zone/queue_hook_main.js
// Chạy trong MAIN world — hook fetch/XHR để bắt Queue-it status response
// Bridge sang isolated world bằng postMessage

(function () {
  if (window.__SVP_Q_HOOK__) return;
  window.__SVP_Q_HOOK__ = true;

  const STATUS_RE = /\/spa-api\/queue\/eventista\/[^/]+\/[^/]+\/status/i;

  // ── Hook fetch ───────────────────────────────────────────────────────────────
  const origFetch = window.fetch;
  window.fetch = async function (...args) {
    const url = typeof args[0] === "string" ? args[0] : (args[0]?.url || "");
    const res = await origFetch.apply(this, args);

    if (STATUS_RE.test(url)) {
      try {
        res.clone().json().then(data => {
          window.postMessage({ __svp_type: "QUEUE_STATUS", data }, "*");
        }).catch(() => {});
      } catch {}
    }
    return res;
  };

  // ── Hook XHR ────────────────────────────────────────────────────────────────
  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this.__svp_url = url;
    return origOpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    if (STATUS_RE.test(this.__svp_url || "")) {
      this.addEventListener("load", () => {
        try {
          const data = JSON.parse(this.responseText);
          window.postMessage({ __svp_type: "QUEUE_STATUS", data }, "*");
        } catch {}
      });
    }
    return origSend.apply(this, args);
  };

  console.log("[SVP-MAIN] Queue hook installed ✅");
})();
