// src/platforms/ticketbox/queue_watcher.js
// Poll /queue/v1/showing/{showingId}/status — tự RESUME khi đến lượt (BOOKING).
//
// Ticketbox queue flow (xác nhận từ proxy capture):
//   GET /queue/v1/showing/{showingId}/status?version=v2&step=waiting_queue
//   Headers: x-tb-access-token, x-tb-captcha-token
//
//   Response QUEUE:   { status:"QUEUE",   position:238, intervalTimeSeconds:10, queueId:"..." }
//   Response BOOKING: { status:"BOOKING", expireIn:590, intervalTimeSeconds:10, queueId:"..." }

(function () {
  if (window.__SVP_TB_QUEUE__) return;

  const API_BASE = "https://api-v2.ticketbox.vn";

  /**
   * Poll waiting room cho đến khi countdown = 0 (browser sẽ tự navigate sang /queue/).
   * Chỉ cần show UI countdown — không cần handle transition vì Ticketbox JS tự làm.
   *
   * @param {string} showingId
   * @param {string} captchaToken  — JWT từ /capt/check
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=3600000]  — timeout tổng (default 60 phút)
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async function waitForWaitingRoom(showingId, captchaToken, opts = {}) {
    const { timeoutMs = 3600000 } = opts;
    const tokenMgr = window.__SVP_TB_TOKEN__;
    if (!tokenMgr) return { ok: false, reason: "token_mgr_missing" };

    const API_BASE_URL = "https://api-v2.ticketbox.vn";
    const deadline = Date.now() + timeoutMs;

    if (window.svpLog) window.svpLog(`⏳ Waiting room showing ${showingId} — bắt đầu poll...`, "yellow");
    if (typeof window.showIndicator === "function")
      window.showIndicator("🟡 Phòng chờ...", "Đang chờ mở bán", "#facc15");

    let prevT = null; // rolling t param từ response trước
    let pollCount = 0;

    while (Date.now() < deadline) {
      if (window.svpShouldStop?.()) {
        if (window.svpLog) window.svpLog("🛑 Dừng waiting room poll theo stop signal", "red");
        return { ok: false, reason: "stopped" };
      }

      // Build URL: lần đầu không có t, các lần sau pass t từ response trước
      const url = prevT
        ? `${API_BASE_URL}/queue/v1/showing/${showingId}/status?version=v2&t=${prevT}&step=waiting_room`
        : `${API_BASE_URL}/queue/v1/showing/${showingId}/status?version=v2&step=waiting_room`;

      const baseHeaders = tokenMgr.buildHeaders();
      const headers = {
        ...baseHeaders,
        "x-tb-captcha-token": captchaToken,
      };

      let intervalMs = 10000;

      try {
        const res = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers,
          signal: AbortSignal.timeout(8000),
        });

        if (!res.ok) {
          if (window.svpLog) window.svpLog(`⚠️ Waiting room API HTTP=${res.status} — thử lại...`, "yellow");
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        const json = await res.json();
        const data = json?.data;
        const status = data?.status;
        const countdown = data?.countdown ?? null;
        pollCount++;

        // Lưu t để dùng cho poll tiếp theo
        if (data?.t) prevT = data.t;
        intervalMs = (data?.intervalTimeSeconds || 10) * 1000;

        if (window.svpLog && pollCount % 3 === 1) {
          // Log mỗi 3 lần để không spam
          window.svpLog(`⏳ Waiting room: countdown=${countdown}s (poll #${pollCount})`, "yellow");
        }

        if (typeof window.showIndicator === "function") {
          const countdownTxt = countdown !== null ? `Còn ${countdown}s` : "Đang chờ...";
          window.showIndicator("🟡 Phòng chờ", countdownTxt, "#facc15");
        }

        window.dispatchEvent(new CustomEvent("svp_queue_update", {
          detail: { status: "WAITING_ROOM", countdown }
        }));

        // Khi countdown = 0, Ticketbox JS sẽ tự navigate sang /queue/
        // Bot không cần làm gì — chỉ cần dừng poll và chờ
        if (countdown === 0) {
          if (window.svpLog) window.svpLog("✅ Waiting room countdown = 0 — chờ browser navigate sang /queue/...", "green");
          if (typeof window.showIndicator === "function")
            window.showIndicator("🚀 Mở bán!", "Đang vào hàng đợi...", "#22c55e");
          return { ok: true };
        }

        // Nếu status không phải WAITING_ROOM (edge case)
        if (status && status !== "WAITING_ROOM") {
          if (window.svpLog) window.svpLog(`⚠️ Waiting room status lạ: "${status}" — dừng poll`, "yellow");
          return { ok: true }; // vẫn ok, để flow tiếp tục
        }

      } catch (e) {
        if (window.svpLog) window.svpLog(`⚠️ Waiting room poll lỗi: ${e.message}`, "yellow");
        intervalMs = 5000;
      }

      // Đợi intervalMs (chia nhỏ để check stop signal)
      const waitEnd = Date.now() + intervalMs;
      while (Date.now() < waitEnd) {
        if (window.svpShouldStop?.()) return { ok: false, reason: "stopped" };
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (window.svpLog) window.svpLog("⏰ Waiting room timeout — dừng bot", "red");
    return { ok: false, reason: "timeout" };
  }

  /**
   * Lấy showingId từ URL waiting room: /waiting-room/{showingId}
   */
  function getShowingIdFromWaitingRoomUrl() {
    try {
      const m = location.href.match(/\/waiting-room\/(\d{6,})/);
      if (m) return m[1];
    } catch {}
    return null;
  }

  /**
   * Poll queue cho đến khi status = BOOKING hoặc timeout.
   *
   * @param {string} showingId
   * @param {string} captchaToken  — JWT từ /capt/check (x-tb-captcha-token header)
   * @param {object} [opts]
   * @param {number} [opts.timeoutMs=900000]  — timeout tổng (default 15 phút)
   * @param {function} [opts.onPosition]       — callback(position) mỗi lần poll có position
   * @returns {Promise<{ok:boolean, expireIn?:number, reason?:string}>}
   */
  async function waitForBookingTurn(showingId, captchaToken, opts = {}) {
    const { timeoutMs = 900000, onPosition } = opts;
    const tokenMgr = window.__SVP_TB_TOKEN__;
    if (!tokenMgr) return { ok: false, reason: "token_mgr_missing" };

    const url = `${API_BASE}/queue/v1/showing/${showingId}/status?version=v2&step=waiting_queue`;
    const deadline = Date.now() + timeoutMs;

    if (window.svpLog) window.svpLog(`⏳ Vào queue showing ${showingId} — bắt đầu poll...`, "yellow");
    if (typeof window.showIndicator === "function")
      window.showIndicator("🟡 Trong hàng đợi...", "Đang chờ đến lượt", "#facc15");

    let lastPosition = null;
    let pollCount = 0;

    while (Date.now() < deadline) {
      if (window.svpShouldStop?.()) {
        if (window.svpLog) window.svpLog("🛑 Dừng queue poll theo stop signal", "red");
        return { ok: false, reason: "stopped" };
      }

      // Build headers: cần cả access-token + captcha-token
      const baseHeaders = tokenMgr.buildHeaders();
      const headers = {
        ...baseHeaders,
        "x-tb-captcha-token": captchaToken,
      };

      let intervalMs = 10000; // default poll mỗi 10s theo server

      try {
        const res = await fetch(url, {
          method: "GET",
          credentials: "include",
          headers,
          signal: AbortSignal.timeout(8000),
        });

        if (!res.ok) {
          if (window.svpLog) window.svpLog(`⚠️ Queue API HTTP=${res.status} — thử lại...`, "yellow");
          await new Promise(r => setTimeout(r, 5000));
          continue;
        }

        const json = await res.json();
        const data = json?.data;
        const status = data?.status;
        pollCount++;

        if (status === "BOOKING") {
          const expireIn = data?.expireIn || 0;
          if (window.svpLog) window.svpLog(`✅ Đến lượt! expireIn=${expireIn}s — RESUME bot`, "green");
          if (typeof window.showIndicator === "function")
            window.showIndicator("🚀 Đến lượt! Đang chọn ghế...", `Còn ${expireIn}s để hoàn tất`, "#22c55e");

          // Cập nhật popup qua event
          window.dispatchEvent(new CustomEvent("svp_queue_update", {
            detail: { status: "BOOKING", expireIn }
          }));

          return { ok: true, expireIn };
        }

        if (status === "QUEUE") {
          const position = data?.position;
          intervalMs = (data?.intervalTimeSeconds || 10) * 1000;

          // Chỉ log khi position thay đổi hoặc poll đầu tiên
          if (position !== lastPosition) {
            if (window.svpLog) window.svpLog(`⏳ Hàng đợi: vị trí #${position} (poll #${pollCount})`, "yellow");
            lastPosition = position;
          }

          // Cập nhật popup
          window.dispatchEvent(new CustomEvent("svp_queue_update", {
            detail: { status: "QUEUE", position, expireIn: Math.round((deadline - Date.now()) / 1000) }
          }));

          if (typeof onPosition === "function") onPosition(position);

          // Cập nhật indicator
          if (typeof window.showIndicator === "function")
            window.showIndicator(`🟡 Hàng đợi #${position}`, `Poll mỗi ${Math.round(intervalMs / 1000)}s`, "#facc15");

        } else {
          // Status không rõ (có thể hết hạn, bị kick khỏi queue...)
          if (window.svpLog) window.svpLog(`⚠️ Queue status lạ: "${status}" — kiểm tra lại`, "yellow");
          // Không return ngay, thử thêm vài lần
          if (pollCount > 5) {
            return { ok: false, reason: `unexpected_status_${status || "null"}` };
          }
        }

      } catch (e) {
        if (window.svpLog) window.svpLog(`⚠️ Queue poll lỗi: ${e.message}`, "yellow");
        intervalMs = 5000; // giảm interval khi có lỗi
      }

      // Đợi intervalMs trước poll tiếp theo (chia nhỏ để check stop signal)
      const waitEnd = Date.now() + intervalMs;
      while (Date.now() < waitEnd) {
        if (window.svpShouldStop?.()) return { ok: false, reason: "stopped" };
        await new Promise(r => setTimeout(r, 500));
      }
    }

    if (window.svpLog) window.svpLog("⏰ Queue timeout — dừng bot", "red");
    return { ok: false, reason: "timeout" };
  }

  /**
   * Phát hiện trang hiện tại có phải trang queue không.
   * Dùng để auto-start queue watcher khi bot navigate sang /queue/
   */
  function isOnQueuePage() {
    const url = location.href.toLowerCase();
    if (url.includes("/queue/")) return true;

    // Kiểm tra DOM: có hiển thị queue UI không
    const txt = (document.body?.innerText || "").toLowerCase();
    const hasQueueText =
      txt.includes("hàng chờ") ||
      txt.includes("đang xếp hàng") ||
      txt.includes("vị trí") ||
      txt.includes("số người đứng trước") ||
      txt.includes("waiting");

    return hasQueueText;
  }

  /**
   * Lấy showingId từ URL queue page: /queue/{showingId}
   */
  function getShowingIdFromQueueUrl() {
    try {
      const m = location.href.match(/\/queue\/(\d{6,})/);
      if (m) return m[1];
    } catch {}
    return null;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  window.__SVP_TB_QUEUE__ = {
    waitForBookingTurn,
    waitForWaitingRoom,
    isOnQueuePage,
    getShowingIdFromQueueUrl,
    getShowingIdFromWaitingRoomUrl,
  };

  if (window.svpLog) window.svpLog("⏳ TB queue watcher loaded", "blue");
})();