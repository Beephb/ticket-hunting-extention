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
    const tokenMgr = window.__SVP_TB_TOKEN__;
    if (!tokenMgr) {
      return _failed("token_manager_missing", "Token manager chưa load");
    }

    // Pre-flight check
    const preFlight = await tokenMgr.preFlightCheck();
    if (!preFlight.ok) {
      if (preFlight.reason === "no_token_login_required") {
        return _failed("not_logged_in", "Chưa login Ticketbox — vui lòng login trên tab");
      }
      // Token sắp/đã expire — vẫn cố thử (frontend có thể refresh giữa chừng)
      if (window.svpLog) {
        window.svpLog(`⚠️ TB reserve với token expire (${preFlight.reason}) — vẫn thử`, "yellow");
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

    if (window.svpLog) {
      window.svpLog(`❌ TB reserve FAIL (${dur}ms) status=${res.status} errorCode=${errorCode} msg=${message}`, "red");
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
