// src/platforms/ticketbox/token_manager.js
// Ticketbox token lifecycle — READ-ONLY strategy (Stage 4.2 conclusion).
//
// Discovery 2026-05-24: Ticketbox lưu tokens trong COOKIES:
//   TBoxJWT          = access_token (RS256, TTL 120s, kind=access_token)
//   TBoxRefresh      = refresh_token (RS256, TTL 10 ngày, kind=refresh_token)
//   TBoxJWTExpiredAt = refresh_token exp (Unix seconds)
//   userId           = user_id (vd: 4445570)
//   deviceId         = device_id (vd: 50ab8f7bdbec3b3ebe6be7cab3c86625)
//
// Frontend Ticketbox tự refresh access_token mỗi ~90s (cần signature do JS bundle
// compute, extension không bypass được). Extension chỉ:
//   - Đọc current TBoxJWT từ cookie
//   - Build headers cho reserve API
//   - Nếu reserve trả 401 → log warning, không tự refresh (frontend sẽ tự handle)

(function() {
  if (window.__SVP_TB_TOKEN__) return;

  // Cookie name conventions của Ticketbox (verified 2026-05-24)
  const COOKIE_ACCESS_TOKEN = "TBoxJWT";
  const COOKIE_REFRESH_TOKEN = "TBoxRefresh";
  const COOKIE_REFRESH_EXP   = "TBoxJWTExpiredAt";
  const COOKIE_USER_ID       = "userId";
  const COOKIE_DEVICE_ID     = "deviceId";

  const REFRESH_MARGIN_MS = 30 * 1000;       // warn khi còn < 30s

  const _state = {
    accessToken: null,
    accessTokenExp: null,    // unix seconds
    refreshToken: null,
    refreshTokenExp: null,
    deviceId: null,
    userId: null,
    email: null,
    captchaTokens: {},       // showingId → JWT (cache for 1h)
  };

  // ── Helpers ──────────────────────────────────────────────────────────────────
  function _parseJwt(token) {
    if (!token || typeof token !== "string") return null;
    try {
      const parts = token.split(".");
      if (parts.length !== 3) return null;
      const b64 = parts[1].replace(/-/g, "+").replace(/_/g, "/");
      const padded = b64 + "=".repeat((4 - b64.length % 4) % 4);
      return JSON.parse(atob(padded));
    } catch {
      return null;
    }
  }

  function _readCookie(name) {
    try {
      const parts = document.cookie.split(";").map(s => s.trim());
      for (const p of parts) {
        const eq = p.indexOf("=");
        if (eq < 0) continue;
        if (p.slice(0, eq) === name) {
          return decodeURIComponent(p.slice(eq + 1));
        }
      }
    } catch {}
    return null;
  }

  function _readCaptchaFromStorage(showingId) {
    // Captcha token store ở localStorage key: tkc_{user_id}{showing_id}
    if (!_state.userId) return null;
    const key = `tkc_${_state.userId}${showingId}`;
    try {
      const v = localStorage.getItem(key);
      if (v && v.startsWith("eyJ")) return v;
    } catch {}
    return null;
  }

  function _refreshState() {
    const accessToken = _readCookie(COOKIE_ACCESS_TOKEN);
    const refreshToken = _readCookie(COOKIE_REFRESH_TOKEN);
    const refreshExpCookie = _readCookie(COOKIE_REFRESH_EXP);
    const userIdCookie = _readCookie(COOKIE_USER_ID);
    const deviceIdCookie = _readCookie(COOKIE_DEVICE_ID);

    _state.accessToken = accessToken;
    _state.refreshToken = refreshToken;
    _state.userId = userIdCookie ? parseInt(userIdCookie) : null;
    _state.deviceId = deviceIdCookie || null;
    _state.refreshTokenExp = refreshExpCookie ? parseInt(refreshExpCookie) : null;

    // Parse access_token JWT để lấy exp + verify
    const payload = _parseJwt(accessToken);
    if (payload) {
      _state.accessTokenExp = payload.exp || null;
      // Fallback: nếu cookie không có deviceId/userId, lấy từ JWT
      if (!_state.deviceId && payload.device_id) _state.deviceId = payload.device_id;
      if (!_state.userId && payload.user_id) _state.userId = payload.user_id;
      _state.email = payload.email || null;
    } else {
      _state.accessTokenExp = null;
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  window.__SVP_TB_TOKEN__ = {
    /** Reload token từ cookie (gọi mỗi lần trước reserve để đảm bảo fresh). */
    reload() {
      _refreshState();
      return _state.accessToken;
    },

    /** Lấy access token hiện tại từ cookie TBoxJWT. */
    getToken() {
      _refreshState();  // luôn re-read vì cookie có thể update bất kỳ lúc nào
      return _state.accessToken;
    },

    /** Lấy refresh_token (dùng cho debug, extension KHÔNG tự refresh) */
    getRefreshToken() {
      _refreshState();
      return _state.refreshToken;
    },

    getDeviceId() {
      if (!_state.deviceId) _refreshState();
      return _state.deviceId;
    },

    getUserId() {
      if (!_state.userId) _refreshState();
      return _state.userId;
    },

    /** Access token còn valid không (chưa hết hạn + còn margin) */
    isValid(marginMs = REFRESH_MARGIN_MS) {
      _refreshState();
      if (!_state.accessTokenExp) return false;
      return (_state.accessTokenExp * 1000 - Date.now()) > marginMs;
    },

    /**
     * Pre-flight check trước Phase 2 reserve.
     * KHÔNG tự refresh (frontend Ticketbox handle). Chỉ log warning nếu sắp hết.
     */
    async preFlightCheck() {
      _refreshState();
      if (this.isValid()) return { ok: true, token: _state.accessToken };

      if (!_state.accessToken) {
        if (window.svpLog) window.svpLog(`❌ TB chưa login (TBoxJWT cookie missing)`, "red");
        return { ok: false, token: null, reason: "no_token_login_required" };
      }

      const remainingMs = _state.accessTokenExp
        ? _state.accessTokenExp * 1000 - Date.now()
        : -1;

      if (remainingMs < 0) {
        if (window.svpLog) window.svpLog(`⚠️ TB access_token EXPIRED ${-Math.round(remainingMs/1000)}s ago — chờ frontend refresh`, "yellow");
      } else {
        if (window.svpLog) window.svpLog(`⚠️ TB access_token còn ${Math.round(remainingMs/1000)}s — sắp expire`, "yellow");
      }
      return { ok: false, token: _state.accessToken, reason: "expiring_soon", remainingMs };
    },

    /**
     * Captcha token cho 1 showing cụ thể.
     * Đọc từ localStorage key: tkc_{user_id}{showing_id}
     * (Frontend Ticketbox tự cache captcha token sau khi user solve).
     */
    getCaptchaToken(showingId) {
      if (!showingId) return null;
      _refreshState();
      const cached = _readCaptchaFromStorage(showingId);
      if (!cached) return null;
      const payload = _parseJwt(cached);
      if (payload?.exp && payload.exp * 1000 < Date.now()) {
        if (window.svpLog) window.svpLog(`⚠️ TB captcha_token expired cho showing ${showingId}`, "yellow");
        return null;
      }
      return cached;
    },

    captchaTokenRemainingMs(showingId) {
      const token = this.getCaptchaToken(showingId);
      if (!token) return 0;
      const payload = _parseJwt(token);
      if (!payload?.exp) return 0;
      return Math.max(0, payload.exp * 1000 - Date.now());
    },

    /**
     * Build headers chung cho mọi request Ticketbox API.
     * Caller pass showingId nếu request cần x-tb-captcha-token (vd: submit-ticket-info).
     */
    buildHeaders({ showingId = null, extra = {} } = {}) {
      _refreshState();
      const headers = {
        "Accept": "application/json, text/plain, */*",
        "Content-Type": "application/json;charset=UTF-8",
        "x-accept-language": "vi",
        "Origin": "https://ticketbox.vn",
        "Referer": "https://ticketbox.vn/",
        ...extra,
      };
      if (_state.accessToken) headers["x-tb-access-token"] = _state.accessToken;
      if (_state.deviceId) headers["x-device-info"] = `platform=web;device-id=${_state.deviceId}`;
      if (showingId) {
        const captcha = this.getCaptchaToken(showingId);
        if (captcha) headers["x-tb-captcha-token"] = captcha;
      }
      return headers;
    },

    /** Status snapshot. */
    status() {
      _refreshState();
      return {
        hasAccessToken: !!_state.accessToken,
        accessTokenValid: this.isValid(),
        accessTokenExp: _state.accessTokenExp,
        accessTokenRemainingMs: _state.accessTokenExp
          ? Math.max(0, _state.accessTokenExp * 1000 - Date.now())
          : null,
        hasRefreshToken: !!_state.refreshToken,
        refreshTokenRemainingMs: _state.refreshTokenExp
          ? Math.max(0, _state.refreshTokenExp * 1000 - Date.now())
          : null,
        userId: _state.userId,
        deviceId: _state.deviceId ? _state.deviceId.slice(0, 8) + "***" : null,
        email: _state.email ? _state.email.split("@")[0][0] + "***@" + _state.email.split("@")[1] : null,
      };
    },

    _state,  // debug
  };

  // Init load
  _refreshState();

  if (window.svpLog) {
    const has = !!_state.accessToken;
    const valid = window.__SVP_TB_TOKEN__.isValid();
    const remainingS = _state.accessTokenExp
      ? Math.round((_state.accessTokenExp * 1000 - Date.now()) / 1000)
      : "?";
    window.svpLog(`🔐 TB token (cookie-based) — hasToken=${has} valid=${valid} remaining=${remainingS}s user=${_state.userId || "?"}`, has ? "blue" : "yellow");
  }

  // ── Broadcast token status periodically cho desktop UI ───────────────────────
  function _broadcastStatus() {
    if (!window.svpEvent) return;
    try {
      const st = window.__SVP_TB_TOKEN__.status();
      // Count cached captcha tokens (tkc_xxx) còn valid
      let captchaCount = 0;
      const captchaShowings = [];
      try {
        const userId = st.userId;
        if (userId) {
          for (const key of Object.keys(localStorage)) {
            const prefix = `tkc_${userId}`;
            if (!key.startsWith(prefix)) continue;
            const showingId = key.slice(prefix.length);
            const token = localStorage.getItem(key);
            if (token && token.startsWith("eyJ")) {
              const payload = _parseJwt(token);
              if (payload?.exp && payload.exp * 1000 > Date.now()) {
                captchaCount++;
                captchaShowings.push({
                  showingId,
                  remainingMs: Math.max(0, payload.exp * 1000 - Date.now()),
                });
              }
            }
          }
        }
      } catch {}
      window.svpEvent("token.status", {
        platform: "ticketbox",
        ...st,
        captchaCount,
        captchaShowings,
      });
    } catch {}
  }

  // Emit initial + every 5s
  setTimeout(_broadcastStatus, 1000);
  setInterval(_broadcastStatus, 5000);
})();
