// src/content/seat_ticketbox_map.js
// Ticketbox seat_map — convert từ seat_selector_ticketbox.py
// Hybrid: API tìm ghế, UI Konva click thật để frontend giữ vé

const API_TB_MAP = "https://api-v2.ticketbox.vn";

// ── Helpers ───────────────────────────────────────────────────────────────────

function normTbMap(s) {
  s = String(s || "").trim().toLowerCase();
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/[^a-z0-9]+/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

async function tbMapFetchJson(url, method = "GET", payload = null) {
  const opts = {
    method, credentials: "include",
    headers: { "Accept": "application/json, text/plain, */*", "Content-Type": "application/json;charset=UTF-8" },
    signal: AbortSignal.timeout(8000),
  };
  if (payload) opts.body = JSON.stringify(payload);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, ok: res.ok, text: text.slice(0, 1200) };
}

function getResult(data) {
  try { return data?.data?.result; } catch { return null; }
}

// ── Parse priority ────────────────────────────────────────────────────────────

function parseRowRangeTbMap(part) {
  part = String(part || "").trim().toUpperCase().replace(/\s/g, "");
  const rows = [];
  const add = r => { r = String(r).trim().toUpperCase(); if (r && !rows.includes(r)) rows.push(r); };
  for (const token of part.split(",")) {
    if (!token) continue;
    const pieces = token.split("-").filter(Boolean);
    if (pieces.length === 2 && pieces[0].length === 1 && pieces[1].length === 1) {
      const a = pieces[0].charCodeAt(0), b = pieces[1].charCodeAt(0);
      const step = a <= b ? 1 : -1;
      for (let i = a; step > 0 ? i <= b : i >= b; i += step) add(String.fromCharCode(i));
    } else if (pieces.length > 2 && pieces.every(x => /^[A-Z]+$/.test(x))) {
      pieces.forEach(add);
    } else {
      add(token);
    }
  }
  return rows;
}

