// src/shared/logger.js
// Logger trung tâm — mọi log đi qua đây.
// Backward compat: vẫn expose svpLog() global như utils.js cũ.
// Mới: svpEvent(eventName, data) — structured log gửi về desktop.

const SVP_LOG_COLORS = {
  green: "#22c55e",
  red: "#ef4444",
  yellow: "#facc15",
  blue: "#38bdf8",
  white: "#e2e8f0",
  gray: "#94a3b8",
};

// Console log + relay về desktop qua background
function svpLog(msg, color = "white") {
  const clr = SVP_LOG_COLORS[color] || SVP_LOG_COLORS.white;
  try {
    console.log(`%c[SVP] ${msg}`, `color:${clr}; font-weight:bold`);
  } catch {}

  // Mask token nếu có trong msg
  let safeMsg = String(msg);
  if (window.SVP_MASK) {
    safeMsg = safeMsg
      .replace(/Bearer\s+([A-Za-z0-9._-]+)/gi, (_, t) => "Bearer " + window.SVP_MASK.maskToken(t))
      .replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, m => window.SVP_MASK.maskEmail(m))
      .replace(/(\b0\d{2})\d{4}(\d{3}\b)/g, "$1****$2");
  }

  try {
    chrome.runtime.sendMessage({ type: "LOG", msg: safeMsg, color });
  } catch {
    // extension context invalidated
  }
}

// Structured event — gửi về desktop với platform/phase/event/data
function svpEvent(eventName, data = {}, opts = {}) {
  const payload = {
    platform: opts.platform || _detectPlatformSafe(),
    phase: opts.phase || "",
    event: eventName,
    timestamp: Date.now(),
    durationMs: opts.durationMs ?? null,
    data: window.SVP_MASK ? window.SVP_MASK.maskPayload(data) : data,
  };

  try {
    console.log(`%c[SVP-EVT] ${eventName}`, `color:${SVP_LOG_COLORS.blue}; font-weight:bold`, payload);
  } catch {}

  try {
    chrome.runtime.sendMessage({
      type: "EVENT",
      payload,
    });
  } catch {}
}

function _detectPlatformSafe() {
  try {
    const host = location.hostname;
    if (host.includes("1zone")) return "1zone";
    if (host.includes("ticketbox")) return "ticketbox";
  } catch {}
  return "unknown";
}

// Backward compat globals
window.svpLog = svpLog;
window.svpEvent = svpEvent;
window.SVP_LOG_COLORS = SVP_LOG_COLORS;
