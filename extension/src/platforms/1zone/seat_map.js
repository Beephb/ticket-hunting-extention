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

function selectTickets(tickets, priorities, quantity, requireAdjacent = true, allowSplit = false, allowPartial = false) {
  // Nếu allowPartial = true, chấp nhận pick ≥ 1 ghế (thay vì cần đủ quantity)
  const minRequired = allowPartial ? 1 : quantity;

  for (const raw of priorities) {
    const parsed = parsePriority1Zone(raw);
    if (parsed.type === "empty") continue;

    // Pre-filter theo zone nếu có zoneFilter (áp dụng cho mọi type)
    const zoneScoped = _filterByZone(tickets, parsed.zoneFilter);
    if (parsed.zoneFilter && !zoneScoped.length) continue;

    if (parsed.type === "exact") {
      const selected = [];
      for (const want of parsed.seats) {
        const found = zoneScoped.find(t => t.rowName === want.row && t.codeNum === want.num);
        if (!found) break;
        selected.push(found);
      }
      if (selected.length >= minRequired) return { selected: selected.slice(0, quantity), reason: `exact:${raw}` };
      continue;
    }

    if (parsed.type === "range") {
      const allowedRows = new Set(parsed.rows);
      const candidates = zoneScoped.filter(t =>
        allowedRows.has(t.rowName) &&
        (parsed.numSpec ? numAllowed(t.codeNum, parsed.numSpec) : true) &&
        _matchParity(t.codeNum, parsed.parity)  // NEW: lọc theo lẻ/chẵn nếu có
      );
      if (candidates.length < minRequired) continue;

      for (const row of parsed.rows) {
        const rowTickets = candidates.filter(t => t.rowName === row)
          .sort((a,b) => a.codeNum - b.codeNum);
        if (rowTickets.length < minRequired) continue;
        if (requireAdjacent && rowTickets.length >= quantity) {
          const adj = pickAdjacent(rowTickets, quantity, parsed.numSpec?.order);
          if (adj.length >= quantity) return { selected: adj.slice(0,quantity), reason: `adj-range:${raw}` };
          if (!allowSplit && !allowPartial) continue;
        }
        // Partial: lấy bao nhiêu có
        const take = Math.min(rowTickets.length, quantity);
        return { selected: rowTickets.slice(0,take), reason: `range:${raw}${take < quantity ? `(partial ${take}/${quantity})` : ""}` };
      }
      continue;
    }

    // Text match — dùng zoneScoped (đã filter) hoặc filter thêm theo norm
    const norm = parsed.norm;
    let candidates;
    if (parsed.zoneFilter) {
      // Zone-only case: lấy bất kỳ ghế nào trong zone, ưu tiên codeNum nhỏ
      candidates = [...zoneScoped].sort((a,b) =>
        a.rowName.localeCompare(b.rowName) || a.codeNum - b.codeNum
      );
    } else {
      // Text describe tự do: match trong toàn bộ tickets
      // FIX Bug B: dùng strict + token-all-must-match với word boundary
      // → "ZONE 2" KHÔNG match nhầm "ZONE 1" (trước đây norm.includes(hay.split(" ")[0])
      //   = "zone 2".includes("zone") = true → false positive)
      const normTokens = norm.split(/\s+/).filter(Boolean);
      candidates = tickets.filter(t => {
        const hay = [t.zoneName, t.ticketClassName, t.label, t.objectId]
          .map(normStr).join(" ");
        // 1) Strict substring (giữ behavior cũ cho case ticket name dài hơn input)
        if (hay.includes(norm)) return true;
        // 2) Tất cả token của norm phải xuất hiện trong hay (word boundary)
        if (!normTokens.length) return false;
        return normTokens.every(tok => {
          const escaped = tok.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
          return new RegExp(`\\b${escaped}\\b`).test(hay);
        });
      }).sort((a,b) => a.codeNum - b.codeNum);
    }

    // Apply parity filter (text type cũng support)
    if (parsed.parity) {
      candidates = candidates.filter(t => _matchParity(t.codeNum, parsed.parity));
    }

    if (candidates.length < minRequired) continue;
    if (requireAdjacent && candidates.length >= quantity) {
      const adj = pickAdjacent(candidates, quantity, []);
      if (adj.length >= quantity) return { selected: adj.slice(0,quantity), reason: `adj-text:${raw}` };
      if (!allowSplit && !allowPartial) continue;
    }
    const take = Math.min(candidates.length, quantity);
    return { selected: candidates.slice(0,take), reason: `text:${raw}${take < quantity ? `(partial ${take}/${quantity})` : ""}` };
  }
  return { selected: [], reason: "no match" };
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

async function seatsioSelectGroup(labelGroups, allowPartial = false) {
  return runInPage(function(args) {
    const { labelGroups, allowPartial } = args;

    async function mp(v) { return v && typeof v.then === "function" ? await v : v; }
    function simpleErr(e) { try { return String(e?.message || e).slice(0,200); } catch(_) { return "err"; } }

    return (async () => {
      const logs = [];
      const chart = window.seatsio?.charts?.[0];
      if (!chart) return { ok: false, error: "no seatsio chart", logs, selectedCount: 0 };

      logs.push(`chart found | trySelectObjects=${typeof chart.trySelectObjects} | allowPartial=${allowPartial}`);

      try { await mp(chart.clearSelection()); logs.push("clearSelection OK"); } catch(e) { logs.push("clearSelection err: " + simpleErr(e)); }

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
  }, { labelGroups, allowPartial });
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

// ── Main flow: 1Zone seat_map ─────────────────────────────────────────────────

async function run1ZoneSeatMap(cfg) {
  const aseat = cfg.auto_seat?.["1zone"] || cfg.auto_seat || {};
  const priorities = aseat.zone_priority || aseat.priority_targets || [];
  const quantity = parseInt(aseat.quantity) || 1;
  const requireAdjacent = aseat.require_adjacent !== false;
  const allowSplit = !!aseat.allow_split_seats;
  const allowPartial = !!aseat.allow_partial;

  svpLog(`🗺️ 1Zone seat_map | priority=${priorities.join(",")} | SL=${quantity}${allowPartial ? " (cho phép mua thiếu)" : ""}`, "blue");

  const info = extract1ZoneInfo();
  if (!info.eventId || !info.calendarId) {
    svpLog("❌ Không lấy được eventId/calendarId", "red");
    return false;
  }

  // GET tickets API
  svpLog("📡 GET tickets API...", "blue");
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
  const triedIds = new Set();
  const maxAttempts = Math.min(30, Math.max(1, tickets.length));

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (svpShouldStop()) { svpLog("🛑 Stop signal — abort seat selection loop", "yellow"); return false; }
    const { selected, reason } = selectTickets(remaining, priorities, quantity, requireAdjacent, allowSplit, allowPartial);

    const minRequired = allowPartial ? 1 : quantity;
    if (selected.length < minRequired) {
      svpLog("❌ Không tìm đủ ghế theo ưu tiên. Không chọn bừa ngoài danh sách.", "red");
      return false;
    }
    if (allowPartial && selected.length < quantity) {
      svpLog(`ℹ️ Chỉ tìm được ${selected.length}/${quantity} ghế — proceed do allow_partial=true`, "yellow");
    }

    const labels = selected.map(t => `${t.zoneName} ${t.label}`);
    svpLog(`🎯 Thử chọn ghế lần ${attempt} (${reason}): ${labels.join(", ")}`, "green");

    // Build label groups và thử Seats.io select
    const labelGroups = selected.map(labelVariants);
    svpLog(`🪑 Seats.io select: ${labelGroups.map(g => g[0]).join(", ")}`, "blue");

    let seatsRes;
    try {
      seatsRes = await seatsioSelectGroup(labelGroups, allowPartial);
    } catch(e) {
      svpLog(`❌ Seats.io error: ${e.message}`, "red");
      seatsRes = { ok: false, error: e.message };
    }

    for (const line of (seatsRes?.logs || []).slice(0, 15)) {
      svpLog(`🧪 Seats.io: ${line}`, "blue");
    }

    if (seatsRes?.ok) {
      const partialNote = seatsRes.selectedCount < quantity ? ` (mua thiếu ${seatsRes.selectedCount}/${quantity})` : "";
      svpLog(`✅ Seats.io đã chọn ${seatsRes.selectedCount}/${quantity} ghế${partialNote}`, "green");
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

    // Seats.io fail — CHỈ loại ghế THẬT SỰ fail, giữ ghế đã select OK
    // (Trước fix: loại CẢ selected → next iteration phải tìm lại từ đầu — lãng phí)
    // Sau fix: dùng pickedLabels từ Seats.io → chỉ loại ghế không có trong picked
    const pickedSet = new Set((seatsRes?.pickedLabels || []).map(l => l.toLowerCase()));
    const failedSeats = selected.filter(t => {
      // Check label hoặc objectId xem có trong pickedSet không
      const variants = [t.label, t.objectId, `${t.rowName}-${t.code}`, `${t.rowName}${t.code}`]
        .filter(Boolean).map(s => s.toLowerCase());
      return !variants.some(v => pickedSet.has(v) || [...pickedSet].some(p => p.includes(v)));
    });
    const pickedSeats = selected.filter(t => !failedSeats.includes(t));

    const failedIds = new Set(failedSeats.map(t => t._id).filter(Boolean));
    if (!failedIds.size || [...failedIds].every(id => triedIds.has(id))) {
      svpLog("❌ Seats.io không chọn được và không còn candidate mới.", "red");
      return false;
    }
    failedIds.forEach(id => triedIds.add(id));
    remaining = remaining.filter(t => !triedIds.has(t._id));
    svpLog(`↪️ Loại ${failedIds.size} ghế fail (giữ ${pickedSeats.length} ghế đã select OK), thử tiếp. Tổng loại: ${triedIds.size}.`, "yellow");
  }

  svpLog("❌ Thử nhiều candidate nhưng chưa chọn được ghế trên Seats.io.", "red");
  return false;
}