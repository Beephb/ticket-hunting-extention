// src/platforms/1zone/xhr_intercept.js
// 1Zone XHR/fetch response capture.
//
// Listen bridge events từ injected/network_hook.js (chạy MAIN world), filter
// theo URL pattern 1Zone, parse body, lưu vào module state. Expose public API
// cho seat_zone.js + seat_map.js để chờ orderId mà không cần poll URL.
//
// Pattern hook:
//   POST /ticketing/api/v3/order/add-to-cart      → orderId (data._id)
//   GET  /ticketing/api/v4/event/.../question-form → form schema
//   GET  /ticketing/api/v4/event/.../payment-methods → gateway list
//   POST /ticketing-payment/api/v2/order/create    → final redirect URL
//
// State trong module này — không persist qua page reload.

(function() {
  if (window.__SVP_1Z_CAPTURE__) return;

  const _state = {
    // Reserve flow
    lastOrderId: null,
    lastReserveResponse: null,  // {url, status, body, ts, parsed}
    lastReserveError: null,     // {errorCode, message, status}

    // Checkout flow (Stage 4+ sẽ dùng)
    lastQuestionForm: null,
    lastPaymentMethods: null,
    lastOrderCreate: null,

    // Waiters for reserve completion
    _reserveWaiters: [],
  };

  // ── URL matchers ─────────────────────────────────────────────────────────────
  const RE_ADD_TO_CART     = /\/ticketing\/api\/v\d+\/order\/add-to-cart/;
  const RE_QUESTION_FORM   = /\/ticketing\/api\/v\d+\/event\/[^/]+\/question-form/;
  const RE_PAYMENT_METHODS = /\/ticketing\/api\/v\d+\/event\/[^/]+\/payment-methods/;
  const RE_ORDER_CREATE    = /\/ticketing-payment\/api\/v\d+\/order\/create/;

  // ── Response handler ─────────────────────────────────────────────────────────
  function _onResponse(data) {
    if (!data || !data.url) return;
    const { url, status, body } = data;

    if (RE_ADD_TO_CART.test(url)) {
      _handleAddToCart(url, status, body);
    } else if (RE_QUESTION_FORM.test(url)) {
      _state.lastQuestionForm = { url, status, body, ts: Date.now() };
    } else if (RE_PAYMENT_METHODS.test(url)) {
      _state.lastPaymentMethods = { url, status, body, ts: Date.now() };
    } else if (RE_ORDER_CREATE.test(url)) {
      _state.lastOrderCreate = { url, status, body, ts: Date.now() };
      _tryLogOrderCreate(body);
    }
  }

  function _handleAddToCart(url, status, body) {
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}
    _state.lastReserveResponse = { url, status, body, ts: Date.now(), parsed };

    const orderId = parsed?.data?._id || parsed?.data?.orderId || null;
    const isSuccess = status >= 200 && status < 300 && parsed?.errorCode === 0 && !!orderId;

    let resolved;
    if (isSuccess) {
      _state.lastOrderId = orderId;
      _state.lastReserveError = null;
      resolved = {
        success: true,
        orderId,
        ticket: parsed.data,
        raw: parsed,
        status,
      };
      if (window.svpLog) {
        window.svpLog(`🎯 1Zone reserve OK — orderId=${orderId}`, "green");
      }
      // Emit structured event cho desktop UI
      if (window.svpEvent) {
        try {
          // Extract showing info từ URL hoặc location
          const urlMatch = url.match(/eventId=([^&]+)/) || [];
          const calIdMatch = location.search.match(/calendarId=([^&]+)/) || [];
          const tickets = parsed?.data?.tickets || [];
          window.svpEvent("reserve.success", {
            platform: "1zone",
            mode: tickets[0]?.objectId ? "map" : "zone",
            orderId,
            showingId: calIdMatch[1] || "",
            eventId: urlMatch[1] || tickets[0]?.eventId || "",
            zoneName: tickets[0]?.zoneName || "",
            quantity: tickets[0]?.quantity || 1,
            method: "tier-p",
            checkoutUrl: `https://ticket.1zone.vn/checkout?orderId=${orderId}&calendarId=${calIdMatch[1] || ""}`,
          });
        } catch {}
      }
    } else {
      _state.lastOrderId = null;
      _state.lastReserveError = {
        errorCode: parsed?.errorCode ?? null,
        message: parsed?.message ?? "(no message)",
        status,
      };
      resolved = {
        success: false,
        orderId: null,
        error: _state.lastReserveError,
        status,
        raw: parsed,
      };
      if (window.svpLog) {
        const msg = parsed?.message || body?.slice(0, 120) || "(empty)";
        window.svpLog(`❌ 1Zone reserve FAIL — status=${status} errorCode=${parsed?.errorCode} msg=${msg}`, "red");
      }
    }

    // Notify waiters
    const waiters = _state._reserveWaiters.splice(0);
    for (const w of waiters) {
      try { w.resolve(resolved); } catch {}
    }
  }

  function _tryLogOrderCreate(body) {
    try {
      const parsed = JSON.parse(body);
      if (parsed?.errorCode === 0 && parsed?.data) {
        if (window.svpLog) {
          window.svpLog(`💳 1Zone order/create OK — redirect ready`, "green");
        }
      }
    } catch {}
  }

  // ── Register bridge listeners ────────────────────────────────────────────────
  function _setupListeners(retry = 0) {
    if (!window.__SVP_BRIDGE_CLIENT__) {
      if (retry < 50) {
        setTimeout(() => _setupListeners(retry + 1), 100);
      } else if (window.svpLog) {
        window.svpLog("⚠️ 1Z capture: bridge client không sẵn sàng sau 5s", "yellow");
      }
      return;
    }
    const client = window.__SVP_BRIDGE_CLIENT__;
    client.on("net.xhr.response", _onResponse);
    client.on("net.fetch.response", _onResponse);
    if (window.svpLog) {
      window.svpLog("📡 1Zone XHR capture ready (add-to-cart + question-form + payment + order/create)", "blue");
    }
  }
  _setupListeners();

  // ── Public API ───────────────────────────────────────────────────────────────
  window.__SVP_1Z_CAPTURE__ = {
    /**
     * Wait for next add-to-cart response. Resolves with:
     *   {success: true, orderId, ticket, raw, status}    — reserve OK
     *   {success: false, error, raw, status}             — server reject
     *   null                                              — timeout
     *
     * Cách dùng:
     *   capture.clearReserveCache();              // BEFORE click
     *   const p = capture.waitForOrderId(8000);
     *   clickTiepTuc();
     *   const r = await p;
     */
    waitForOrderId(timeoutMs = 8000) {
      // Nếu đã có response từ trước → return ngay
      if (_state.lastReserveResponse) {
        const resp = _state.lastReserveResponse;
        if (_state.lastOrderId) {
          return Promise.resolve({
            success: true,
            orderId: _state.lastOrderId,
            ticket: resp.parsed?.data,
            raw: resp.parsed,
            status: resp.status,
          });
        } else if (_state.lastReserveError) {
          return Promise.resolve({
            success: false,
            error: _state.lastReserveError,
            raw: resp.parsed,
            status: resp.status,
          });
        }
      }

      return new Promise((resolve) => {
        const waiter = { resolve };
        _state._reserveWaiters.push(waiter);
        setTimeout(() => {
          const i = _state._reserveWaiters.indexOf(waiter);
          if (i >= 0) {
            _state._reserveWaiters.splice(i, 1);
            resolve(null);
          }
        }, timeoutMs);
      });
    },

    /** Clear reserve cache trước khi click "Tiếp tục" — bắt buộc. */
    clearReserveCache() {
      _state.lastOrderId = null;
      _state.lastReserveResponse = null;
      _state.lastReserveError = null;
      // Giữ question-form/payment-methods/order-create vì preload data dùng cho Stage 4+
    },

    getLastOrderId()        { return _state.lastOrderId; },
    getLastReserveResponse(){ return _state.lastReserveResponse; },
    getLastReserveError()   { return _state.lastReserveError; },
    getLastQuestionForm()   { return _state.lastQuestionForm; },
    getLastPaymentMethods() { return _state.lastPaymentMethods; },
    getLastOrderCreate()    { return _state.lastOrderCreate; },

    _state, // debug
  };
})();
