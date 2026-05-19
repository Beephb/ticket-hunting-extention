// src/content/utils.js
// Utilities dùng chung cho tất cả content scripts

const SVP_VERSION = "2.0.0";

// ── Logger ────────────────────────────────────────────────────────────────────

const LOG_COLORS = {
  green: "#22c55e", red: "#ef4444", yellow: "#facc15",
  blue: "#38bdf8", white: "#e2e8f0", gray: "#94a3b8",
};

function svpLog(msg, color = "white") {
  const clr = LOG_COLORS[color] || LOG_COLORS.white;
  console.log(`%c[SVP] ${msg}`, `color:${clr}; font-weight:bold`);
  // Gửi log về background để relay về App
  try {
    chrome.runtime.sendMessage({ type: "LOG", msg, color });
  } catch { /* extension context invalidated */ }
}

// ── Sleep ────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Normalize text (bỏ dấu) ──────────────────────────────────────────────────

function normText(s) {
  s = String(s || "").trim().toLowerCase();
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/_/g, " ").replace(/[^a-z0-9]+/g, " ").trim();
  return s.replace(/\s+/g, " ");
}

function normTokens(s) {
  return normText(s).split(" ").filter(Boolean);
}

// ── Wait for element ─────────────────────────────────────────────────────────

function waitForElement(selector, timeoutMs = 8000, intervalMs = 120) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);
    const start = Date.now();
    const iv = setInterval(() => {
      const el = document.querySelector(selector);
      if (el) { clearInterval(iv); resolve(el); return; }
      if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error(`Timeout: ${selector}`)); }
    }, intervalMs);
  });
}

function waitForTrue(fn, timeoutMs = 8000, intervalMs = 120) {
  return new Promise((resolve, reject) => {
    if (fn()) return resolve(true);
    const start = Date.now();
    const iv = setInterval(() => {
      if (fn()) { clearInterval(iv); resolve(true); return; }
      if (Date.now() - start > timeoutMs) { clearInterval(iv); reject(new Error("Timeout")); }
    }, intervalMs);
  });
}

// ── Detect platform ───────────────────────────────────────────────────────────

function detectPlatform() {
  const host = location.hostname;
  if (host.includes("1zone")) return "1Zone";
  if (host.includes("ticketbox")) return "Ticketbox";
  return null;
}

// ── Detect page type ──────────────────────────────────────────────────────────

function detectPageType() {
  const path = location.pathname;
  if (/\/booking\//.test(path)) return "booking_1zone";
  if (/\/events\/\d+\/bookings\/\d+\/select-ticket/.test(path)) return "select_ticket_tb";
  if (/\/events\//.test(path)) return "event";
  if (/\/checkout/.test(path) || /\/order\//.test(path)) return "checkout";
  return "other";
}

// ── Simulate real mouse click ─────────────────────────────────────────────────

async function realClick(x, y) {
  const el = document.elementFromPoint(x, y);
  const evOpts = {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
    screenX: x, screenY: y, view: window,
  };
  document.dispatchEvent(new MouseEvent("mousemove", evOpts));
  await sleep(20);
  if (el) {
    el.dispatchEvent(new MouseEvent("mousedown", evOpts));
    await sleep(30);
    el.dispatchEvent(new MouseEvent("mouseup", evOpts));
    el.dispatchEvent(new MouseEvent("click", evOpts));
  }
  await sleep(80);
}

// ── Debug: element tại tọa độ ────────────────────────────────────────────────

function elemAt(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return "none";
  const r = el.getBoundingClientRect();
  return `${el.tagName}.${String(el.className || "").replace(/\s+/g, ".")} `
    + `text=${String(el.innerText || "").trim().slice(0, 60)} `
    + `box=${Math.round(r.left)},${Math.round(r.top)},${Math.round(r.width)}x${Math.round(r.height)}`;
}
