// src/content/seat_1zone_map.js
// 1Zone seat_map — port từ seat_selector_1zone.py
// Flow: GET /tickets API → parse ghế → Seats.io native API (window.seatsio.charts[0])
// KHÔNG POST add-to-cart trực tiếp — click button UI để frontend tự sinh token

const API_BASE_1Z = "https://prod.1zone.vn/ticketing/api";

// ── Tickets API ───────────────────────────────────────────────────────────────

async function get1ZoneTickets(eventId, calendarId) {
  const url = `${API_BASE_1Z}/v4/event/${eventId}/tickets?calendarId=${encodeURIComponent(calendarId)}`;
  const res = await fetch(url, {
    credentials: "include",
    headers: { "Accept": "application/json", "x-accept-language": "vi" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`tickets API ${res.status}`);
  return res.json();
}

// ── Parse tickets từ API response ────────────────────────────────────────────

function extractTickets(data) {
  let arr = [];
  if (Array.isArray(data)) arr = data;
  else if (data && typeof data === "object") {
    arr = data.data || data.result || data.tickets || [];
  }
  const tickets = [];
  for (const x of arr) {
    if (!x || typeof x !== "object") continue;
    const ticketId  = String(x._id || x.id || "").trim();
    const zoneId    = String(x.zoneId || "").trim();
    const zoneName  = String(x.zoneName || "").trim();
    const tcId      = String(x.ticketClassId || "").trim();
    const tcName    = String(x.ticketClassName || zoneName || "").trim();
    const row       = String(x.rowName || "").trim().toUpperCase();
    const code      = String(x.code || x.label || "").trim();
    if (!ticketId || !zoneId || !tcId || !row || !code) continue;
    const codeNum = parseInt(code.replace(/\D+/g, "")) || 0;
    tickets.push({
      _id: ticketId, zoneId, zoneName, ticketClassId: tcId, ticketClassName: tcName,
      rowName: row, code, codeNum,
      label: `${row}-${code}`,
      objectId: `${zoneName}-${row}-${code}`,
    });
  }
  return tickets;
}

// ── Priority parser ───────────────────────────────────────────────────────────

function normStr(s) {
  return String(s || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/\s+/g, " ").trim();
}

function parseRowRange(part) {
  part = String(part || "").trim().toUpperCase().replace(/\s/g, "");
  const rows = [];
  const add = r => { r = String(r).trim().toUpperCase(); if (r && !rows.includes(r)) rows.push(r); };
  for (const token of part.split(",")) {
    if (!token) continue;
    const pieces = token.split("-").filter(Boolean);
    if (pieces.length === 2 && /^[A-Z]$/.test(pieces[0]) && /^[A-Z]$/.test(pieces[1])) {
      const a = pieces[0].charCodeAt(0), b = pieces[1].charCodeAt(0);
      const step = a <= b ? 1 : -1;
      for (let i = a; step > 0 ? i <= b : i >= b; i += step) add(String.fromCharCode(i));
    } else {
      pieces.forEach(add);
    }
  }
  return rows;
}

function parseNumSpec(part) {
  part = String(part || "").replace(/\s/g, "");
  const ranges = [], values = new Set(), order = [];
  const add = n => { values.add(n); if (!order.includes(n)) order.push(n); };
  for (const token of part.split(",")) {
    const m = token.match(/^(\d+)-(\d+)$/);
    if (m) {
      const a = parseInt(m[1]), b = parseInt(m[2]);
      ranges.push([Math.min(a,b), Math.max(a,b)]);
      const step = a <= b ? 1 : -1;
      for (let n = a; step > 0 ? n <= b : n >= b; n += step) add(n);
    } else if (/^\d+$/.test(token)) add(parseInt(token));
  }
  return { ranges, values, order };
}

function numAllowed(num, spec) {
  if (!spec) return true;
  const { ranges, values } = spec;
  if (!ranges.length && !values.size) return true;
  if (values.has(num)) return true;
  return ranges.some(([lo,hi]) => num >= lo && num <= hi);
}

function parsePriority1Zone(raw) {
  raw = String(raw || "").trim();
  if (!raw) return { type: "empty", raw };

  // Tách zone prefix "Zone X|rest" → zoneFilter = "Zone X", rest = "rest"
  // Desktop UI build format:
  //   "Zone 2"                  → zone only
  //   "M:8-18"                  → row + seat range (no zone)
  //   "Zone 2|M:8-18"           → all three
  //   "Zone 2|M"                → zone + row (no seat range)
  //   "M"                       → row only
  //   "M:8-18:odd"              → + parity filter (lẻ)
  //   "Zone 2|M:1-9:even"       → zone + row + seat + parity (chẵn)
  //   "Zone 2|K:*:odd"          → zone + row + parity (bất kỳ ghế trong row, chỉ lẻ)
  let zoneFilter = null;
  let rest = raw;
  if (raw.includes("|")) {
    const idx = raw.indexOf("|");
    zoneFilter = raw.slice(0, idx).trim();
    rest = raw.slice(idx + 1).trim();
  }

  // Tách parity suffix (:odd / :even cuối)
  let parity = null;  // null | "odd" | "even"
  const lowerRest = rest.toLowerCase();
  if (lowerRest.endsWith(":odd")) {
    parity = "odd";
    rest = rest.slice(0, -4);
  } else if (lowerRest.endsWith(":even")) {
    parity = "even";
    rest = rest.slice(0, -5);
  }

  const compact = rest.toUpperCase().replace(/\s/g, "");

  // Type "range" — có ":" hoặc có cả row + seat spec
  if (compact.includes(":")) {
    const [left, right] = compact.split(":", 2);
    const rows = parseRowRange(left);
    // Hỗ trợ wildcard "*" cho seat range — chỉ row + parity
    let numSpec;
    if (right === "*" || right === "") {
      numSpec = null;  // không filter seat number, chỉ filter row + parity
    } else {
      numSpec = parseNumSpec(right);
      if (!numSpec.ranges.length && !numSpec.values.size) numSpec = null;
    }
    if (rows.length) {
      return { type: "range", raw, rows, numSpec, zoneFilter, parity };
    }
  }

  // Type "exact" — seat label như "M-19", "M19", "AA12"
  // Giới hạn row 1-2 chars để KHÔNG match zone name dài ("ZONE2", "VIP1"...)
  // Chỉ thử exact nếu KHÔNG có zoneFilter (zone-only case fall through sang text/range)
  if (!zoneFilter) {
    const exact = [];
    let okExact = true;
    for (const token of compact.split(",")) {
      if (!token) continue;
      const m = token.match(/^([A-Z]{1,2})-?(\d+)$/);
      if (!m) { okExact = false; break; }
      exact.push({ row: m[1], num: parseInt(m[2]), label: `${m[1]}-${parseInt(m[2])}` });
    }
    if (exact.length && okExact) return { type: "exact", raw, seats: exact };
  }

  // Type "range" — nếu rest chỉ là row name "M" (không ":") + zoneFilter có
  // → coi như "any seat in row M of zone X"
  if (zoneFilter && rest) {
    const rows = parseRowRange(compact);
    if (rows.length) {
      return { type: "range", raw, rows, numSpec: null, zoneFilter, parity };
    }
  }
  // Type "range" — rest chỉ là row name (không zone, không seat) như "M"
  if (!zoneFilter && rest && /^[A-Z]{1,2}$/.test(compact)) {
    return { type: "range", raw, rows: [compact], numSpec: null, zoneFilter: null, parity };
  }

  // Type "text" — fallback. norm dùng zoneFilter nếu có (zone-only case)
  // hoặc rest (text describe zone/ghế tự do)
  return { type: "text", raw, norm: normStr(zoneFilter || rest), zoneFilter, parity };
}

// Helper: filter seatNum theo parity (odd/even/null)
function _matchParity(seatNum, parity) {
  if (!parity) return true;
  if (parity === "odd")  return seatNum % 2 === 1;
  if (parity === "even") return seatNum % 2 === 0;
  return true;
}

// Helper: filter tickets theo zone name fuzzy
function _filterByZone(tickets, zoneFilter) {
  if (!zoneFilter) return tickets;
  const zNorm = normStr(zoneFilter);
  if (!zNorm) return tickets;
  return tickets.filter(t => {
    const tZone = normStr(t.zoneName || "");
    const tClass = normStr(t.ticketClassName || "");
    return tZone === zNorm || tZone.includes(zNorm) || zNorm.includes(tZone) ||
           tClass === zNorm || tClass.includes(zNorm);
  });
}

// ── Adjacent picker ───────────────────────────────────────────────────────────

function pickAdjacent(tickets, quantity, numOrder) {
  const grouped = {};
  for (const t of tickets) {
    const key = `${t.zoneId}|${t.ticketClassId}|${t.rowName}`;
    (grouped[key] = grouped[key] || []).push(t);
  }

  for (const group of Object.values(grouped)) {
    if (group.length < quantity) continue;
    const byNum = {};
    for (const t of group) byNum[t.codeNum] = t;
    const nums = Object.keys(byNum).map(Number).sort((a, b) => a - b);

    // Bước 1: Sequential (liền kề thật sự: 1,2,3 hoặc 2,3,4...)
    // Ưu tiên này vì rạp đánh số liên tục (hàng D: 1,2,3,4,5...)
    for (const start of nums) {
      const seq = Array.from({ length: quantity }, (_, i) => start + i);
      if (seq.every(n => byNum[n])) return seq.map(n => byNum[n]);
    }

    // Bước 2: Parity fallback (cùng lẻ hoặc cùng chẵn kề nhau: 1,3,5 hoặc 2,4,6...)
    // Dùng khi rạp chia lẻ/chẵn theo 2 phía (hàng A: 2,4,6,8... / hàng C: 1,3,5,7...)
    for (const start of nums) {
      const up = Array.from({ length: quantity }, (_, i) => start + 2 * i);
      if (up.every(n => byNum[n])) return up.map(n => byNum[n]);
      const down = Array.from({ length: quantity }, (_, i) => start - 2 * i);
      if (down.every(n => byNum[n])) return down.map(n => byNum[n]);
    }
  }
  return [];
}

// ── Select tickets theo priority ──────────────────────────────────────────────

function selectTickets(tickets, priorityItems, requireAdjacent = true, allowSplit = false, allowPartial = false) {
  // FIX: bỏ yêu cầu "liền kề" (pickAdjacent) — giờ dùng quét tuần tự từng ghế
  // (xem vòng scan trong run1ZoneSeatMap), nên hàm này chỉ còn nhiệm vụ lọc +
  // sort ra TOÀN BỘ candidate pool khớp priority, không pre-chọn N ghế nữa.
  // requireAdjacent/allowSplit không còn dùng ở đây — giữ tham số để tương
  // thích signature với chỗ gọi.
  for (const item of priorityItems) {
    const raw = item.raw;
    const quantity = Math.max(1, parseInt(item.quantity) || 1);

    const parsed = parsePriority1Zone(raw);
    if (parsed.type === "empty") continue;

    // Pre-filter theo zone nếu có zoneFilter (áp dụng cho mọi type)
    const zoneScoped = _filterByZone(tickets, parsed.zoneFilter);
    if (parsed.zoneFilter && !zoneScoped.length) continue;

    if (parsed.type === "exact") {
      const candidates = [];
      for (const want of parsed.seats) {
        const found = zoneScoped.find(t => t.rowName === want.row && t.codeNum === want.num);
        if (found) candidates.push(found);
      }
      if (!candidates.length) continue;
      return { candidates, reason: `exact:${raw}`, quantity };
    }

    if (parsed.type === "range") {
      const allowedRows = new Set(parsed.rows);
      const candidates = zoneScoped.filter(t =>
        allowedRows.has(t.rowName) &&
        (parsed.numSpec ? numAllowed(t.codeNum, parsed.numSpec) : true) &&
        _matchParity(t.codeNum, parsed.parity)
      ).sort((a,b) => a.rowName.localeCompare(b.rowName) || a.codeNum - b.codeNum);
      if (!candidates.length) continue;
      return { candidates, reason: `range:${raw}`, quantity };
    }

    // Text match — dùng zoneScoped (đã filter) hoặc filter thêm theo norm
    const norm = parsed.norm;
    let candidates;
    if (parsed.zoneFilter) {
      // Zone-only case: lấy bất kỳ ghế nào trong zone — dò hàng A trước, hết
      // mới sang hàng B, C... (localeCompare) thay vì trộn theo số ghế toàn cục.
      candidates = [...zoneScoped].sort((a,b) =>
        a.rowName.localeCompare(b.rowName) || a.codeNum - b.codeNum
      );
    } else {
      // Text describe tự do: match trong toàn bộ tickets
      const normTokens = norm.split(/\s+/).filter(Boolean);
      candidates = tickets.filter(t => {
        const hay = [t.zoneName, t.ticketClassName, t.label, t.objectId]
          .map(normStr).join(" ");
        if (hay.includes(norm)) return true;
        if (!normTokens.length) return false;
        return normTokens.every(tok => {
          const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(`\\b${escaped}\\b`).test(hay);
        });
      }).sort((a,b) => a.rowName.localeCompare(b.rowName) || a.codeNum - b.codeNum);
    }

    if (parsed.parity) {
      candidates = candidates.filter(t => _matchParity(t.codeNum, parsed.parity));
    }

    if (!candidates.length) continue;
    return { candidates, reason: `text:${raw}`, quantity };
  }
  return { candidates: [], reason: "no match", quantity: 0 };
}

// ── Label variants (như Python _label_variants_1zone) ─────────────────────────

function labelVariants(seat) {
  const row = String(seat.rowName || "").toUpperCase().trim();
  const code = String(seat.code || seat.codeNum || "").trim();
  const zone = String(seat.zoneName || "").trim();
  const tc   = String(seat.ticketClassName || "").trim();
  const label = row && code ? `${row}-${code}` : String(seat.label || "").trim();
  const compact = row && code ? `${row}${code}` : "";
  const objectId = String(seat.objectId || "").trim();

  const variants = [];
  for (const x of [objectId, zone && label ? `${zone}-${label}` : "", tc && label ? `${tc}-${label}` : "", label, compact]) {
    const s = String(x || "").trim();
    if (s && !variants.includes(s)) variants.push(s);
  }
  return variants;
}

// ── Seats.io select qua runInPage ─────────────────────────────────────────────

async function seatsioSelectGroup(labelGroups, allowPartial = false, clear = true) {
  return runInPage(function(args) {
    const { labelGroups, allowPartial, clear } = args;

    async function mp(v) { return v && typeof v.then === "function" ? await v : v; }
    function simpleErr(e) { try { return String(e?.message || e).slice(0,200); } catch(_) { return "err"; } }

    return (async () => {
      const logs = [];
      const chart = window.seatsio?.charts?.[0];
      if (!chart) return { ok: false, error: "no seatsio chart", logs, selectedCount: 0 };

      logs.push(`chart found | trySelectObjects=${typeof chart.trySelectObjects} | allowPartial=${allowPartial} | clear=${clear}`);

      // clear=false dùng khi bù thêm ghế còn thiếu — GIỮ NGUYÊN ghế đã chọn
      // trước đó trên chart, chỉ thêm ghế mới vào thay vì xoá sạch làm lại.
      if (clear) {
        try { await mp(chart.clearSelection()); logs.push("clearSelection OK"); } catch(e) { logs.push("clearSelection err: " + simpleErr(e)); }
      } else {
        logs.push("clearSelection SKIPPED (top-up mode)");
      }

      async function getSelected() {
        try {
          const sel = await mp(chart.listSelectedObjects()) || [];
          return sel.length;
        } catch { return 0; }
      }

      const picked = [];
      const failedIdx = [];
      for (let i = 0; i < labelGroups.length; i++) {
        const variants = labelGroups[i];
        let ok = false;
        logs.push(`seat ${i+1} variants: ${variants.join(" | ")}`);
        for (const label of variants) {
          if (ok) break;
          for (const method of ["trySelectObjects", "selectObjects"]) {
            if (ok || typeof chart[method] !== "function") continue;
            try {
              await mp(chart[method]([label]));
              logs.push(`${method} OK: ${label}`);
              picked.push(label);
              ok = true;
            } catch(e) { logs.push(`${method} fail ${label}: ${simpleErr(e)}`); }
          }
        }
        if (!ok) {
          failedIdx.push(i);
          if (allowPartial) {
            // Partial mode: tiếp tục thử các ghế còn lại thay vì abort
            logs.push(`seat ${i+1} failed — allowPartial=true, tiếp tục thử ghế kế tiếp`);
            continue;
          }
          const cnt = await getSelected();
          return { ok: false, error: `seat ${i+1} failed`, logs, selectedCount: cnt, pickedLabels: picked };
        }
      }

      const cnt = await getSelected();
      // Non-partial: cần đủ tất cả ghế. Partial: cần ≥1 ghế.
      const minRequired = allowPartial ? 1 : labelGroups.length;
      const success = cnt >= minRequired;
      if (allowPartial && failedIdx.length) {
        logs.push(`partial result: ${cnt}/${labelGroups.length} ghế OK, ${failedIdx.length} fail (idx=${failedIdx.join(",")})`);
      }
      return { ok: success, logs, selectedCount: cnt, pickedLabels: picked, failedIdx };
    })();
  }, { labelGroups, allowPartial, clear });
}

// ── Click nút thanh toán sau khi chọn ghế ────────────────────────────────────

async function click1ZonePaymentBtn() {
  const btns = Array.from(document.querySelectorAll("button, a[role='button'], [role='button']"));
  const payBtn = btns.find(b => {
    if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
    const txt = (b.innerText || "").toLowerCase();
    return /thanh toán|tiếp tục|đặt vé|mua vé|checkout|continue/.test(txt);
  });
  if (!payBtn) return false;
  payBtn.click();
  return true;
}

// ── Detect dialog lỗi "Không còn đủ vé" (race condition — ghế bị giành mất) ──
// 2 variant:
//  - variant "held": có nút "Đóng" → click thẳng được, an toàn.
//  - variant "sold_out": có nút "Thoát mua vé" → TUYỆT ĐỐI KHÔNG click nút này
//    (sẽ văng về trang chủ). Phải tìm nút "x" đóng modal thay thế.

function detectSeatErrorDialog1Z() {
  const target = normText("Không còn đủ vé");
  const headings = Array.from(document.querySelectorAll("p, div, h1, h2, h3"));
  const heading = headings.find(el =>
    el.children.length === 0 && normText(el.innerText || el.textContent || "") === target
  );
  if (!heading) return null;

  // Leo lên tìm card chứa cả nội dung lẫn nút bấm
  let card = heading;
  for (let i = 0; i < 6 && card; i++) {
    if (card.querySelector && card.querySelector("button")) break;
    card = card.parentElement;
  }
  if (!card) return null;

  const btns = Array.from(card.querySelectorAll("button"));
  const closeBtn = btns.find(b => normText(b.innerText || b.textContent || "") === normText("Đóng"));
  const exitBtn = btns.find(b => normText(b.innerText || b.textContent || "") === normText("Thoát mua vé"));

  if (closeBtn) {
    let seatLabel = "";
    try {
      const b = card.querySelector("b");
      if (b) seatLabel = String(b.innerText || b.textContent || "").trim();
    } catch {}
    return { variant: "held", card, closeBtn, seatLabel };
  }
  if (exitBtn) {
    return { variant: "sold_out", card, exitBtn };
  }
  return null;
}

// Tìm nút "x" đóng modal cho variant sold_out (KHÔNG dùng exitBtn).
// ⚠️ Heuristic — chưa có markup wrapper modal thật, cần test trên trang thật
// để chỉnh lại selector nếu bấm sai nút.
function findModalCloseX1Z(card) {
  let root = card;
  for (let i = 0; i < 8 && root && root !== document.body; i++) {
    const role = root.getAttribute?.("role");
    let pos = "";
    try { pos = window.getComputedStyle(root).position; } catch {}
    if (role === "dialog" || root.getAttribute?.("aria-modal") === "true" || pos === "fixed") break;
    root = root.parentElement;
  }
  root = root || document.body;

  const byAria = Array.from(root.querySelectorAll("button[aria-label]")).find(b => {
    const al = (b.getAttribute("aria-label") || "").toLowerCase();
    return al.includes("close") || al.includes("đóng") || al === "x";
  });
  if (byAria) return byAria;

  // Ưu tiên: button chứa svg icon "lucide-x" (icon X chuẩn của lucide-react)
  // Tìm trong root trước, nếu không thấy thì mở rộng toàn document
  // (phòng trường hợp climb-up xác định sai root, ví dụ dialog render qua portal).
  const findLucideX = (scope) => Array.from(scope.querySelectorAll("button")).find(b => {
    const svg = b.querySelector("svg");
    return !!svg && Array.from(svg.classList || []).some(c => c.toLowerCase().includes("lucide-x"));
  });
  const byLucideX = findLucideX(root) || findLucideX(document);
  if (byLucideX) return byLucideX;

  // Fallback: button không có text, chỉ chứa svg — ưu tiên gần góc trên-phải root
  const svgOnly = Array.from(root.querySelectorAll("button")).filter(b => {
    const txt = (b.innerText || b.textContent || "").trim();
    return !txt && b.querySelector("svg");
  });
  if (!svgOnly.length) return null;

  const rootRect = root.getBoundingClientRect();
  svgOnly.sort((a, b) => {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect();
    const da = Math.hypot(ra.left - rootRect.right, ra.top - rootRect.top);
    const db = Math.hypot(rb.left - rootRect.right, rb.top - rootRect.top);
    return da - db;
  });
  return svgOnly[0];
}

// Click "nhanh" không mô phỏng người thật — CHỈ dùng để đóng dialog lỗi (không
// có rủi ro anti-bot ở bước này, và cần đóng nhanh để kịp quay lại giành ghế khác).
// Khác với realClick() (dùng cho chọn ghế thật — cố tình chậm/giả lập để né detect).
function fastClick(x, y) {
  const el = document.elementFromPoint(x, y);
  if (!el) return null;
  const evOpts = {
    bubbles: true, cancelable: true,
    clientX: x, clientY: y, screenX: x, screenY: y,
    view: window, button: 0, buttons: 1,
  };
  el.dispatchEvent(new MouseEvent("mousedown", evOpts));
  el.dispatchEvent(new MouseEvent("mouseup", evOpts));
  el.dispatchEvent(new MouseEvent("click", evOpts));
  return el;
}

// Ưu tiên 1: click ra ngoài card (vào lớp nền mờ phía sau dialog).
// Test thực tế xác nhận cách này đóng được CẢ 2 variant, không phụ thuộc
// text/class của nút bấm nào cả — bền hơn nhiều nếu web đổi markup/wording.
async function clickBackdropOutside1Z(card) {
  try {
    const rect = card.getBoundingClientRect();
    const candidates = [
      { x: 8, y: 8 },
      { x: window.innerWidth - 8, y: 8 },
      { x: 8, y: window.innerHeight - 8 },
      { x: window.innerWidth - 8, y: window.innerHeight - 8 },
    ];
    for (const { x, y } of candidates) {
      // bỏ qua điểm lỡ rơi vào trong card
      if (x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom) continue;
      fastClick(x, y);
      await sleep(120);
      if (!detectSeatErrorDialog1Z()) return true; // xác nhận đóng thật, không đoán mò
    }
  } catch {}
  return false;
}

// Đóng dialog lỗi theo đúng variant. Trả về true nếu đã đóng được (nên retry),
// false nếu phát hiện dialog nhưng không đóng được (cần dừng, tránh bấm bừa).
async function closeSeatErrorDialog1Z(info) {
  if (!info) return false;

  svpLog(`⚠️ Dialog "Không còn đủ vé" (variant=${info.variant}${info.seatLabel ? `, ghế=${info.seatLabel}` : ""}) — thử đóng bằng click backdrop`, "yellow");
  if (await clickBackdropOutside1Z(info.card)) {
    svpLog(`✅ Đóng dialog bằng click backdrop — retry lại từ đầu`, "green");
    return true;
  }

  // Fallback: bấm đúng nút theo variant (backdrop không ăn — có thể do overlay không bắt click ngoài)
  svpLog("⚠️ Click backdrop không đóng được — fallback bấm nút theo variant", "yellow");
  if (info.variant === "held") {
    info.closeBtn.click();
    return true;
  }

  // variant "sold_out": KHÔNG click "Thoát mua vé"
  const xBtn = findModalCloseX1Z(info.card);
  if (xBtn) {
    xBtn.click();
    return true;
  }
  svpLog(`❌ Dialog "Không còn đủ vé" hiện nhưng KHÔNG đóng được bằng cách nào (tránh bấm "Thoát mua vé"). Cần kiểm tra selector thực tế.`, "red");
  return false;
}

// Đóng HẾT các dialog lỗi đang chồng lên nhau (nếu có), re-query DOM mỗi vòng
// (không cache element cũ vì React có thể unmount/re-render sau mỗi lần đóng).
// Trả về: "clean" (không còn dialog nào / đã dọn sạch), "blocked" (có dialog
// nhưng không đóng được — cần dừng), hoặc "stuck" (vượt quá số lần cho phép,
// nghi có dialog lạ chưa nhận diện được — cũng cần dừng, tránh loop vô hạn).
async function dismissAllSeatErrorDialogs1Z(maxRounds = 5) {
  for (let round = 1; round <= maxRounds; round++) {
    const info = detectSeatErrorDialog1Z(); // re-query mới, không dùng lại info cũ
    if (!info) return "clean";

    const closed = await closeSeatErrorDialog1Z(info);
    if (!closed) return "blocked";

    await sleep(150); // chờ DOM cập nhật (đóng dialog / dialog kế tiếp kịp render) — đã dùng fastClick nên giữ ngắn
  }
  // Hết maxRounds mà vẫn còn dialog — có thể có dialog thứ 3 lạ đứng yên
  if (detectSeatErrorDialog1Z()) {
    svpLog(`❌ Vẫn còn dialog lỗi sau ${maxRounds} lần đóng — dừng lại, tránh loop vô hạn.`, "red");
    return "stuck";
  }
  return "clean";
}

// ── Main flow: 1Zone seat_map ─────────────────────────────────────────────────

async function run1ZoneSeatMap(cfg) {
  const aseat = cfg.auto_seat?.["1zone"] || cfg.auto_seat || {};

  // Đọc seat_map_priorities mới [{raw, quantity}] — mỗi dòng ưu tiên có SL riêng.
  // Fallback config cũ: zone_priority (list string) + 1 quantity chung cho tất cả.
  let priorityItems = [];
  const rawPriorities = aseat.seat_map_priorities || aseat.zone_priority || aseat.priority_targets || [];
  const qtyOld = Math.max(1, parseInt(aseat.quantity) || 1);
  priorityItems = rawPriorities
    .map(p => (p && typeof p === "object")
      ? { raw: String(p.raw || ""), quantity: Math.max(1, parseInt(p.quantity) || qtyOld) }
      : { raw: String(p || ""), quantity: qtyOld })
    .filter(p => p.raw);

  const requireAdjacent = aseat.require_adjacent !== false;
  const allowSplit = !!aseat.allow_split_seats;
  const allowPartial = !!aseat.allow_partial;

  svpLog(`🗺️ 1Zone seat_map | priority=${JSON.stringify(priorityItems)}${allowPartial ? " (cho phép mua thiếu)" : ""}`, "blue");

  if (!priorityItems.length) {
    svpLog("❌ Chưa nhập ưu tiên ghế/vé cho 1Zone seat_map", "red");
    return false;
  }

  const info = extract1ZoneInfo();
  if (!info.eventId || !info.calendarId) {
    svpLog("❌ Không lấy được eventId/calendarId", "red");
    return false;
  }

  // Race condition: ghế bị người khác giành mất → dialog "Không còn đủ vé" hiện lên.
  // Xử lý: đóng dialog đúng cách rồi restart TOÀN BỘ flow từ đầu (fetch tickets mới),
  // KHÔNG loại bỏ ghế nào khỏi candidate list.
  const maxRestarts = Math.max(1, parseInt(aseat.max_conflict_restarts) || 8);

  restart: for (let restartAttempt = 1; restartAttempt <= maxRestarts; restartAttempt++) {
  if (svpShouldStop()) { svpLog("🛑 Stop signal — abort seat_map", "yellow"); return false; }

  // Dọn sạch dialog lỗi còn sót (từ vòng trước, hoặc bật ra ngoài cửa sổ chờ orderId)
  const dismissState = await dismissAllSeatErrorDialogs1Z();
  if (dismissState !== "clean") return false;

  // GET tickets API
  svpLog(restartAttempt === 1 ? "📡 GET tickets API..." : `📡 GET tickets API (restart lần ${restartAttempt})...`, "blue");
  let tickets = [];
  try {
    const data = await get1ZoneTickets(info.eventId, info.calendarId);
    tickets = extractTickets(data);
    svpLog(`📋 Tickets available: ${tickets.length}`, "blue");
  } catch(e) {
    svpLog(`❌ Tickets API lỗi: ${e.message}`, "red");
    return false;
  }

  if (!tickets.length) {
    svpLog("❌ Không có ghế nào available", "red");
    return false;
  }

  // Log tóm tắt theo zone
  const zoneSummary = {};
  for (const t of tickets) {
    zoneSummary[t.zoneName] = (zoneSummary[t.zoneName] || 0) + 1;
  }
  svpLog(`📋 Zones: ${Object.entries(zoneSummary).map(([k,v]) => `${k}(${v})`).join(", ")}`, "blue");

  // API chỉ dùng để shortlist nhanh. Seats.io mới là bước chọn thật.
  // Nếu API báo còn nhưng Seats.io không chọn được (Ignoring/hết),
  // bỏ ghế đó và thử candidate tiếp theo — giống Python _run_seatmap_api

  let remaining = [...tickets];
  const maxAttempts = Math.min(30, Math.max(1, tickets.length));
  const maxRounds = 5;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (svpShouldStop()) { svpLog("🛑 Stop signal — abort seat selection loop", "yellow"); return false; }
    const { candidates, reason, quantity } = selectTickets(remaining, priorityItems, requireAdjacent, allowSplit, allowPartial);

    if (!candidates.length) {
      svpLog("❌ Không tìm được ghế nào khớp ưu tiên. Không chọn bừa ngoài danh sách.", "red");
      return false;
    }

    svpLog(`🔎 Quét ${candidates.length} ghế ứng viên (${reason}), cần ${quantity} ghế (dò từng ghế, không yêu cầu liền kề)...`, "blue");

    // Quét tuần tự: đi qua từng ghế theo thứ tự hàng A→B→C..., ghế nào Seats.io
    // xác nhận trống là chọn ngay, dừng khi đủ quantity. KHÔNG yêu cầu liền kề.
    // Lặp lại tối đa maxRounds vòng nếu 1 vòng chưa đủ (phòng dò sót do timing/
    // race — ghế vừa "Ignoring" có thể được nhả ra ở vòng sau).
    const picked = [];
    const pickedIds = new Set();
    let round = 1;

    for (round = 1; round <= maxRounds; round++) {
      if (svpShouldStop()) { svpLog("🛑 Stop signal — abort scan", "yellow"); return false; }
      let addedThisRound = 0;

      for (const t of candidates) {
        if (picked.length >= quantity) break;
        if (pickedIds.has(t._id)) continue; // đã chọn được ở vòng trước rồi
        if (svpShouldStop()) { svpLog("🛑 Stop signal — abort scan", "yellow"); return false; }

        let res;
        try {
          // clear=true CHỈ ở lần chọn đầu tiên (chưa có ghế nào trên chart),
          // các lần sau clear=false để cộng dồn, không mất ghế đã chọn.
          res = await seatsioSelectGroup([labelVariants(t)], true, picked.length === 0);
        } catch(e) {
          continue;
        }
        const ok = (res?.pickedLabels || []).length > 0;
        if (ok) {
          picked.push(t);
          pickedIds.add(t._id);
          addedThisRound++;
          svpLog(`✅ [vòng ${round}] Chọn được ${t.zoneName} ${t.label} (${picked.length}/${quantity})`, "green");
        }
      }

      if (picked.length >= quantity) break; // đủ rồi
      if (round === 1 && picked.length === 0) {
        // Vòng đầu 0 ghế nào cả trong toàn bộ candidate — không có gì để "dò
        // lại" (không phải do race, mà zone/priority này thực sự hết/bị chặn).
        // Thoát sớm, xử lý như case "không có ghế nào" bên dưới.
        svpLog(`🔁 Vòng 1: không chọn được ghế nào trong ${candidates.length} ứng viên.`, "yellow");
        break;
      }
      if (round < maxRounds) {
        svpLog(`🔁 Hết vòng ${round}: ${picked.length}/${quantity} ghế — thử lại vòng ${round + 1}/${maxRounds}...`, "yellow");
      }
    }

    if (picked.length === 0) {
      // Không ghế nào cả cho priority này — loại toàn bộ candidate đã thử
      // khỏi remaining, thử lại từ đầu (attempt tiếp theo, như logic cũ:
      // hiện thông báo góc màn hình qua showIndicator ở nơi gọi + retry).
      const triedIds = new Set(candidates.map(t => t._id));
      remaining = remaining.filter(t => !triedIds.has(t._id));
      svpLog(`❌ Không có ghế nào khả dụng cho ưu tiên này (attempt ${attempt}/${maxAttempts}). Thử lại...`, "red");
      continue;
    }

    if (picked.length < quantity) {
      if (!allowPartial) {
        // Không đủ và KHÔNG cho phép thiếu → nhả hết ghế đã chọn, dò lại từ
        // đầu (attempt tiếp theo). KHÔNG loại candidate khỏi remaining —
        // giữ nguyên để lần sau có thể thử lại đúng những ghế này (phòng
        // ghế được nhả ra sau đó).
        svpLog(`↩️ Chỉ được ${picked.length}/${quantity} sau ${Math.min(round, maxRounds)} vòng — allow_partial=false, nhả ghế và dò lại từ đầu (attempt ${attempt}/${maxAttempts}).`, "yellow");
        try {
          await runInPage(function() {
            const chart = window.seatsio?.charts?.[0];
            return chart ? chart.clearSelection() : null;
          });
        } catch(e) {}
        continue;
      }
      svpLog(`✅ Chấp nhận mua thiếu: ${picked.length}/${quantity} ghế sau ${Math.min(round, maxRounds)} vòng quét (allow_partial=true).`, "yellow");
    } else {
      svpLog(`✅ Đã chọn đủ ${picked.length}/${quantity} ghế.`, "green");
    }

    // ─── Đủ ghế (hoặc partial được chấp nhận) → tiến hành Thanh toán ───
    await sleep(800);

    // Stage 3: setup hook capture orderId TRƯỚC khi click Thanh toán
    const capture = window.__SVP_1Z_CAPTURE__;
    let orderIdResult = null;
    if (capture) {
      capture.clearReserveCache();
      capture.waitForOrderId(12000).then(r => { orderIdResult = r; });
    } else {
      svpLog("⚠️ __SVP_1Z_CAPTURE__ chưa load — fallback chỉ click + wait", "yellow");
    }

    // Click Thanh toán
    svpLog("🖱️ Click Thanh toán", "blue");
    const clicked = await click1ZonePaymentBtn();
    if (!clicked) {
      svpLog("⚠️ Không tìm thấy nút Thanh toán", "yellow");
      return true;
    }

    // Chờ hook orderId hoặc URL navigate
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline) {
      if (svpShouldStop()) { svpLog("🛑 Stop signal — abort wait orderId", "yellow"); return false; }
      await sleep(150);

      // Race condition: ghế bị người khác giành mất trong lúc chờ →
      // dialog "Không còn đủ vé" hiện lên (có thể 2 cái chồng nhau). Dọn sạch rồi restart từ đầu.
      if (detectSeatErrorDialog1Z()) {
        const dismissState = await dismissAllSeatErrorDialogs1Z();
        if (dismissState !== "clean") return false; // không đóng được / còn dialog lạ — dừng, tránh bấm bừa
        continue restart;
      }

      // Priority 1: hook capture
      if (orderIdResult) {
        if (orderIdResult.success && orderIdResult.orderId) {
          svpLog(`✅ Reserve OK — orderId=${orderIdResult.orderId}`, "green");
          // Đợi nav xảy ra
          const navDeadline = Date.now() + 5000;
          while (Date.now() < navDeadline) {
            const u = location.href;
            if (u.includes("/checkout") || u.includes("/order/")) {
              svpLog(`✅ Navigate checkout xong`, "green");
              return true;
            }
            await sleep(200);
          }
          svpLog(`✅ Có orderId nhưng URL chưa navigate — coi như success`, "green");
          return true;
        } else if (orderIdResult.error) {
          const ec = orderIdResult.error.errorCode;
          const msg = orderIdResult.error.message || "";
          svpLog(`❌ Reserve FAIL — errorCode=${ec} msg=${msg}`, "red");
          return false;
        }
      }

      // Priority 2: URL change fallback
      const u = location.href;
      if (u.includes("/checkout") || u.includes("/order/")) {
        if (orderIdResult?.orderId) {
          svpLog(`✅ Navigate checkout (orderId=${orderIdResult.orderId})`, "green");
        } else {
          svpLog(`✅ Navigate checkout (URL detect, hook chưa thấy orderId)`, "yellow");
        }
        return true;
      }
    }

    if (orderIdResult?.success) {
      svpLog(`⏰ Timeout chờ navigate nhưng có orderId=${orderIdResult.orderId} — success`, "yellow");
      return true;
    }
    svpLog("⚠️ Timeout — không capture được orderId, không navigate.", "yellow");
    return false;
  }

  svpLog("❌ Thử nhiều candidate nhưng chưa chọn được ghế trên Seats.io.", "red");
  return false;

  } // end restart loop

  svpLog("❌ Vượt quá số lần retry do xung đột ghế (race condition) mà vẫn không thành công.", "red");
  return false;
}