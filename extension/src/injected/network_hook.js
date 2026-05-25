// src/injected/network_hook.js
// CHẠY TRONG MAIN WORLD — patch window.fetch + XMLHttpRequest.prototype.send.
// Mọi request match url pattern → emit event qua page_bridge.
//
// Quy tắc (theo FLOW_GPT.md 5.3):
//   1. Hook tối thiểu — chỉ chặn URL khớp pattern.
//   2. Try/catch toàn bộ — không crash page nếu hook lỗi.
//   3. Kill switch qua window.__SVP_HOOK__.disable().
//   4. Hook chạy đồng bộ — không await trong onRequest.
//   5. onResponse luôn async, không block return của fetch.

(function() {
  if (window.__SVP_HOOK_INSTALLED__) return;
  window.__SVP_HOOK_INSTALLED__ = true;

  const bridge = window.__SVP_BRIDGE__;
  if (!bridge) {
    // page_bridge.js phải load trước. Nếu không có, vẫn install nhưng emit qua console fallback.
    console.warn("[SVP-HOOK] page_bridge not found, install standalone (no relay)");
  }

  function emit(event, data) {
    try {
      if (bridge && bridge.emit) bridge.emit(event, data);
    } catch {}
  }

  // ── Default patterns — chỉ hook URL match ────────────────────────────────────
  // Có thể update từ content script qua window.__SVP_HOOK__.setPatterns([...])
  const DEFAULT_PATTERNS = [
    // 1Zone
    /\/ticketing\/api\/v\d+\/order\/add-to-cart/i,
    /\/ticketing\/api\/v\d+\/event\/[^/]+\/question-form/i,
    /\/ticketing\/api\/v\d+\/event\/[^/]+\/payment-methods/i,
    /\/ticketing-payment\/api\/v\d+\/order\/create/i,
    /\/ticketing\/api\/v\d+\/ticket-summary\/get-summary-event/i,
    // Ticketbox
    /\/event\/api\/v\d+\/bookings\/submit-ticket-info/i,
    /\/event\/api\/v\d+\/bookings\/form-answers/i,
    /\/event\/api\/v\d+\/bookings\/submit-order-info/i,
    /\/event\/api\/v\d+\/bookings\/payment-methods/i,
    /\/event\/api\/v\d+\/events\/[^/]+\/question-form/i,
    /\/sapporo\/api\/v\d+\/capt\/(gen|check)/i,
    /\/gin\/api\/v\d+\/events\/\d+/i,
    /\/v\d+\/users\/login\/refresh_token/i,
    /\/v\d+\/users\/login\b/i,
  ];

  let _patterns = DEFAULT_PATTERNS.slice();
  let _enabled = true;
  // Callbacks set từ bridge (qua content script bằng cách bridge.emit("hook.set_callback", ...))
  let _onRequest = null;   // (url, method, body, headers) => modifiedBodyString | null
  let _onResponse = null;  // (url, status, responseText, durationMs) => void (async OK)

  function _matches(url) {
    try {
      return _patterns.some(re => re.test(String(url)));
    } catch {
      return false;
    }
  }

  function _safeText(v) {
    if (v == null) return "";
    if (typeof v === "string") return v;
    try { return JSON.stringify(v); } catch {}
    try { return String(v); } catch {}
    return "";
  }

  // ── Patch fetch ──────────────────────────────────────────────────────────────
  const _origFetch = window.fetch.bind(window);

  window.fetch = async function(input, init) {
    if (!_enabled) return _origFetch(input, init);

    let url = "";
    let method = "GET";
    let headers = {};
    let body = null;

    try {
      if (typeof input === "string") {
        url = input;
      } else if (input && typeof input === "object") {
        url = input.url || "";
        method = input.method || "GET";
      }
      if (init) {
        method = init.method || method;
        headers = init.headers || {};
        body = init.body != null ? init.body : null;
      }
    } catch {}

    const isMatch = _matches(url);

    // onRequest (sync) — cho phép mutate body
    if (isMatch && _onRequest) {
      try {
        const bodyText = _safeText(body);
        const newBody = _onRequest(url, method, bodyText, headers);
        if (newBody != null && init) {
          init = { ...init, body: newBody };
          body = newBody;
        }
      } catch (e) {
        emit("hook.error", { phase: "onRequest_fetch", err: String(e) });
      }
    }

    const t0 = performance.now();
    let res;
    try {
      res = await _origFetch(input, init);
    } catch (e) {
      if (isMatch) emit("net.fetch.error", { url, method, err: String(e) });
      throw e;
    }

    if (isMatch) {
      // Clone trước khi đọc text — không phá response gốc
      try {
        const clone = res.clone();
        clone.text().then(txt => {
          const durationMs = performance.now() - t0;
          emit("net.fetch.response", {
            url, method, status: res.status, durationMs, body: txt,
          });
          if (_onResponse) {
            try { _onResponse(url, res.status, txt, durationMs); } catch {}
          }
        }).catch(() => {});
      } catch {}
    }

    return res;
  };

  // ── Patch XMLHttpRequest ─────────────────────────────────────────────────────
  const _OrigXHR = window.XMLHttpRequest;
  const _origOpen = _OrigXHR.prototype.open;
  const _origSend = _OrigXHR.prototype.send;
  const _origSetHeader = _OrigXHR.prototype.setRequestHeader;

  _OrigXHR.prototype.open = function(method, url) {
    try {
      this.__svp_url = url;
      this.__svp_method = method;
      this.__svp_headers = {};
    } catch {}
    return _origOpen.apply(this, arguments);
  };

  _OrigXHR.prototype.setRequestHeader = function(name, value) {
    try {
      if (this.__svp_headers) this.__svp_headers[name] = value;
    } catch {}
    return _origSetHeader.apply(this, arguments);
  };

  _OrigXHR.prototype.send = function(body) {
    if (!_enabled) return _origSend.apply(this, arguments);

    const url = this.__svp_url || "";
    const method = this.__svp_method || "GET";
    const headers = this.__svp_headers || {};
    const isMatch = _matches(url);

    // onRequest (sync) — mutate body
    if (isMatch && _onRequest) {
      try {
        const bodyText = _safeText(body);
        const newBody = _onRequest(url, method, bodyText, headers);
        if (newBody != null) {
          body = newBody;
          arguments[0] = newBody;
        }
      } catch (e) {
        emit("hook.error", { phase: "onRequest_xhr", err: String(e) });
      }
    }

    if (isMatch) {
      const t0 = performance.now();
      const self = this;
      this.addEventListener("loadend", function() {
        const durationMs = performance.now() - t0;
        let respText = "";
        try {
          // responseType có thể là json/blob/arraybuffer
          if (self.responseType === "" || self.responseType === "text") {
            respText = self.responseText || "";
          } else if (self.responseType === "json") {
            try { respText = JSON.stringify(self.response); } catch {}
          }
        } catch {}

        emit("net.xhr.response", {
          url, method, status: self.status, durationMs, body: respText,
        });
        if (_onResponse) {
          try { _onResponse(url, self.status, respText, durationMs); } catch {}
        }
      });
      this.addEventListener("error", function() {
        emit("net.xhr.error", { url, method });
      });
    }

    return _origSend.apply(this, arguments);
  };

  // ── Public API ───────────────────────────────────────────────────────────────
  window.__SVP_HOOK__ = {
    version: "1.0.0",
    patches: { fetch: true, xhr: true },

    enable()  { _enabled = true;  emit("hook.enabled", {}); },
    disable() { _enabled = false; emit("hook.disabled", {}); },
    status()  { return { enabled: _enabled, patterns: _patterns.map(String) }; },

    setPatterns(patterns) {
      try {
        _patterns = patterns.map(p => p instanceof RegExp ? p : new RegExp(p, "i"));
        emit("hook.patterns_updated", { count: _patterns.length });
      } catch (e) {
        emit("hook.error", { phase: "setPatterns", err: String(e) });
      }
    },

    setOnRequest(fn)  { _onRequest = typeof fn === "function" ? fn : null; },
    setOnResponse(fn) { _onResponse = typeof fn === "function" ? fn : null; },

    emit, // expose để các injected script khác emit qua bridge
  };

  emit("hook.installed", { version: "1.0.0", patternCount: _patterns.length });
})();
