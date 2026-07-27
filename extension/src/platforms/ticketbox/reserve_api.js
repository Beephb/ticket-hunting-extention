// src/platforms/ticketbox/reserve_api.js
// Ticketbox reserve API — call submit-ticket-info trực tiếp từ extension.
//
// Flow:
//   1. Caller (seat_*.js) chuẩn bị: eventId, showingId, date, items
//   2. submitTicketInfo() build body + headers, gọi POST trực tiếp
//   3. Return {success, bookingCode, error?, ...} cho caller
//
// Tại sao gọi trực tiếp thay vì trigger UI:
//   - Khác với 1Zone (cần frontend sign), Ticketbox token KHÔNG có signature
//   - Header chỉ cần: x-tb-access-token + x-tb-captcha-token + x-device-info
//   - Cả 3 đều extension đọc được từ cookie/localStorage
//   - Nhanh hơn UI flow ~3-5s xuống ~600ms
//
// Headers cần (theo HAR + proxy data):
//   x-tb-access-token   — cookie TBoxJWT (TTL 120s)
//   x-tb-captcha-token  — localStorage tkc_{userId}{showingId} (TTL 1h)
//   x-device-info       — platform=web;device-id={deviceId}
//   x-accept-language   — vi
//   content-type        — application/json;charset=UTF-8
//   origin              — https://ticketbox.vn
//   referer             — https://ticketbox.vn/

