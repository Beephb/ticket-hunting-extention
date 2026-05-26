// src/platforms/ticketbox/captcha_solver.js
// Pre-solve TB captcha: GET /capt/gen → user pick X → POST /capt/check → JWT.
// Save JWT vào localStorage[tkc_{userId}{showingId}] để frontend TB native reuse.

(function() {
  if (window.__SVP_TB_CAPTCHA_SOLVER__) return;

  const API_BASE = "https://api-v2.ticketbox.vn";
  const WEB_BASE = "https://ticketbox.vn";

  // ── showingId auto-detect ────────────────────────────────────────────────────

  function _showingIdFromUrl() {
    try {
      const m = location.href.match(/\/events\/\d+\/bookings\/(\d{6,})/);
      if (m) return m[1];
    } catch {}
    return null;
  }

  function _eventIdFromUrl() {
    try {
      const url = location.href;
      let m = url.match(/-(\d{4,})(?:\?|$|\/)/);
      if (m) return m[1];
      m = url.match(/\/events\/(\d{4,})(?:\/|\?|$)/);
      if (m) return m[1];
    } catch {}
    return null;
  }

  async function _showingIdFromEventApi(eventId) {
    const tokenMgr = window.__SVP_TB_TOKEN__;
    const headers = tokenMgr ? tokenMgr.buildHeaders() : {};
    try {
      const res = await fetch(`${API_BASE}/gin/api/v2/events/${eventId}`, {
        method: "GET",
        credentials: "include",
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const json = await res.json();
      const showings = json?.data?.result?.showings || [];
      if (!showings.length) return null;
      // Ưu tiên: salable trước, rồi date xa nhất (showing sắp tới)
      const sorted = [...showings].sort((a, b) => {
        const aOpen = (a?.isSalable || /book_now/i.test(a?.status || "")) ? 1 : 0;
        const bOpen = (b?.isSalable || /book_now/i.test(b?.status || "")) ? 1 : 0;
        if (aOpen !== bOpen) return bOpen - aOpen;
        return (parseInt(b.id) || 0) - (parseInt(a.id) || 0);
      });
      return String(sorted[0]?.id || "") || null;
    } catch {
      return null;
    }
  }

  async function detectShowingId() {
    const fromUrl = _showingIdFromUrl();
    if (fromUrl) return { showingId: fromUrl, source: "url" };
    const eventId = _eventIdFromUrl();
    if (!eventId) return { showingId: null, source: "no_event" };
    const fromApi = await _showingIdFromEventApi(eventId);
    if (fromApi) return { showingId: fromApi, source: "event_api", eventId };
    return { showingId: null, source: "api_empty", eventId };
  }

  // ── Status ────────────────────────────────────────────────────────────────────

  async function getStatus() {
    const tokenMgr = window.__SVP_TB_TOKEN__;
    if (!tokenMgr) return { ok: false, reason: "token_mgr_missing" };

    const userId = tokenMgr.getUserId();
    if (!userId) return { ok: false, reason: "no_user", hint: "Chưa login Ticketbox" };

    const { showingId, source } = await detectShowingId();
    if (!showingId) {
      return { ok: false, reason: "no_showing", source, hint: "Mở trang event/booking trước" };
    }

    const remainingMs = tokenMgr.captchaTokenRemainingMs(showingId);
    const hasToken = remainingMs > 0;
    return {
      ok: true,
      showingId,
      source,
      userId,
      hasToken,
      remainingMs,
    };
  }

  // ── Gen / Check ──────────────────────────────────────────────────────────────

  async function _genOnce(showingId) {
    const tokenMgr = window.__SVP_TB_TOKEN__;
    if (!tokenMgr) return { ok: false, reason: "token_mgr_missing" };

    const headers = tokenMgr.buildHeaders();
    try {
      const res = await fetch(`${API_BASE}/sapporo/api/v2/capt/gen/${showingId}`, {
        method: "GET",
        credentials: "include",
        headers,
        signal: AbortSignal.timeout(8000),
      });
      const status = res.status;
      let bodyText = "";
      try { bodyText = await res.text(); } catch {}

      if (!res.ok) {
        return { ok: false, reason: `http_${status}`, bodySample: bodyText.slice(0, 200) };
      }

      let json;
      try { json = JSON.parse(bodyText); }
      catch { return { ok: false, reason: "json_parse_fail", bodySample: bodyText.slice(0, 200) }; }

      const rootData = json?.data;
      if (!rootData) {
        return { ok: false, reason: "no_data", message: json?.message, code: json?.code };
      }

      const type = rootData.type;        // "slide" | "rotate"
      const key = rootData.key;
      const payload = rootData[type];    // { image, thumb, tile_x?, tile_y?, ... }

      if (!key || !payload?.image) {
        return { ok: false, reason: "bad_shape", type, hasKey: !!key, hasImage: !!payload?.image };
      }

      return {
        ok: true,
        data: {
          type,
          key,
          image: payload.image,
          thumb: payload.thumb || null,
          tile_x: payload.tile_x,
          tile_y: payload.tile_y,
          tile_width: payload.tile_width,
          tile_height: payload.tile_height,
          mobile: rootData.mobile || false,
        },
      };
    } catch (e) {
      return { ok: false, reason: "fetch_error", message: e.message };
    }
  }

  /** Gen với auto-retry: nếu server trả rotate → gen lại tới khi ra slide (max retries). */
  async function gen(showingId, { maxRetries = 6 } = {}) {
    let lastErr = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const r = await _genOnce(showingId);
      if (!r.ok) { lastErr = r; continue; }
      if (r.data.type === "slide") {
        if (attempt > 0 && window.svpLog) {
          window.svpLog(`🧩 Captcha: bỏ qua ${attempt} rotate, đã có slide`, "gray");
        }
        return r;
      }
      // type=rotate → skip, gen lại
      if (window.svpLog) window.svpLog(`🧩 Captcha gen #${attempt+1} = ${r.data.type}, retry...`, "gray");
      await new Promise(r => setTimeout(r, 150));
    }
    return lastErr || { ok: false, reason: "no_slide_after_retries", maxRetries };
  }

  async function check(showingId, key, value) {
    const tokenMgr = window.__SVP_TB_TOKEN__;
    if (!tokenMgr) return { ok: false, reason: "token_mgr_missing" };
    const userId = tokenMgr.getUserId();
    if (!userId) return { ok: false, reason: "no_user" };

    const headers = tokenMgr.buildHeaders();
    try {
      const res = await fetch(`${API_BASE}/sapporo/api/v2/capt/check/${showingId}`, {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({ key, value }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, reason: `http_${res.status}` };
      const json = await res.json();
      const token = json?.data?.token;
      if (!token || !token.startsWith("eyJ")) {
        return { ok: false, reason: "no_token", message: json?.message || "verify failed", json };
      }

      // Ghi vào localStorage để frontend TB native reuse
      const storeKey = `tkc_${userId}${showingId}`;
      try { localStorage.setItem(storeKey, token); } catch {}

      // Parse exp để trả về cho UI
      let remainingMs = 0;
      try {
        const payloadB64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
        const padded = payloadB64 + "=".repeat((4 - payloadB64.length % 4) % 4);
        const payload = JSON.parse(atob(padded));
        if (payload?.exp) remainingMs = Math.max(0, payload.exp * 1000 - Date.now());
      } catch {}

      return { ok: true, token, remainingMs };
    } catch (e) {
      return { ok: false, reason: "fetch_error", message: e.message };
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  window.__SVP_TB_CAPTCHA_SOLVER__ = {
    detectShowingId,
    getStatus,
    gen,
    check,
  };

  if (window.svpLog) window.svpLog("🧩 TB captcha solver loaded", "blue");
})();