function parseNumSpecTbMap(part) {
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

function numAllowedTbMap(num, spec) {
  if (!spec) return true;
  const { ranges, values } = spec;
  if (!ranges.length && !values.size) return true;
  if (values.has(num)) return true;
  return ranges.some(([lo,hi]) => num >= lo && num <= hi);
}

function numRankTbMap(num, order) {
  if (!order?.length) return 999999;
  const i = order.indexOf(num);
  return i >= 0 ? i : 999999;
}

function parsePriorityTbMap(target) {
  const raw = String(target || "").trim();
  const compact = raw.toUpperCase().replace(/\s/g, "");
  if (!raw) return { type: "empty", raw };

  if (compact.includes(":")) {
    const [left, right] = compact.split(":", 2);
    const rows = parseRowRangeTbMap(left);
    const numSpec = parseNumSpecTbMap(right);
    if (rows.length && (numSpec.ranges.length || numSpec.values.size))
      return { type: "range", raw, rows, numSpec };
  }

  const exact = [];
  let okExact = true;
  for (const token of compact.split(",")) {
    if (!token) continue;
    const m = token.match(/^([A-Z]+)-?(\d+)$/);
    if (!m) { okExact = false; break; }
    exact.push({ row: m[1], num: parseInt(m[2]), label: `${m[1]}-${parseInt(m[2])}` });
  }
  if (exact.length && okExact) return { type: "exact", raw, seats: exact };

  return { type: "text", raw, norm: normTbMap(raw) };
}

// ── Extract available seats from section detail ───────────────────────────────

function seatNumFromName(name) {
  const m = String(name || "").match(/\d+/);
  return m ? parseInt(m[0]) : null;
}

function isAvailableSeat(seat) {
  return seat?.status === 1;
}

function flattenAvailable(sectionDetail) {
  const out = [];
  for (const row of sectionDetail?.rows || []) {
    const rowName = String(row.name || "").trim().toUpperCase();
    for (const seat of row.seats || []) {
      if (!isAvailableSeat(seat)) continue;
      const seatNum = seatNumFromName(seat.name);
      if (seatNum == null) continue;
      out.push({
        ...seat,
        rowName,
        seatNum,
        label: `${rowName}-${seat.name}`,
        position: seat.position ?? 999999,
      });
    }
  }
  return out;
}

// ── Adjacent finder ───────────────────────────────────────────────────────────

function findAdjacentInSingleRow(rowSeats, quantity, numOrder) {
  if (rowSeats.length < quantity) return [];
  const byPos = [...rowSeats].sort((a,b) => a.position - b.position || a.seatNum - b.seatNum);
  const candidates = [];
  for (let i = 0; i <= byPos.length - quantity; i++) {
    const group = byPos.slice(i, i + quantity);
    const positions = group.map(g => g.position);
    if (positions.every(p => p >= 0)) {
      if (positions.join(",") === Array.from({length: quantity}, (_, k) => positions[0] + k).join(","))
        candidates.push(group);
    } else {
      candidates.push(group);
    }
  }
  if (!candidates.length) return [];
  const score = group => {
    if (numOrder?.length) {
      const ranks = group.map(g => numRankTbMap(g.seatNum, numOrder)).sort((a,b) => a-b);
      return [ranks[0], group[0].position];
    }
    return [group[0].position, 0];
  };
  return candidates.sort((a,b) => {
    const sa = score(a), sb = score(b);
    return sa[0] - sb[0] || sa[1] - sb[1];
  })[0];
}

function pickFromRowsInOrder(seats, rowOrder, numOrder, quantity, requireAdjacent, allowSplit) {
  const byRow = {};
  for (const s of seats) (byRow[s.rowName] = byRow[s.rowName] || []).push(s);

  const sortRow = rowSeats => {
    if (numOrder?.length)
      return [...rowSeats].sort((a,b) => numRankTbMap(a.seatNum, numOrder) - numRankTbMap(b.seatNum, numOrder) || a.position - b.position);
    return [...rowSeats].sort((a,b) => a.position - b.position || a.seatNum - b.seatNum);
  };

  for (const row of rowOrder) {
    const rowSeats = byRow[row] || [];
    if (rowSeats.length < quantity) continue;
    if (requireAdjacent) {
      const group = findAdjacentInSingleRow(rowSeats, quantity, numOrder);
      if (group.length) return group;
      if (!allowSplit) continue;
    }
    const ordered = sortRow(rowSeats);
    if (ordered.length >= quantity) return ordered.slice(0, quantity);
  }

  if (allowSplit) {
    const out = [];
    for (const row of rowOrder) {
      for (const s of sortRow(byRow[row] || [])) {
        out.push(s);
        if (out.length >= quantity) return out;
      }
    }
  }
  return [];
}

function applyNumberMode(seats, mode) {
  mode = String(mode || "auto").toLowerCase();
  if (mode === "odd") return seats.filter(s => s.seatNum % 2 === 1);
  if (mode === "even") return seats.filter(s => s.seatNum % 2 === 0);
  return seats;
}

function tryPickFromSection(sectionDetail, parsed, quantity, requireAdjacent, allowSplit, seatNumberMode) {
  const seats = flattenAvailable(sectionDetail);
  if (!seats.length) return [];

  if (parsed.type === "exact") {
    const selected = [];
    for (const want of parsed.seats) {
      const found = seats.find(s => s.rowName === want.row && s.seatNum === want.num);
      if (!found) return [];
      selected.push(found);
    }
    return selected.length >= quantity ? selected : [];
  }

  if (parsed.type === "range") {
    const rowOrder = parsed.rows.map(r => String(r).toUpperCase());
    const numSpec = parsed.numSpec || {};
    const numOrder = numSpec.order || [];
    const allowedRows = new Set(rowOrder);
    let filtered = seats.filter(s => allowedRows.has(s.rowName) && numAllowedTbMap(s.seatNum, numSpec));
    filtered = applyNumberMode(filtered, seatNumberMode);
    if (filtered.length < quantity) return [];
    return pickFromRowsInOrder(filtered, rowOrder, numOrder, quantity, requireAdjacent, allowSplit);
  }

  // Text match
  let filtered = applyNumberMode(seats, seatNumberMode);
  if (filtered.length < quantity) return [];
  if (requireAdjacent) {
    const byRow = {};
    for (const s of filtered) (byRow[s.rowName] = byRow[s.rowName] || []).push(s);
    for (const rowSeats of Object.values(byRow)) {
      const group = findAdjacentInSingleRow(rowSeats, quantity, []);
      if (group.length) return group;
    }
    if (!allowSplit) return [];
  }
  return filtered.sort((a,b) => a.rowName.localeCompare(b.rowName) || a.position - b.position).slice(0, quantity);
}

// ── Resolve showing candidates ────────────────────────────────────────────────

function isSalableShowing(showing) {
  const status = String(showing?.status || "").toLowerCase();
  const statusName = normTbMap(showing?.statusName || "");
  return showing?.isSalable === true || status === "book_now" || statusName.includes("mua ve");
}

function showingDateFromObjMap(showing) {
  for (const key of ["startTime", "startDate", "date", "showingDate"]) {
    const v = String((showing || {})[key] || "");
    const m = v.match(/(20\d{2}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return "";
}

function extractRuntimeShowingsMap() {
  const out = [];
  try {
    for (const e of performance.getEntriesByType("resource")) {
      const url = String(e.name || "");
      let m = url.match(/showings\/(\d+)(?:\?date=(\d{4}-\d{2}-\d{2}))?/);
      if (m) out.push({ id: m[1], date: m[2] || "" });
      m = url.match(/events\/(\d+)\/bookings\/(\d+)\//);
      if (m) out.push({ id: m[2], date: "" });
    }
  } catch {}
  return out;
}

async function resolveShowingCandidates(eventId, urlShowingId, urlDate) {
  const runtime = extractRuntimeShowingsMap();
  let preferredDate = urlDate || "";
  if (!preferredDate) {
    for (const r of runtime) { if (r.date) { preferredDate = r.date; break; } }
  }
  if (!preferredDate) preferredDate = new Date().toISOString().slice(0, 10);

  const byId = {};
  const add = (sid, date, source, raw) => {
    const id = parseInt(sid);
    if (!id || id <= 0) return;
    const old = byId[id] || {};
    const merged = { ...old, ...(raw || {}), id };
    merged.date = date || merged.date || showingDateFromObjMap(raw || {}) || preferredDate;
    const sources = new Set((merged._source || "").split(",").filter(Boolean));
    if (source) sources.add(source);
    merged._source = [...sources].sort().join(",");
    byId[id] = merged;
  };

  // Từ event API
  try {
    const res = await tbMapFetchJson(`${API_TB_MAP}/gin/api/v2/events/${eventId}`);
    if (res.ok) {
      const showings = res.data?.data?.result?.showings || [];
      for (const s of showings) {
        const d = showingDateFromObjMap(s) || preferredDate;
        add(s.id, d, "event-api", s);
      }
    }
  } catch {}

  // Từ performance resource
  for (const r of runtime) add(r.id, r.date || preferredDate, "performance", r);

  // URL showing
  add(urlShowingId, preferredDate, "url", { id: urlShowingId });

  const candidates = Object.values(byId);
  candidates.sort((a, b) => {
    const sameDate = (d => d === preferredDate ? 1 : 0);
    return (sameDate(b.date) - sameDate(a.date)) ||
      (isSalableShowing(b) ? 1 : 0) - (isSalableShowing(a) ? 1 : 0) ||
      (b._source?.includes("event-api") ? 1 : 0) - (a._source?.includes("event-api") ? 1 : 0) ||
      b.id - a.id;
  });
  return candidates;
}

// ── Section text match ────────────────────────────────────────────────────────

function sectionMatchesText(section, ticketType, targetNorm) {
  const names = [section?.name, section?.shortName, section?.description,
    ticketType?.name, ticketType?.shortName, ticketType?.description];
  const hay = names.filter(Boolean).map(normTbMap).join(" ");
  return !!(targetNorm && hay.includes(targetNorm));
}

// ── Konva seat click (qua runInPage) ─────────────────────────────────────────

async function konvaStageInfoTbMap() {
  return runInPage(function() {
    const stage = window.Konva?.stages?.[0];
    const container = stage?.container?.() || document.querySelector(".konvajs-content");
    const box = container?.getBoundingClientRect?.();
    if (!stage || !box) return null;
    return {
      left: box.left, top: box.top, width: box.width, height: box.height,
      stageX: stage.x(), stageY: stage.y(),
      scaleX: stage.scaleX(), scaleY: stage.scaleY(),
    };
  }, {});
}

async function konvaNodePointTbMap(seat) {
  return runInPage(function(args) {
    const { seatId, label, row, num, name } = args;
    const stage = window.Konva?.stages?.[0];
    const container = stage?.container?.() || document.querySelector(".konvajs-content");
    const box = container?.getBoundingClientRect?.();
    if (!stage || !box) return null;

    const needles = [seatId, label, `${row}-${num}`, `${row}${num}`, name]
      .map(x => String(x || "").toLowerCase()).filter(Boolean);

    const nodes = stage.find ? stage.find("*") : [];
    for (const node of nodes) {
      const attrs = node.attrs || {};
      const hay = JSON.stringify(attrs).toLowerCase();
      if (!needles.some(n => hay.includes(n))) continue;
      let x = null, y = null;
      try {
        const r = node.getClientRect({ skipShadow: true, skipStroke: false });
        if (r && isFinite(r.x) && r.width > 0) { x = r.x + r.width / 2; y = r.y + r.height / 2; }
      } catch {}
      if (x == null) {
        try {
          const pt = node.getAbsoluteTransform().point({ x: 0, y: 0 });
          if (isFinite(pt.x)) { x = pt.x; y = pt.y; }
        } catch {}
      }
      if (x == null) continue;
      return { x: box.left + x, y: box.top + y, debug: `konva-node ${JSON.stringify(attrs).slice(0, 100)}` };
    }
    return null;
  }, {
    seatId: String(seat.id || ""), label: String(seat.label || ""),
    row: String(seat.rowName || ""), num: String(seat.seatNum || ""),
    name: String(seat.name || ""),
  });
}

function isContinueEnabled() {
  const btns = Array.from(document.querySelectorAll("button"));
  const candidates = btns.filter(b => {
    if (b.disabled || b.getAttribute("aria-disabled") === "true") return false;
    const r = b.getBoundingClientRect();
    if (!r || r.width <= 0) return false;
    const st = window.getComputedStyle(b);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const txt = normTbMap(b.textContent || "");
    const cls = String(b.className || "");
    const score = (cls.includes("bottomBooking") ? 100 : 0) +
      (/tiep tuc|thanh toan|checkout|continue/.test(txt) ? 50 : 0);
    return score > 0;
  });
  return candidates.length > 0;
}

async function clickSeatOnCanvas(seat, allSectionSeats) {
  const label = seat.label || `${seat.rowName}-${seat.seatNum}`;
  const points = [];

  // 1) Konva node thật
  try {
    const nodePt = await konvaNodePointTbMap(seat);
    if (nodePt?.x != null) points.push({ x: nodePt.x, y: nodePt.y, mode: `konva-node: ${nodePt.debug?.slice(0, 80)}` });
  } catch {}

  // 2) Live Konva stage transform
  try {
    const info = await konvaStageInfoTbMap();
    if (info && info.width > 50) {
      const seatX = seat.x ?? seat.coordinateX ?? seat.coordinate?.x;
      const seatY = seat.y ?? seat.coordinateY ?? seat.coordinate?.y;
      if (seatX != null && seatY != null) {
        const px = info.left + info.stageX + parseFloat(seatX) * info.scaleX;
        const py = info.top + info.stageY + parseFloat(seatY) * info.scaleY;
        points.push({ x: px, y: py, mode: `konva-transform scaleX=${info.scaleX.toFixed(3)}` });
      }
    }
  } catch {}

  if (!points.length) {
    svpLog(`⚠️ Ghế ${label} không có tọa độ khả dụng`, "yellow");
    return false;
  }

  const offsets = [[0,0],[2,0],[-2,0],[0,2],[0,-2],[4,0],[-4,0],[0,4],[0,-4],[6,0],[-6,0],[0,6],[0,-6]];

  for (const p of points) {
    svpLog(`🎯 Thử click ${label}: mode=${p.mode} point=(${p.x.toFixed(1)},${p.y.toFixed(1)}) hit=${elemAt(p.x, p.y)}`, "blue");
    for (const [dx, dy] of offsets) {
      await realClick(p.x + dx, p.y + dy);
      await sleep(250);
      if (isContinueEnabled()) {
        svpLog(`✅ UI xác nhận đã chọn ghế: ${label}`, "green");
        return true;
      }
    }
  }
  svpLog(`⚠️ Click canvas xong nhưng UI chưa xác nhận ghế: ${label}`, "yellow");
  return false;
}

// ── Click Tiếp tục / Thanh toán ──────────────────────────────────────────────

async function clickCheckoutButtonTbMap() {
  // Chờ button sáng
  for (let i = 0; i < 12; i++) {
    if (isContinueEnabled()) break;
    await sleep(250);
  }

  const btns = Array.from(document.querySelectorAll("button")).filter(b => {
    if (b.disabled) return false;
    const r = b.getBoundingClientRect();
    if (!r || r.width <= 0) return false;
    const st = window.getComputedStyle(b);
    if (st.display === "none" || st.visibility === "hidden") return false;
    const txt = normTbMap(b.textContent || "");
    const cls = String(b.className || "");
    return (cls.includes("bottomBooking") ? 100 : 0) +
      (/tiep tuc|thanh toan|checkout|continue/.test(txt) ? 50 : 0) > 0;
  }).sort((a, b) => {
    const score = el => {
      const cls = String(el.className || "");
      const txt = normTbMap(el.textContent || "");
      return (cls.includes("bottomBooking") ? 100 : 0) + (/tiep tuc|thanh toan/.test(txt) ? 50 : 0);
    };
    return score(b) - score(a);
  });

  if (btns.length) {
    btns[0].click();
    svpLog(`🖱️ Đã click: ${btns[0].textContent?.trim()}`, "blue");
    return true;
  }
  svpLog("⚠️ Không tìm thấy nút Thanh toán/Tiếp tục đang sáng", "yellow");
  return false;
}

// ── Main flow: Ticketbox seat_map ─────────────────────────────────────────────

async function runTicketboxSeatMap(cfg) {
  const aseat = cfg.auto_seat || {};
  const priorityTargets = aseat.zone_priority || aseat.priority_targets || [];
  const quantity = parseInt(aseat.quantity) || 1;
  const requireAdjacent = aseat.require_adjacent !== false;
  const allowSplit = !!aseat.allow_split_seats;
  const seatNumberMode = String(aseat.seat_number_mode || "auto").toLowerCase();

  svpLog(`🪑 Ticketbox seat_map | SL=${quantity} | dãy=${seatNumberMode}`, "yellow");

  const info = extractTicketboxInfo();
  if (!info.eventId || !info.showingId) {
    svpLog("❌ Không tìm được eventId/showingId Ticketbox", "red");
    return false;
  }
  if (!priorityTargets.length) {
    svpLog("❌ Chưa nhập ưu tiên ghế/vé", "red");
    return false;
  }

  const candidates = await resolveShowingCandidates(info.eventId, info.showingId, info.date);
  if (!candidates.length) candidates.push({ id: info.showingId, date: info.date || new Date().toISOString().slice(0,10), _source: "url-only" });

  svpLog(`🔎 Showing candidates: ${candidates.slice(0,4).map(c => `${c.id}@${c.date}[${c._source}]`).join(", ")}`, "blue");

  let lastErr = "";

  for (let cidx = 0; cidx < candidates.length; cidx++) {
    const cand = candidates[cidx];
    const showingId = cand.id;
    const date = cand.date || new Date().toISOString().slice(0, 10);
    svpLog(`🎬 Thử showing ${cidx+1}/${candidates.length}: ${showingId} | date=${date}`, "yellow");

    // GET showings
    const showRes = await tbMapFetchJson(`${API_TB_MAP}/event/api/v1/events/showings/${showingId}?date=${date}`);
    if (!showRes.ok) { svpLog(`⚠️ GET showings ${showingId} fail HTTP=${showRes.status}`, "yellow"); continue; }
    const showing = getResult(showRes.data) || {};
    const ticketTypes = {};
    for (const t of showing.ticketTypes || []) ticketTypes[t.id] = t;
    svpLog(`✅ Showings OK | showing=${showingId} | ticketTypes=${Object.keys(ticketTypes).length}`, "green");

    // GET seatmap
    const seatmapRes = await tbMapFetchJson(`${API_TB_MAP}/event/api/v1/events/showings/${showingId}/seatmap`);
    if (!seatmapRes.ok) { svpLog(`⚠️ GET seatmap ${showingId} fail HTTP=${seatmapRes.status}`, "yellow"); continue; }
    const seatmap = getResult(seatmapRes.data) || {};
    const sections = (seatmap.sections || []).filter(s => s.isReservingSeat && !s.isStage && s.status === 1);
    if (!sections.length) { svpLog(`⚠️ Seatmap ${showingId} không có section hợp lệ`, "yellow"); continue; }
    svpLog(`🗺️ Seatmap OK | showing=${showingId} | sections=${sections.length}`, "green");

    for (let pidx = 0; pidx < priorityTargets.length; pidx++) {
      const target = priorityTargets[pidx];
      const parsed = parsePriorityTbMap(target);
      svpLog(`🎯 Ưu tiên ${pidx+1}: ${target} | type=${parsed.type}`, "yellow");

      let candidateSections = sections;
      if (parsed.type === "text") {
        candidateSections = sections.filter(s => sectionMatchesText(s, ticketTypes[s.ticketTypeId], parsed.norm));
        if (!candidateSections.length) {
          svpLog(`⚠️ Không thấy section khớp: ${target}`, "yellow");
          continue;
        }
      }

      for (const sec of candidateSections) {
        const secId = sec.id;
        const secName = sec.name || "";
        const tt = ticketTypes[sec.ticketTypeId] || {};
        const ttName = tt.name || "";

        // GET section detail
        const secRes = await tbMapFetchJson(`${API_TB_MAP}/event/api/v1/events/showings/${showingId}/sections/${secId}`);
        if (!secRes.ok) { svpLog(`⚠️ GET section ${secName}/${secId} fail HTTP=${secRes.status}`, "yellow"); continue; }
        const sectionDetail = { ...(getResult(secRes.data) || {}), ...sec };

        const selected = tryPickFromSection(sectionDetail, parsed, quantity, requireAdjacent, allowSplit, seatNumberMode);
        if (!selected.length) continue;

        const labels = selected.map(s => s.label);
        svpLog(`✅ Chọn được ${selected.length} ghế: ${labels.join(", ")} | section=${secName} | ticket=${ttName}`, "green");

        // Navigate đúng showing nếu cần
        const curUrl = location.href;
        if (!curUrl.includes(`/bookings/${showingId}/`)) {
          svpLog(`↪️ Chuyển UI sang showing: ${showingId}`, "blue");
          location.href = `https://ticketbox.vn/events/${info.eventId}/bookings/${showingId}/select-ticket`;
          await sleep(1500);
        }

        // Click từng ghế
        let allClicked = true;
        for (const seat of selected) {
          const ok = await clickSeatOnCanvas(seat, flattenAvailable(sectionDetail));
          if (!ok) { allClicked = false; lastErr = "không click được ghế trên UI"; break; }
        }
        if (!allClicked) {
          svpLog(`⚠️ ${lastErr}; thử option tiếp theo`, "yellow");
          continue;
        }

        // Click Thanh toán
        const okPay = await clickCheckoutButtonTbMap();
        if (!okPay) {
          svpLog("⚠️ Không click được nút thanh toán. Ghế đã chọn, mày có thể bấm tay.", "yellow");
          return true;
        }

        await sleep(800);
        svpLog("✅ Đã chọn ghế và bấm Tiếp tục. Dừng ở bước form để mày tự xử lý.", "green");
        return true;
      }
    }
  }

  if (lastErr) svpLog(`❌ Đã tìm được ghế nhưng UI click fail. Lỗi cuối: ${lastErr}`, "red");
  else svpLog("❌ Không tìm được ghế theo ưu tiên. Dừng, không chọn bừa.", "red");
  return false;
}