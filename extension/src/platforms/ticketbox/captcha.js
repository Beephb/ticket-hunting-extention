// src/platforms/ticketbox/captcha.js
// Ticketbox captcha detector + manual-wait helper.
//
// v5 — bỏ hoàn toàn auto-solve, giữ flow:
//   1. Token valid  → proceed ngay
//   2. Captcha chưa hiện → đợi tối đa 6s
//   3. Captcha hiện → alert + sound + pause bot, poll 200ms chờ token hoặc overlay đóng
//   4. Timeout 90s → abort

(function () {
  if (window.__SVP_TB_CAPTCHA__) return;

  // ── DOM detect ────────────────────────────────────────────────────────────────

  function _isVisible(el) {
    try {
      let cur = el;
      while (cur && cur !== document.body) {
        const st = window.getComputedStyle(cur);
        if (st.display === "none" || st.visibility === "hidden") return false;
        if (parseFloat(st.opacity || "1") < 0.05) return false;
        cur = cur.parentElement;
      }
      return true;
    } catch { return false; }
  }

  function isCaptchaVisible() {
    try {
      const selectors = [
        "[class*='go-captcha']",
        "[class*='goCaptcha']",
        "[class*='rotate-captcha']",
        "[class*='captcha-rotate']",
        "[class*='captcha-slide']",
      ];
      for (const sel of selectors) {
        const el = document.querySelector(sel);
        if (el && _isVisible(el)) return true;
      }
      const modals = document.querySelectorAll(
        ".ReactModal__Content--after-open, .ant-modal-content, [role='dialog']"
      );
      for (const modal of modals) {
        if (!_isVisible(modal)) continue;
        const txt = (modal.innerText || "").toLowerCase();
        if (["xác minh", "captcha", "xoay", "trượt"].some(k => txt.includes(k))) return true;
      }
      return false;
    } catch { return false; }
  }

  // ── Alert + sound khi captcha xuất hiện ──────────────────────────────────────

  function _alertUser() {
    // Âm thanh beep qua Web Audio API
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // 3 beep ngắn
      [0, 0.25, 0.5].forEach(offset => {
        const osc  = ctx.createOscillator();
        const gain = ctx.createGain();
        osc.connect(gain);
        gain.connect(ctx.destination);
        osc.frequency.value = 880;
        gain.gain.setValueAtTime(0.3, ctx.currentTime + offset);
        gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + offset + 0.2);
        osc.start(ctx.currentTime + offset);
        osc.stop(ctx.currentTime + offset + 0.2);
      });
    } catch {}

    // Indicator overlay
    if (typeof window.showIndicator === "function") {
      window.showIndicator(
        "🧩 CẦN GIẢI CAPTCHA",
        "Bot đang dừng — xoay ảnh rồi bot tự chạy tiếp",
        "#f97316"
      );
    }
  }

  // ── Token cache ───────────────────────────────────────────────────────────────

  function _hasCachedToken(showingId) {
    return !!window.__SVP_TB_TOKEN__?.getCaptchaToken(String(showingId));
  }

  // ── waitForResolved ───────────────────────────────────────────────────────────

  async function waitForResolved(showingId, timeoutMs = 90000) {
    const sid = String(showingId);

    // Step 1: token đã có → proceed ngay
    if (_hasCachedToken(sid)) {
      if (window.svpLog) window.svpLog("🧩 Captcha token cached — proceed", "gray");
      return true;
    }

    if (window.__SVP_TB_TOKEN__?.isCaptchaExpired?.(sid)) {
      if (window.svpLog) window.svpLog("⚠️ Captcha token EXPIRED — cần giải lại", "yellow");
    }

    // Step 2: đợi captcha hiện (tối đa 6s)
    if (!isCaptchaVisible()) {
      if (window.svpLog) window.svpLog("🧩 Chờ captcha overlay hiện (max 6s)...", "gray");
      const appear = Date.now() + 6000;
      while (Date.now() < appear) {
        if (window.svpShouldStop?.()) return false;
        await new Promise(r => setTimeout(r, 300));
        if (_hasCachedToken(sid)) return true;   // token xuất hiện trong lúc chờ
        if (isCaptchaVisible()) break;
      }
      // Sau 6s vẫn không thấy captcha → không cần giải, proceed
      if (!isCaptchaVisible()) {
        if (window.svpLog) window.svpLog("ℹ️ Captcha không hiện sau 6s — proceed", "gray");
        return true;
      }
    }

    // Step 3: captcha đang hiện → alert user + pause
    if (window.svpLog)
      window.svpLog(`🧩 CAPTCHA xuất hiện — bot dừng, chờ user giải (max ${Math.round(timeoutMs/1000)}s)`, "yellow");
    _alertUser();

    const deadline = Date.now() + timeoutMs;
    let lastLog    = 0;
    let goneCount  = 0;

    while (Date.now() < deadline) {
      if (window.svpShouldStop?.()) return false;
      await new Promise(r => setTimeout(r, 200));

      // Token cached → solved
      if (_hasCachedToken(sid)) {
        if (window.svpLog) window.svpLog("✅ Captcha solved — bot tiếp tục", "green");
        if (typeof window.showIndicator === "function")
          window.showIndicator("✅ Captcha OK", "Bot tiếp tục...", "#22c55e");
        await new Promise(r => setTimeout(r, 300));
        return true;
      }

      // Overlay biến mất 3 checks liên tiếp → solved
      if (!isCaptchaVisible()) {
        goneCount++;
        if (goneCount >= 3) {
          if (window.svpLog) window.svpLog("✅ Captcha overlay đóng — bot tiếp tục", "green");
          if (typeof window.showIndicator === "function")
            window.showIndicator("✅ Captcha OK", "Bot tiếp tục...", "#22c55e");
          await new Promise(r => setTimeout(r, 300));
          return true;
        }
      } else {
        goneCount = 0;
      }

      // Log nhắc nhở mỗi 10s
      if (Date.now() - lastLog > 10000) {
        const rem = Math.round((deadline - Date.now()) / 1000);
        if (window.svpLog) window.svpLog(`⏳ Đang chờ user giải captcha... còn ${rem}s`, "yellow");
        lastLog = Date.now();
      }
    }

    if (window.svpLog) window.svpLog("⏰ Captcha timeout 90s — abort", "red");
    return false;
  }

  // ── Public API ───────────────────────────────────────────────────────────────

  window.__SVP_TB_CAPTCHA__ = {
    isVisible: isCaptchaVisible,
    hasCachedToken: _hasCachedToken,
    waitForResolved,
  };

  if (window.svpLog) window.svpLog("🧩 TB captcha helper loaded (v5 — manual wait + alert)", "blue");
})();
