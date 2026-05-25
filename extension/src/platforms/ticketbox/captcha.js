// src/platforms/ticketbox/captcha.js
// Ticketbox slide captcha detector + wait helper.
//
// Captcha pattern (verified từ proxy HAR):
//   - GET /sapporo/api/v2/capt/gen/{showingId} → returns data:image/jpeg base64 background
//   - User solve slide → POST /sapporo/api/v2/capt/check → JWT token
//   - Token cached vào localStorage[`tkc_${userId}${showingId}`] TTL 1h
//
// Bot dùng helper này để pause khi captcha overlay đang hiển thị,
// chờ user solve, rồi mới tiếp tục flow chọn ghế.
//
// REWRITE 2026-05-25:
//   - Detector tighter: check parent visibility (display/opacity/hidden)
//   - waitForResolved: poll 200ms, watch localStorage event
//   - Proactive wait: poll 6s đầu xem captcha có appear không trước khi proceed
//   - Stop signal aware (svpShouldStop)

(function() {
  if (window.__SVP_TB_CAPTCHA__) return;

  function _isVisibleElement(el) {
    try {
      let cur = el;
      while (cur && cur !== document.body) {
        const st = window.getComputedStyle(cur);
        if (st.display === "none") return false;
        if (st.visibility === "hidden") return false;
        if (parseFloat(st.opacity || "1") < 0.05) return false;
        cur = cur.parentElement;
      }
      return true;
    } catch { return false; }
  }

  /**
   * Detect captcha slide modal đang VISIBLE thật (chưa bị ẩn).
   * Slide captcha signature: img với src="data:image/jpeg;base64,..." kích thước > 100x60.
   * Cộng thêm check parent chain visible để tránh false positive khi modal đóng nhưng DOM còn.
   */
  function isCaptchaVisible() {
    try {
      const imgs = document.querySelectorAll('img[src^="data:image/jpeg"]');
      for (const img of imgs) {
        const r = img.getBoundingClientRect();
        if (r.width < 100 || r.height < 60) continue;
        if (!_isVisibleElement(img)) continue;
        return true;
      }
      // Fallback: modal chứa text captcha + canvas
      const modals = document.querySelectorAll(
        '.ReactModal__Content--after-open, .ant-modal-content, [role="dialog"][data-state="open"]'
      );
      for (const m of modals) {
        if (!_isVisibleElement(m)) continue;
        const r = m.getBoundingClientRect();
        if (!r || r.width < 100) continue;
        const txt = String(m.innerText || "").toLowerCase();
        const hasText = ["trượt", "kéo", "xác minh", "captcha"].some(k => txt.includes(k));
        if (hasText && m.querySelector("canvas, img")) return true;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Quick check 1 lần — captcha đang hiện?
   * Dùng cho proactive detection (chờ captcha appear sau page load).
   */
  function _hasCachedToken(showingId) {
    const tokenMgr = window.__SVP_TB_TOKEN__;
    return !!tokenMgr?.getCaptchaToken(String(showingId));
  }

  /**
   * Chờ captcha được giải.
   *
   * Logic mới:
   *   1. Nếu đã có cached token valid → return ngay
   *   2. Poll 6s xem captcha có appear naturally không (Q1: proactive wait)
   *      - Nếu thấy captcha visible → break sang main wait loop
   *      - Nếu token appear giữa chừng → return true
   *      - Nếu 6s không thấy gì → return true (assume không cần captcha)
   *   3. Main wait loop (Q2: poll 200ms, double-check 2 conditions)
   *      - Token cached → solved (chính tắc nhất)
   *      - Hoặc captcha overlay gone — wait 1s confirm rồi return
   *
   * @returns {Promise<boolean>} true nếu solved/no-need, false nếu timeout/stop
   */
  async function waitForResolved(showingId, timeoutMs = 90000) {
    const tokenMgr = window.__SVP_TB_TOKEN__;
    const showingStr = String(showingId);

    // Step 1: Token đã cached + valid → skip ngay
    if (_hasCachedToken(showingStr)) {
      if (window.svpLog) window.svpLog(`🧩 Captcha đã có token cache cho showing ${showingStr} — proceed`, "gray");
      return true;
    }

    // Log trạng thái token CHỈ 1 LẦN trước khi vào loop (tránh spam)
    const wasExpired = tokenMgr?.isCaptchaExpired(showingStr);
    if (wasExpired) {
      if (window.svpLog) window.svpLog(`⚠️ TB captcha_token EXPIRED cho showing ${showingStr} — chờ user giải lại`, "yellow");
    } else {
      if (window.svpLog) window.svpLog(`ℹ️ TB chưa có captcha cho showing ${showingStr} — chờ user giải`, "gray");
    }

    // Step 2: Proactive wait 6s xem captcha có appear không (Q1)
    if (window.svpLog) window.svpLog(`🧩 Captcha gate: poll 6s xem captcha có hiện không...`, "gray");
    const initialDeadline = Date.now() + 6000;
    while (Date.now() < initialDeadline) {
      if (window.svpShouldStop?.()) return false;
      await new Promise(r => setTimeout(r, 300));
      if (_hasCachedToken(showingStr)) {
        if (window.svpLog) window.svpLog("🧩 Captcha solved (token vừa appear)", "green");
        return true;
      }
      if (isCaptchaVisible()) {
        if (window.svpLog) window.svpLog("🧩 Captcha modal xuất hiện — sang main wait loop", "yellow");
        break;
      }
    }

    // Sau 6s không thấy captcha + không có cache → assume không cần
    if (!isCaptchaVisible() && !_hasCachedToken(showingStr)) {
      if (wasExpired) {
        // Token EXPIRED mà captcha không tự hiện → user cần click zone manually để trigger
        if (window.svpLog) {
          window.svpLog(`⚠️ Captcha hết hạn nhưng không tự mở. Bot sẽ thử reserve (có thể fail).`, "yellow");
          window.svpLog(`   → Nếu fail: click 1 zone bất kỳ trên trang để mở captcha, giải xong bấm Alt+2 lại.`, "yellow");
        }
      } else {
        if (window.svpLog) window.svpLog("ℹ️ Sau 6s không thấy captcha modal — assume không cần, proceed", "gray");
      }
      return true;
    }

    // Step 3: Main wait loop (poll 200ms cho responsive)
    if (window.svpLog) {
      window.svpLog(`🧩 Captcha đang hiện — pause bot, chờ user giải (max ${Math.round(timeoutMs/1000)}s)`, "yellow");
    }
    if (typeof window.showIndicator === "function") {
      window.showIndicator("🧩 Đang chờ user giải Captcha", "Bot pause cho đến khi solved", "#f97316");
    }

    const deadline = Date.now() + timeoutMs;
    let lastLog = 0;
    let consecutiveGoneChecks = 0;

    while (Date.now() < deadline) {
      if (window.svpShouldStop?.()) return false;
      await new Promise(r => setTimeout(r, 200));

      // Condition 1: token cached (most reliable signal)
      if (_hasCachedToken(showingStr)) {
        if (window.svpLog) window.svpLog("✅ Captcha solved (token cached vào localStorage)", "green");
        await new Promise(r => setTimeout(r, 400)); // brief settle
        return true;
      }

      // Condition 2: overlay gone — require 3 consecutive checks (600ms) để chắc chắn
      if (!isCaptchaVisible()) {
        consecutiveGoneChecks++;
        if (consecutiveGoneChecks >= 3) {
          if (window.svpLog) window.svpLog("✅ Captcha overlay đã đóng (3 checks confirm)", "green");
          await new Promise(r => setTimeout(r, 400));
          return true;
        }
      } else {
        consecutiveGoneChecks = 0;
      }

      // Log mỗi 10s
      if (Date.now() - lastLog > 10000) {
        if (window.svpLog) {
          const remaining = Math.round((deadline - Date.now()) / 1000);
          window.svpLog(`⏳ Vẫn chờ user giải captcha... còn ${remaining}s`, "yellow");
        }
        lastLog = Date.now();
      }
    }

    if (window.svpLog) {
      window.svpLog(`⏰ Captcha timeout sau ${Math.round(timeoutMs/1000)}s — abort flow`, "red");
    }
    return false;
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  window.__SVP_TB_CAPTCHA__ = {
    isVisible: isCaptchaVisible,
    hasCachedToken: _hasCachedToken,
    waitForResolved,
  };

  if (window.svpLog) {
    window.svpLog("🧩 TB captcha helper loaded (v2 — Q1+Q2 fix)", "blue");
  }
})();
