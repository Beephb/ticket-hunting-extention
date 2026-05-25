// src/utils/rate_limit.js
// Rate limit tracker với exponential backoff per host.
//
// Cách dùng:
//   const rl = window.SVP_RATE_LIMIT.forHost('api-v2.ticketbox.vn');
//   const res = await fetch(url, ...);
//   if (res.status === 429 || res.status === 503) {
//     const wait = rl.onError429(res.status);
//     if (wait < 0) {
//       svpLog("🛑 Rate limit critical — pause", "red");
//       return; // abort caller
//     }
//     await sleep(wait);
//     continue;  // retry
//   }
//   rl.onSuccess();
//
// Backoff curve: [500, 1000, 2000, 4000, 8000] ms + jitter ±20%
// Sau 5 lần consecutive → return -1 (caller phải pause).
// Reset counter sau 60s không lỗi.

(function() {
  if (window.SVP_RATE_LIMIT) return;

  const BACKOFF_MS    = [500, 1000, 2000, 4000, 8000];  // exponential
  const MAX_CONSECUTIVE = 5;     // sau 5 lần liên tục → abort
  const RESET_WINDOW_MS = 60000; // 60s không lỗi → reset counter

  class RateLimitTracker {
    constructor(host) {
      this.host = host;
      this.consecutiveErrors = 0;
      this.lastErrorTs = 0;
      this.lastErrorStatus = 0;
      this.totalErrors = 0;
    }

    /**
     * Gọi khi nhận response 429 hoặc 503.
     * @param {number} status
     * @returns {number} ms to sleep. -1 nếu vượt MAX_CONSECUTIVE (caller phải abort).
     */
    onError429(status = 429) {
      this.consecutiveErrors++;
      this.lastErrorTs = Date.now();
      this.lastErrorStatus = status;
      this.totalErrors++;

      if (this.consecutiveErrors >= MAX_CONSECUTIVE) {
        if (window.svpLog) {
          window.svpLog(`🚨 RATE LIMIT CRITICAL: ${this.host} bị block ${this.consecutiveErrors} lần liên tục (status ${status}) — abort để tránh ban IP`, "red");
        }
        return -1;
      }

      // Exponential backoff với jitter
      const idx = Math.min(this.consecutiveErrors - 1, BACKOFF_MS.length - 1);
      const base = BACKOFF_MS[idx];
      const jitter = base * 0.2 * (Math.random() * 2 - 1);  // ±20%
      const wait = Math.round(base + jitter);

      if (window.svpLog) {
        window.svpLog(`⏸ Rate limit ${this.host}: status=${status} (#${this.consecutiveErrors}/${MAX_CONSECUTIVE}) — sleep ${wait}ms`, "yellow");
      }
      return wait;
    }

    /**
     * Gọi khi response thành công (2xx).
     * Reset counter nếu đã qua RESET_WINDOW_MS không lỗi.
     */
    onSuccess() {
      if (this.consecutiveErrors > 0 && Date.now() - this.lastErrorTs > RESET_WINDOW_MS) {
        if (window.svpLog) {
          window.svpLog(`✅ Rate limit ${this.host}: reset counter (${this.consecutiveErrors} → 0)`, "gray");
        }
        this.consecutiveErrors = 0;
      }
    }

    /** Manual reset — dùng khi user bấm Hunt lại. */
    reset() {
      this.consecutiveErrors = 0;
      this.lastErrorTs = 0;
    }

    status() {
      return {
        host: this.host,
        consecutiveErrors: this.consecutiveErrors,
        totalErrors: this.totalErrors,
        lastErrorTs: this.lastErrorTs,
        lastErrorStatus: this.lastErrorStatus,
        critical: this.consecutiveErrors >= MAX_CONSECUTIVE,
      };
    }
  }

  // ── Public API ───────────────────────────────────────────────────────────────
  window.SVP_RATE_LIMIT = {
    _trackers: {},

    /** Lấy tracker cho 1 host. Tự tạo nếu chưa có. */
    forHost(host) {
      if (!this._trackers[host]) {
        this._trackers[host] = new RateLimitTracker(host);
      }
      return this._trackers[host];
    },

    /** Reset tất cả trackers (dùng khi Hunt restart). */
    resetAll() {
      for (const t of Object.values(this._trackers)) t.reset();
    },

    /** Snapshot status cho debug. */
    statusAll() {
      return Object.values(this._trackers).map(t => t.status());
    },
  };

  if (window.svpLog) {
    window.svpLog("🚦 Rate limit tracker loaded (exp backoff per host)", "blue");
  }
})();
