// src/content/utils.js
// Utilities dùng chung cho tất cả content scripts.
// NOTE: svpLog + LOG_COLORS đã chuyển sang src/shared/logger.js
// File này giữ lại sleep, normText, waitForElement, detectPlatform, realClick...

const SVP_VERSION = "2.0.0";

// ── Sleep ────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Cooperative cancellation (STOP_HUNT signal) ──────────────────────────────
// runner.js set window.__SVP_STOP_REQUESTED__ = true khi user bấm Dừng Hunt.
// Tất cả loop dài trong seat_*.js, hunt_*.js phải check qua svpShouldStop() để
// có thể abort sớm thay vì chạy đến hết timeout.
window.__SVP_STOP_REQUESTED__ = false;

function svpShouldStop() {
  return !!window.__SVP_STOP_REQUESTED__;
}

function svpResetStop() {
  window.__SVP_STOP_REQUESTED__ = false;
}

function svpRequestStop() {
  window.__SVP_STOP_REQUESTED__ = true;
}

// Sleep có check stop. Trả false nếu bị stop, true nếu sleep đủ thời gian.
async function svpSleep(ms) {
  const start = Date.now();
  const chunk = Math.min(ms, 100);
  while (Date.now() - start < ms) {
    if (svpShouldStop()) return false;
    await sleep(Math.min(chunk, ms - (Date.now() - start)));
  }
  return !svpShouldStop();
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
  if (host.includes("cticket")) return "Ctiket";
  return null;
}

// ── Detect page type ──────────────────────────────────────────────────────────

function detectPageType() {
  const path = location.pathname;
  if (/\/booking\//.test(path)) return "booking_1zone";
  if (/\/events\/\d+\/bookings\/\d+\/select-ticket/.test(path)) return "select_ticket_tb";
  // Ticketbox prequeue: /waiting-room/{showingId}
  if (/\/waiting-room\/\d+/.test(path)) return "waiting_room_tb";
  // Ctiket: /buy/{eid}/queue (hàng chờ) vs /buy/{eid} (trang chọn vé)
  if (/\/buy\/[^/?#]+\/queue/.test(path)) return "queue_ctiket";
  if (/\/buy\/[^/?#]+/.test(path)) return "buy_ctiket";
  if (/\/events\//.test(path)) return "event";
  if (/\/checkout/.test(path) || /\/order\//.test(path) || /\/question-form/.test(path)) return "checkout";
  return "other";
}

// ── Simulate real mouse click (anti-detect — human-like variance) ────────────
// Random jitter ±2px + random delays + mousemove hover trước click.
// Pattern click hiện tại không còn predictable → khó fingerprint hơn.

function _randInt(min, max) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

async function realClick(x, y) {
  // Random jitter nhỏ (giữ trong target zone)
  const jx = x + (Math.random() - 0.5) * 4;  // ±2px
  const jy = y + (Math.random() - 0.5) * 4;

  const el = document.elementFromPoint(jx, jy);
  const evOpts = {
    bubbles: true, cancelable: true,
    clientX: jx, clientY: jy, screenX: jx, screenY: jy,
    view: window,
    button: 0, buttons: 1,
  };

  // Mô phỏng hover: 2-3 mousemove events trước click (human moves cursor)
  const hoverSteps = _randInt(2, 3);
  for (let i = 0; i < hoverSteps; i++) {
    const ix = jx + (Math.random() - 0.5) * 6;
    const iy = jy + (Math.random() - 0.5) * 6;
    document.dispatchEvent(new MouseEvent("mousemove", { ...evOpts, clientX: ix, clientY: iy }));
    if (el) el.dispatchEvent(new MouseEvent("mouseover", { ...evOpts, clientX: ix, clientY: iy }));
    await sleep(_randInt(10, 30));
  }

  // Mousedown → variable hold delay → mouseup → click
  if (el) {
    el.dispatchEvent(new MouseEvent("mouseenter", evOpts));
    el.dispatchEvent(new MouseEvent("mousedown", evOpts));
    await sleep(_randInt(40, 90));  // human click hold: 40-90ms (vs cũ cố định 30)
    el.dispatchEvent(new MouseEvent("mouseup", evOpts));
    el.dispatchEvent(new MouseEvent("click", evOpts));
  }

  // Random post-click delay
  await sleep(_randInt(60, 140));
}

// Shuffle array in place (Fisher-Yates) — dùng để random thứ tự click offsets
function shuffleArray(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
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