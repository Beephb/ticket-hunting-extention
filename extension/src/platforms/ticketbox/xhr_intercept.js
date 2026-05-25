// src/platforms/ticketbox/xhr_intercept.js
// Ticketbox XHR/fetch response capture.
//
// Listen bridge events từ injected/network_hook.js, filter URL Ticketbox,
// parse body, lưu module state. Expose API cho seat_*.js + reserve_api.js
// + token_manager.js.
//
// URL patterns:
//   POST /v1/users/login                     → user login (cookie + token init)
//   POST /v1/users/login/refresh_token       → refresh access_token (TTL 120s)
//   GET  /sapporo/api/v2/capt/gen/{showing}  → captcha image + slide puzzle
//   POST /sapporo/api/v2/capt/check/{show}   → captcha verify → captcha_token
//   POST /event/api/v1/bookings/submit-ticket-info → reserve → bookingCode
//   GET  /event/api/v1/events/{eventId}/question-form
//   POST /event/api/v1/bookings/form-answers
//   GET  /event/api/v1/bookings/payment-methods
//   POST /event/api/v1/bookings/submit-order-info → redirect URL thanh toán

(function() {
  if (window.__SVP_TB_CAPTURE__) return;

  const _state = {
    // Token flow
    lastLogin: null,
    lastRefreshToken: null,   // {url, status, body, ts, parsed, requestBody}

    // Captcha flow
    lastCaptchaGen: null,     // {showingId, image, thumb, key, ts}
    lastCaptchaCheck: null,   // {captchaToken, ts}

    // Reserve flow
    lastSubmitTicketInfo: null,  // {url, status, body, ts, parsed, bookingCode}
    lastReserveError: null,

    // Checkout flow
    lastQuestionForm: null,
    lastFormAnswers: null,
    lastPaymentMethods: null,
    lastSubmitOrderInfo: null,   // {redirectUrl}

    // Waiters for reserve
    _reserveWaiters: [],
    _captchaWaiters: [],
  };

  // ── URL matchers ─────────────────────────────────────────────────────────────
  const RE_LOGIN          = /\/v\d+\/users\/login(?:\?|$)/;
  const RE_REFRESH_TOKEN  = /\/v\d+\/users\/login\/refresh_token/;
  const RE_CAPTCHA_GEN    = /\/sapporo\/api\/v\d+\/capt\/gen\/([^/?]+)/;
  const RE_CAPTCHA_CHECK  = /\/sapporo\/api\/v\d+\/capt\/check\/([^/?]+)/;
  const RE_SUBMIT_TICKET  = /\/event\/api\/v\d+\/bookings\/submit-ticket-info/;
  const RE_QUESTION_FORM  = /\/event\/api\/v\d+\/events\/[^/]+\/question-form/;
  const RE_FORM_ANSWERS   = /\/event\/api\/v\d+\/bookings\/form-answers/;
  const RE_PAYMENT_METHODS= /\/event\/api\/v\d+\/bookings\/payment-methods/;
  const RE_SUBMIT_ORDER   = /\/event\/api\/v\d+\/bookings\/submit-order-info/;

  // ── Response handler ─────────────────────────────────────────────────────────
  function _onResponse(data) {
    if (!data || !data.url) return;
    const { url, status, body } = data;
    let parsed = null;
    try { parsed = JSON.parse(body); } catch {}

    if (RE_REFRESH_TOKEN.test(url)) {
      _handleRefreshToken(url, status, body, parsed);
    } else if (RE_LOGIN.test(url)) {
      _handleLogin(url, status, body, parsed);
    } else if (RE_CAPTCHA_GEN.test(url)) {
      _handleCaptchaGen(url, status, body, parsed);
    } else if (RE_CAPTCHA_CHECK.test(url)) {
      _handleCaptchaCheck(url, status, body, parsed);
    } else if (RE_SUBMIT_TICKET.test(url)) {
      _handleSubmitTicketInfo(url, status, body, parsed);
    } else if (RE_QUESTION_FORM.test(url)) {
      _state.lastQuestionForm = { url, status, body, parsed, ts: Date.now() };
    } else if (RE_FORM_ANSWERS.test(url)) {
      _state.lastFormAnswers = { url, status, body, parsed, ts: Date.now() };
    } else if (RE_PAYMENT_METHODS.test(url)) {
      _state.lastPaymentMethods = { url, status, body, parsed, ts: Date.now() };
    } else if (RE_SUBMIT_ORDER.test(url)) {
      _handleSubmitOrder(url, status, body, parsed);
    }
  }

  function _handleLogin(url, status, body, parsed) {
    _state.lastLogin = { url, status, body, parsed, ts: Date.now() };
    if (window.svpLog) {
      window.svpLog(`🔐 TB login response status=${status}`, status === 200 ? "green" : "yellow");
    }
  }

  function _handleRefreshToken(url, status, body, parsed) {
    _state.lastRefreshToken = { url, status, body, parsed, ts: Date.now() };
    if (window.svpLog) {
      // Important — Stage 4.2 cần log này để biết format
      const tokenLen = parsed?.data?.token?.length || parsed?.data?.accessToken?.length || 0;
      const ec = parsed?.errorCode ?? parsed?.code ?? "?";
      window.svpLog(`🔄 TB refresh_token status=${status} errorCode=${ec} tokenLen=${tokenLen}`,
        status === 200 ? "green" : "yellow");
      // Verbose log raw response để debug format (chỉ first 300 chars)
      const snippet = (body || "").slice(0, 300);
      window.svpLog(`🔄 TB refresh_token body: ${snippet}`, "gray");
    }
  }

  function _handleCaptchaGen(url, status, body, parsed) {
    const m = url.match(RE_CAPTCHA_GEN);
    const showingId = m ? m[1] : null;
    const slide = parsed?.data?.slide || null;
    _state.lastCaptchaGen = {
      url, status, body, parsed, showingId,
      key: parsed?.data?.key || null,
      image: slide?.image || null,
      thumb: slide?.thumb || null,
      ts: Date.now(),
    };
    if (window.svpLog) {
      window.svpLog(`🧩 TB captcha gen status=${status} showingId=${showingId} hasSlide=${!!slide}`,
        status === 200 ? "blue" : "yellow");
    }
  }

  function _handleCaptchaCheck(url, status, body, parsed) {
    const captchaToken = parsed?.data?.token || parsed?.data || null;
    const tokenStr = typeof captchaToken === "string" ? captchaToken : null;
    _state.lastCaptchaCheck = {
      url, status, body, parsed,
      captchaToken: tokenStr,
      ts: Date.now(),
    };
    if (window.svpLog) {
      const ec = parsed?.errorCode ?? parsed?.code ?? "?";
      window.svpLog(`🧩 TB captcha check status=${status} errorCode=${ec} tokenLen=${tokenStr?.length || 0}`,
        status === 200 && tokenStr ? "green" : "yellow");
    }
    // Notify captcha waiters
    const waiters = _state._captchaWaiters.splice(0);
    for (const w of waiters) {
      try { w.resolve(tokenStr ? { success: true, token: tokenStr, raw: parsed } : { success: false, raw: parsed, status }); } catch {}
    }
  }

  function _handleSubmitTicketInfo(url, status, body, parsed) {
    // Body Ticketbox: data.result.code = bookingCode
    const result = parsed?.data?.result || {};
    const bookingCode = result.code || null;
    const isSuccess = status >= 200 && status < 300 && result.success === true && bookingCode;

    _state.lastSubmitTicketInfo = {
      url, status, body, parsed, bookingCode,
      expireIn: result.expireIn || null,
      ts: Date.now(),
    };

    let resolved;
    if (isSuccess) {
      _state.lastReserveError = null;
      resolved = { success: true, bookingCode, expireIn: result.expireIn, raw: parsed, status };
      if (window.svpLog) {
        window.svpLog(`🎯 TB reserve OK — bookingCode=${bookingCode} expireIn=${result.expireIn}s`, "green");
      }
    } else {
      _state.lastReserveError = {
        errorCode: parsed?.errorCode ?? parsed?.code ?? null,
        message: parsed?.message ?? result?.message ?? "(no message)",
        status,
      };
      resolved = { success: false, error: _state.lastReserveError, raw: parsed, status };
      if (window.svpLog) {
        const msg = _state.lastReserveError.message || body?.slice(0, 120);
        window.svpLog(`❌ TB reserve FAIL — status=${status} errorCode=${_state.lastReserveError.errorCode} msg=${msg}`, "red");
      }
    }

    const waiters = _state._reserveWaiters.splice(0);
    for (const w of waiters) {
      try { w.resolve(resolved); } catch {}
    }
  }

  function _handleSubmitOrder(url, status, body, parsed) {
    const redirectUrl = parsed?.data?.redirectUrl || parsed?.data || null;
    _state.lastSubmitOrderInfo = {
      url, status, body, parsed,
      redirectUrl: typeof redirectUrl === "string" ? redirectUrl : null,
      ts: Date.now(),
    };
    if (window.svpLog) {
      window.svpLog(`💳 TB submit-order status=${status} hasRedirect=${!!_state.lastSubmitOrderInfo.redirectUrl}`,
        status === 200 ? "green" : "yellow");
    }
  }

  // ── Register bridge listeners ────────────────────────────────────────────────
  function _setupListeners(retry = 0) {
    if (!window.__SVP_BRIDGE_CLIENT__) {
      if (retry < 50) {
        setTimeout(() => _setupListeners(retry + 1), 100);
      } else if (window.svpLog) {
        window.svpLog("⚠️ TB capture: bridge client không sẵn sàng sau 5s", "yellow");
      }
      return;
    }
    const client = window.__SVP_BRIDGE_CLIENT__;
    client.on("net.xhr.response", _onResponse);
    client.on("net.fetch.response", _onResponse);
    if (window.svpLog) {
      window.svpLog("📡 Ticketbox XHR capture ready (login/refresh/captcha/reserve/checkout)", "blue");
    }
  }
  _setupListeners();

  // ── Public API ───────────────────────────────────────────────────────────────
  window.__SVP_TB_CAPTURE__ = {
    /**
     * Wait next submit-ticket-info response.
     * Resolves: {success:true, bookingCode, expireIn, raw, status}
     *        OR {success:false, error, raw, status}
     *        OR null (timeout)
     */
    waitForBookingCode(timeoutMs = 8000) {
      if (_state.lastSubmitTicketInfo) {
        const r = _state.lastSubmitTicketInfo;
        if (r.bookingCode) {
          return Promise.resolve({
            success: true, bookingCode: r.bookingCode,
            expireIn: r.expireIn, raw: r.parsed, status: r.status,
          });
        } else if (_state.lastReserveError) {
          return Promise.resolve({
            success: false, error: _state.lastReserveError,
            raw: r.parsed, status: r.status,
          });
        }
      }
      return new Promise((resolve) => {
        const w = { resolve };
        _state._reserveWaiters.push(w);
        setTimeout(() => {
          const i = _state._reserveWaiters.indexOf(w);
          if (i >= 0) {
            _state._reserveWaiters.splice(i, 1);
            resolve(null);
          }
        }, timeoutMs);
      });
    },

    /**
     * Wait next captcha check response.
     * Resolves: {success:true, token, raw} OR {success:false, raw, status} OR null
     */
    waitForCaptchaToken(timeoutMs = 30000) {
      if (_state.lastCaptchaCheck?.captchaToken) {
        return Promise.resolve({
          success: true,
          token: _state.lastCaptchaCheck.captchaToken,
          raw: _state.lastCaptchaCheck.parsed,
        });
      }
      return new Promise((resolve) => {
        const w = { resolve };
        _state._captchaWaiters.push(w);
        setTimeout(() => {
          const i = _state._captchaWaiters.indexOf(w);
          if (i >= 0) {
            _state._captchaWaiters.splice(i, 1);
            resolve(null);
          }
        }, timeoutMs);
      });
    },

    clearReserveCache() {
      _state.lastSubmitTicketInfo = null;
      _state.lastReserveError = null;
    },
    clearCaptchaCache() {
      _state.lastCaptchaGen = null;
      _state.lastCaptchaCheck = null;
    },

    getLastBookingCode()    { return _state.lastSubmitTicketInfo?.bookingCode || null; },
    getLastCaptchaToken()   { return _state.lastCaptchaCheck?.captchaToken || null; },
    getLastCaptchaGen()     { return _state.lastCaptchaGen; },
    getLastRefreshToken()   { return _state.lastRefreshToken; },
    getLastLogin()          { return _state.lastLogin; },
    getLastQuestionForm()   { return _state.lastQuestionForm; },
    getLastPaymentMethods() { return _state.lastPaymentMethods; },
    getLastSubmitOrder()    { return _state.lastSubmitOrderInfo; },
    getLastReserveError()   { return _state.lastReserveError; },

    _state, // debug
  };
})();
