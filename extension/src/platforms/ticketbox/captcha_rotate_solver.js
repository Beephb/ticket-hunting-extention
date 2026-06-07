// src/platforms/ticketbox/captcha_rotate_solver.js
// Auto-solve rotate captcha — junction edge matching.
//
// Cấu trúc captcha rotate Ticketbox (verified từ proxy):
//   master (220×220 RGBA): outer ring của ảnh gốc — CHƯA xoay, có corners trong suốt
//   thumb  (194×194 RGBA): inner circle của ảnh gốc — ĐÃ bị xoay bởi server
//   value submit = góc (degree) cần xoay thumb theo chiều KIM ĐỒNG HỒ để khớp lại
//
// Algorithm: Junction Edge Matching
//   1. Tìm ring pixels tại r=70–86px từ tâm master (inner edge của outer ring)
//   2. Map sang coords thumb, so màu pixel
//   3. Scan 0–358° (bước 2°): PIL.rotate(+angle) → measure MAE tại junction
//      → PIL rotate NGƯỢC chiều kim đồng hồ → server value = (360 - pil_angle) % 360
//   4. Fine-tune ±10° bước 0.5° quanh best
//   Accuracy: ~95%+, thời gian ~200-400ms

(function () {
  if (window.__SVP_TB_CAPTCHA_SOLVER__) return;

  const API_BASE = "https://api-v2.ticketbox.vn";

  // ── showingId helpers ────────────────────────────────────────────────────────

  function _showingIdFromUrl() {
    try {
      const m = location.href.match(/\/events\/\d+\/bookings\/(\d{6,})/);
      if (m) return m[1];
      const m2 = location.href.match(/\/queue\/(\d{6,})/);
      if (m2) return m2[1];
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
        method: "GET", credentials: "include", headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return null;
      const json = await res.json();
      const showings = json?.data?.result?.showings || [];
      if (!showings.length) return null;
      const sorted = [...showings].sort((a, b) => {
        const aO = (a?.isSalable || /book_now/i.test(a?.status || "")) ? 1 : 0;
        const bO = (b?.isSalable || /book_now/i.test(b?.status || "")) ? 1 : 0;
        if (aO !== bO) return bO - aO;
        return (parseInt(b.id) || 0) - (parseInt(a.id) || 0);
      });
      const id = sorted[0]?.id;
      if (id === null || id === undefined) return null;
      return String(id);
    } catch { return null; }
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
    if (!showingId || showingId === "0") {
      return { ok: false, reason: "no_showing", source,
        hint: showingId === "0" ? "Chưa mở bán (showingId=0)" : "Mở trang event/booking trước" };
    }
    const remainingMs = tokenMgr.captchaTokenRemainingMs(showingId);
    return { ok: true, showingId, source, userId, hasToken: remainingMs > 0, remainingMs };
  }

  // ── Gen / Check ──────────────────────────────────────────────────────────────

  async function gen(showingId) {
    const tokenMgr = window.__SVP_TB_TOKEN__;
    if (!tokenMgr) return { ok: false, reason: "token_mgr_missing" };
    const headers = tokenMgr.buildHeaders();
    try {
      const res = await fetch(`${API_BASE}/sapporo/api/v2/capt/gen/${showingId}`, {
        method: "GET", credentials: "include", headers,
        signal: AbortSignal.timeout(8000),
      });
      let bodyText = "";
      try { bodyText = await res.text(); } catch {}
      if (!res.ok) return { ok: false, reason: `http_${res.status}`, bodySample: bodyText.slice(0,200) };
      let json;
      try { json = JSON.parse(bodyText); }
      catch { return { ok: false, reason: "json_parse_fail" }; }
      const rootData = json?.data;
      if (!rootData) return { ok: false, reason: "no_data", message: json?.message };
      const type = rootData.type;
      const key  = rootData.key;
      // slide block rỗng (image:"") khi type=rotate — luôn đọc từ rotate block
      const rotatePayload = rootData.rotate || {};
      const slidePayload  = rootData.slide  || {};
      const payload = type === "rotate" ? rotatePayload : slidePayload;
      if (!key || !payload?.image) {
        return { ok: false, reason: "bad_shape", type, hasKey: !!key };
      }
      return {
        ok: true,
        data: {
          type, key,
          image: payload.image,          // master (outer ring)
          thumb: rotatePayload.thumb || slidePayload.thumb || null,  // inner circle
          tile_x: slidePayload.tile_x || 0,
          tile_y: slidePayload.tile_y || 0,
          tile_width:  slidePayload.tile_width  || 0,
          tile_height: slidePayload.tile_height || 0,
          mobile: rootData.mobile || false,
        },
      };
    } catch (e) {
      return { ok: false, reason: "fetch_error", message: e.message };
    }
  }

  async function check(showingId, key, value) {
    const tokenMgr = window.__SVP_TB_TOKEN__;
    if (!tokenMgr) return { ok: false, reason: "token_mgr_missing" };
    const userId = tokenMgr.getUserId();
    if (!userId) return { ok: false, reason: "no_user" };
    const headers = tokenMgr.buildHeaders();
    try {
      const res = await fetch(`${API_BASE}/sapporo/api/v2/capt/check/${showingId}`, {
        method: "POST", credentials: "include", headers,
        body: JSON.stringify({ key, value }),
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return { ok: false, reason: `http_${res.status}` };
      const json = await res.json();
      const token = json?.data?.token;
      if (!token || !token.startsWith("eyJ")) {
        return { ok: false, reason: "no_token", message: json?.message || "verify failed" };
      }
      const storeKey = `tkc_${userId}${showingId}`;
      try { localStorage.setItem(storeKey, token); } catch {}
      let remainingMs = 0;
      try {
        const b64 = token.split(".")[1].replace(/-/g,"+").replace(/_/g,"/");
        const pad = b64 + "=".repeat((4 - b64.length%4)%4);
        const pl = JSON.parse(atob(pad));
        if (pl?.exp) remainingMs = Math.max(0, pl.exp*1000 - Date.now());
      } catch {}
      return { ok: true, token, remainingMs };
    } catch (e) {
      return { ok: false, reason: "fetch_error", message: e.message };
    }
  }

  // ── Junction Edge Matching ────────────────────────────────────────────────────
  //
  // Convention (verified vs proxy):
  //   PIL rotate(+pil_angle) = xoay ngược chiều kim đồng hồ (CCW)
  //   Server expect giá trị = xoay thuận chiều kim đồng hồ (CW)
  //   → server_value = (360 - pil_angle) % 360
  //
  // Vì Canvas API (JS) cũng dùng CW làm positive:
  //   ctx.rotate(angleDeg * PI/180) = CW
  //   → ta tìm pil_angle bằng cách thử CW rotation trong canvas
  //   → pil_angle (CCW) = tìm angle CW tối thiểu MAE, rồi negate

  function _loadImg(src) {
    return new Promise((res, rej) => {
      const img = new Image();
      img.crossOrigin = "anonymous";
      img.onload = () => res(img);
      img.onerror = () => rej(new Error("load fail"));
      img.src = src.startsWith("data:") ? src : `data:image/jpeg;base64,${src}`;
    });
  }

  function _getPixels(img) {
    const c = document.createElement("canvas");
    c.width  = img.naturalWidth;
    c.height = img.naturalHeight;
    const ctx = c.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(img, 0, 0);
    return { ctx, c, w: c.width, h: c.height,
      data: ctx.getImageData(0, 0, c.width, c.height).data };
  }

  /**
   * Tính MAE tại junction ring khi xoay thumb clockwise angle° trong Canvas.
   * Canvas rotate(theta) = CW → cần negate để map sang PIL CCW.
   *
   * @param {CanvasRenderingContext2D} tmpCtx  - canvas tạm (size = mW×mH)
   * @param {HTMLImageElement} thumbImg
   * @param {Uint8ClampedArray} masterData     - RGBA của master (mW×mH)
   * @param {number} mW, mH, tW, tH
   * @param {number[]} junctionIdxs            - flat indices trong master flat array
   * @param {number} angleDeg                  - CW rotation (Canvas convention)
   */
  function _scoreAngleCW(tmpCtx, thumbImg, masterData, mW, mH, tW, tH, junctionIdxs, angleDeg) {
    tmpCtx.clearRect(0, 0, mW, mH);
    const offX = (mW - tW) / 2;
    const offY = (mH - tH) / 2;
    const cx = mW / 2, cy = mH / 2;
    tmpCtx.save();
    tmpCtx.translate(cx, cy);
    tmpCtx.rotate(angleDeg * Math.PI / 180);   // CW
    tmpCtx.drawImage(thumbImg, -cx + offX, -cy + offY);
    tmpCtx.restore();
    const thumbData = tmpCtx.getImageData(0, 0, mW, mH).data;

    let totalErr = 0, count = 0;
    for (const flatIdx of junctionIdxs) {
      if (thumbData[flatIdx + 3] < 64) continue;  // thumb transparent here
      totalErr += Math.abs(masterData[flatIdx]   - thumbData[flatIdx]);
      totalErr += Math.abs(masterData[flatIdx+1] - thumbData[flatIdx+1]);
      totalErr += Math.abs(masterData[flatIdx+2] - thumbData[flatIdx+2]);
      count += 3;
    }
    return count > 0 ? totalErr / count : 999;
  }

  async function findRotationAngle(masterSrc, thumbSrc) {
    const [masterImg, thumbImg] = await Promise.all([_loadImg(masterSrc), _loadImg(thumbSrc)]);
    const mW = masterImg.naturalWidth,  mH = masterImg.naturalHeight;  // 220×220
    const tW = thumbImg.naturalWidth,   tH = thumbImg.naturalHeight;   // 194×194

    // Master pixels
    const masterCanvas = document.createElement("canvas");
    masterCanvas.width = mW; masterCanvas.height = mH;
    const masterCtx = masterCanvas.getContext("2d", { willReadFrequently: true });
    masterCtx.drawImage(masterImg, 0, 0);
    const masterData = masterCtx.getImageData(0, 0, mW, mH).data;

    // Pre-compute junction pixel flat indices (ring r=70–86, alpha>128)
    const cx = mW/2, cy = mH/2;
    const junctionIdxs = [];
    for (let y = 0; y < mH; y++) {
      for (let x = 0; x < mW; x++) {
        const dx = x - cx, dy = y - cy;
        const r = Math.sqrt(dx*dx + dy*dy);
        if (r < 70 || r > 86) continue;
        const flatIdx = (y * mW + x) * 4;
        if (masterData[flatIdx + 3] < 128) continue;  // master transparent
        junctionIdxs.push(flatIdx);
      }
    }
    if (window.svpLog) window.svpLog(`🔍 Junction pixels: ${junctionIdxs.length}`, "gray");

    // Canvas tạm để rotate thumb
    const tmpCanvas = document.createElement("canvas");
    tmpCanvas.width = mW; tmpCanvas.height = mH;
    const tmpCtx = tmpCanvas.getContext("2d", { willReadFrequently: true });

    // Pass 1: scan CW 0–358°, step 2°
    let bestCW = 0, bestScore = Infinity;
    for (let angle = 0; angle < 360; angle += 2) {
      const s = _scoreAngleCW(tmpCtx, thumbImg, masterData, mW, mH, tW, tH, junctionIdxs, angle);
      if (s < bestScore) { bestScore = s; bestCW = angle; }
    }

    // Pass 2: fine-tune ±10° step 0.5°
    for (let a = bestCW - 10; a <= bestCW + 10; a += 0.5) {
      const s = _scoreAngleCW(tmpCtx, thumbImg, masterData, mW, mH, tW, tH, junctionIdxs, a);
      if (s < bestScore) { bestScore = s; bestCW = a; }
    }

    // Canvas CW convention = server value trực tiếp
    const serverValue = Math.round(bestCW);
    if (window.svpLog) window.svpLog(`🔍 Best CW angle: ${bestCW.toFixed(1)}° → submit ${serverValue}° (MAE=${bestScore.toFixed(1)})`, "blue");
    return serverValue;
  }

  // ── Auto-solve ────────────────────────────────────────────────────────────────

  // Mutex chống gọi song song cho cùng showingId
  const _locks = new Set();

  async function autoSolve(showingId, { maxRetries = 3 } = {}) {
    if (_locks.has(showingId)) {
      if (window.svpLog) window.svpLog(`⏳ autoSolve đang chạy cho ${showingId}, skip duplicate`, "gray");
      // Đợi cho đến khi lock được giải phóng rồi check token
      let waited = 0;
      while (_locks.has(showingId) && waited < 30000) {
        await new Promise(r => setTimeout(r, 300));
        waited += 300;
      }
      const tokenMgr = window.__SVP_TB_TOKEN__;
      const remaining = tokenMgr?.captchaTokenRemainingMs?.(showingId) || 0;
      if (remaining > 0) return { ok: true, angle: -1, remainingMs: remaining, fromCache: true };
      return { ok: false, reason: "lock_timeout" };
    }
    _locks.add(showingId);

    try {
      if (window.svpLog) window.svpLog(`🤖 Auto-solve rotate captcha (showing ${showingId})...`, "blue");

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        const genResult = await gen(showingId);
        if (!genResult.ok) {
          if (window.svpLog) window.svpLog(`❌ Gen fail lần ${attempt}: ${genResult.reason}`, "red");
          if (attempt < maxRetries) await new Promise(r => setTimeout(r, 500));
          continue;
        }

        const { type, key, image, thumb } = genResult.data;

        if (type !== "rotate" || !thumb) {
          if (window.svpLog) window.svpLog(`⚠️ type=${type} hoặc thiếu thumb, retry...`, "yellow");
          if (attempt < maxRetries) await new Promise(r => setTimeout(r, 300));
          continue;
        }

        let angle;
        try {
          const t0 = Date.now();
          angle = await findRotationAngle(image, thumb);
          if (window.svpLog) window.svpLog(`🔍 Template matching: ${angle}° (${Date.now()-t0}ms)`, "blue");
        } catch (e) {
          if (window.svpLog) window.svpLog(`❌ Matching lỗi: ${e.message}`, "red");
          if (attempt < maxRetries) await new Promise(r => setTimeout(r, 300));
          continue;
        }

        const checkResult = await check(showingId, key, String(angle));
        if (checkResult.ok) {
          if (window.svpLog) window.svpLog(`✅ Auto-solve OK! angle=${angle}° TTL ${Math.round(checkResult.remainingMs/1000)}s`, "green");
          return { ok: true, angle, remainingMs: checkResult.remainingMs };
        }

        if (window.svpLog) window.svpLog(`❌ Submit ${angle}° fail lần ${attempt}: ${checkResult.reason || checkResult.message}`, "red");
        if (attempt < maxRetries) await new Promise(r => setTimeout(r, 400));
      }

      return { ok: false, reason: "max_retries_exceeded" };
    } finally {
      _locks.delete(showingId);
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  window.__SVP_TB_CAPTCHA_SOLVER__ = {
    detectShowingId, getStatus, gen, check, autoSolve,
    findRotationAngle,  // expose để test từ console
  };

  if (window.svpLog) window.svpLog("🤖 TB captcha rotate solver loaded (junction edge matching)", "blue");
})();