(function() {
  if (window.__SVP_TB_RESERVE__) return;

  const API_BASE = "https://api-v2.ticketbox.vn";

  /**
   * Submit ticket info — reserve vé qua API.
   *
   * @param {Object} args
   * @param {string|number} args.eventId
   * @param {string|number} args.showingId
   * @param {string} args.date            "YYYY-MM-DD"
   * @param {Array}  args.items           [{id: ticketTypeId, quantity, sectionId, seats?: [{id, quantity}]}]
   * @param {Object} [args.campaign]      {gclid?, source?, medium?} — optional, default từ doc
   * @param {number} [args.timeoutMs=1500]
   *
   * @returns {Promise<Object>} {
   *   success: bool,
   *   bookingCode: string | null,
   *   expireIn: number | null,
   *   error?: {status, errorCode, message},
   *   raw: parsed response,
   * }
   */
  async function submitTicketInfo({ eventId, showingId, date, items, campaign, timeoutMs = 1500 }) {
    return await _submitWithRetry({ eventId, showingId, date, items, campaign, timeoutMs }, 0);
  }

  // Internal: retry tối đa 1 lần on 401 (sau khi trigger refresh)
  async function _submitWithRetry(args, retryCount) {
    const { eventId, showingId, date, items, campaign, timeoutMs } = args;
    const tokenMgr = window.__SVP_TB_TOKEN__;
    if (!tokenMgr) {
      return _failed("token_manager_missing", "Token manager chưa load");
    }

    // Pre-flight check — sẽ tự trigger refresh nếu cần (Fix #3)
    const preFlight = await tokenMgr.preFlightCheck();
    if (!preFlight.ok && preFlight.reason === "no_token_login_required") {
      return _failed("not_logged_in", "Chưa login Ticketbox — vui lòng login trên tab");
    }
    if (!preFlight.ok && retryCount === 0) {
      // Token vẫn expire sau pre-flight refresh — vẫn cố thử, nếu 401 sẽ retry
      if (window.svpLog) {
        window.svpLog(`⚠️ TB reserve với token expire (${preFlight.reason}) — vẫn thử, sẽ retry nếu 401`, "yellow");
      }
    }

    // Build headers (token_manager handle showingId → captcha lookup)
    const headers = tokenMgr.buildHeaders({ showingId: String(showingId) });

    // Verify đủ headers cần
    if (!headers["x-tb-access-token"]) {
      return _failed("no_access_token", "Không có x-tb-access-token");
    }
    if (!headers["x-tb-captcha-token"]) {
      return _failed("no_captcha_token", `Chưa solve captcha cho showing ${showingId}`);
    }

    // Build body theo schema Ticketbox
    const body = {
      platform: "desktop",
      items: items,
      eventId: typeof eventId === "string" ? parseInt(eventId) : eventId,
      showingId: typeof showingId === "string" ? parseInt(showingId) : showingId,
      timestamp: Math.floor(Date.now() / 1000),
      campaign: campaign || { gclid: "", source: "tkb-homepage", medium: "" },
      date: date,
    };

    const url = `${API_BASE}/event/api/v1/bookings/submit-ticket-info`;
    const t0 = performance.now();

    if (window.svpLog) {
      const itemSummary = items.map(it => `tt${it.id}/sec${it.sectionId}/x${it.quantity}${it.seats ? `[${it.seats.map(s=>s.id).join(",")}]` : ""}`).join("; ");
      window.svpLog(`🎫 TB reserve API → ${itemSummary}`, "blue");
    }

    let res, text;
    try {
      res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      text = await res.text();
    } catch (e) {
      const dur = Math.round(performance.now() - t0);
      if (window.svpLog) {
        window.svpLog(`❌ TB reserve fetch error (${dur}ms): ${e.message}`, "red");
      }
      return _failed("network_error", e.message);
    }

    // Rate limit check — reserve endpoint cũng có thể 429
    const rl = window.SVP_RATE_LIMIT?.forHost("api-v2.ticketbox.vn");
    if (res.status === 429 || res.status === 503) {
      // BUG cũ: tính `wait` xong không hề await sleep(wait) — giá trị bị bỏ phí.
      // Caller (vòng lặp retry "sold_out" ở seat_zone.js/seat_map.js) chỉ dựa
      // vào raw.data.result.invalidItems để biết "còn đáng retry hay không" —
      // vì rate_limited trả raw=null nên bị hiểu nhầm thành "lỗi khác, dừng
      // hẳn", bỏ cuộc reserve ngay lúc server chỉ đang tạm chặn (thường xảy ra
      // đúng lúc traffic cao nhất — mở bán). Giờ: thực sự đợi theo backoff, và
      // đánh dấu rateLimited=true (trừ khi rate_limit.js đã quyết abort hẳn vì
      // vượt ngưỡng liên tục) để caller coi đây là case "còn cơ hội, cứ retry"
      // giống hệt case sold_out thay vì "lỗi cuối cùng".
      let rateLimited = true;
      if (rl) {
        const wait = rl.onError429(res.status);
        if (window.svpLog) {
          window.svpLog(`⏸ TB reserve rate-limited (${res.status}) — wait ${wait}ms trước retry`, "yellow");
        }
        if (wait < 0) {
          rateLimited = false; // rate_limit.js đã abort (5 lần liên tục) — coi là lỗi thật, không retry nữa
        } else {
          await sleep(wait);
        }
      }
      const failResult = _failed("rate_limited", `HTTP ${res.status} — server limit${rateLimited ? ", sẽ retry" : ", abort (rate limit critical)"}`);
      failResult.rateLimited = rateLimited;
      return failResult;
    }
    rl?.onSuccess();

    const dur = Math.round(performance.now() - t0);
    let parsed = null;
    try { parsed = JSON.parse(text); } catch {}

    const result = parsed?.data?.result || {};
    const bookingCode = result.code || null;
    const isSuccess = res.status >= 200 && res.status < 300 && result.success === true && bookingCode;

    if (isSuccess) {
      if (window.svpLog) {
        window.svpLog(`✅ TB reserve OK (${dur}ms) — bookingCode=${bookingCode} expireIn=${result.expireIn}s`, "green");
      }
      return {
        success: true,
        bookingCode,
        expireIn: result.expireIn || null,
        raw: parsed,
        status: res.status,
        durationMs: dur,
      };
    }

    // Phân loại lỗi
    const errorCode = parsed?.errorCode ?? parsed?.code ?? result?.code;
    const message = parsed?.message ?? result?.message ?? text?.slice(0, 200);

    // RETRY ON 401: token expire giữa flight, thử trigger refresh + retry 1 lần
    if (res.status === 401 && retryCount === 0) {
      if (window.svpLog) {
        window.svpLog(`⚠️ TB reserve 401 (${dur}ms) — trigger refresh + retry 1 lần`, "yellow");
      }
      // Re-trigger refresh (đảm bảo cookie đã update)
      const tokenMgr2 = window.__SVP_TB_TOKEN__;
      await tokenMgr2?.triggerRefresh(2500);
      // Brief delay để frontend axios complete
      await new Promise(r => setTimeout(r, 300));
      // Recursive retry với retryCount = 1
      return await _submitWithRetry(args, 1);
    }

    if (window.svpLog) {
      const retryNote = retryCount > 0 ? ` (sau retry #${retryCount})` : "";
      window.svpLog(`❌ TB reserve FAIL${retryNote} (${dur}ms) status=${res.status} errorCode=${errorCode} msg=${message}`, "red");
    }

    return {
      success: false,
      bookingCode: null,
      error: { status: res.status, errorCode, message },
      raw: parsed,
      status: res.status,
      durationMs: dur,
    };
  }

  function _failed(reason, message) {
    if (window.svpLog) window.svpLog(`❌ TB reserve abort: ${message}`, "red");
    return { success: false, bookingCode: null, error: { reason, message }, raw: null, status: null };
  }

  /**
   * Helper build items cho zone mode.
   * @param {number|string} ticketTypeId
   * @param {number} quantity
   * @param {number|string} sectionId
   */
  function buildZoneItems(ticketTypeId, quantity, sectionId) {
    return [{
      id: typeof ticketTypeId === "string" ? parseInt(ticketTypeId) : ticketTypeId,
      quantity: quantity,
      sectionId: typeof sectionId === "string" ? parseInt(sectionId) : sectionId,
    }];
  }

  /**
   * Helper build items cho map mode.
   * @param {number|string} ticketTypeId
   * @param {number} quantity
   * @param {number|string} sectionId
   * @param {Array<{id, quantity?}>} seats
   */
  function buildMapItems(ticketTypeId, quantity, sectionId, seats) {
    return [{
      id: typeof ticketTypeId === "string" ? parseInt(ticketTypeId) : ticketTypeId,
      quantity: quantity,
      sectionId: typeof sectionId === "string" ? parseInt(sectionId) : sectionId,
      seats: seats.map(s => ({
        id: typeof s.id === "string" ? parseInt(s.id) : s.id,
        quantity: s.quantity || 1,
      })),
    }];
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  window.__SVP_TB_RESERVE__ = {
    submitTicketInfo,
    buildZoneItems,
    buildMapItems,
  };

  if (window.svpLog) {
    window.svpLog("🎫 TB reserve API client loaded", "blue");
  }
})();