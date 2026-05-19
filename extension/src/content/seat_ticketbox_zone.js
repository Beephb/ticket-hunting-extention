// src/content/seat_ticketbox_zone.js
// Ticketbox seat_zone — convert từ seat_selector_ticketbox_zone.py
// Konva-native: dùng data-section-id trên group Konva layer[1]
// KHÔNG POST API trực tiếp — click button UI để frontend tự sinh token

const API_TB_ZONE = "https://api-v2.ticketbox.vn";

// ── Helpers ───────────────────────────────────────────────────────────────────

function normTb(s) {
  s = String(s || "").trim().toLowerCase();
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/_/g, " ").replace(/[^a-z0-9]+/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function tokensTb(s) {
  return normTb(s).split(" ").filter(Boolean);
}

// ── Zone score (chặt — VIP_B không ăn VIP_A) ─────────────────────────────────

function zoneScoreTb(target, candidate) {
  const tks = tokensTb(target);
  const cks = tokensTb(candidate);
  if (!tks.length || !cks.length) return 0;
  const t = tks.join(" "), c = cks.join(" ");
  if (t === c) return 1000;

  let pos = 0;
  for (const tk of tks) {
    let found = false;
    while (pos < cks.length) {
      if (cks[pos] === tk) { found = true; pos++; break; }
      pos++;
    }
    if (!found) return 0;
  }
  let score = 700;
  if (c.startsWith(t)) score += 80;
  score -= Math.max(0, cks.length - tks.length);
  return score;
}

// ── Fetch JSON trong browser context ─────────────────────────────────────────

async function tbFetchJson(url, method = "GET", payload = null) {
  const opts = {
    method,
    credentials: "include",
    headers: {
      "Accept": "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8",
    },
    signal: AbortSignal.timeout(6000),
  };
  if (payload) opts.body = JSON.stringify(payload);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, ok: res.ok };
}

// ── Resolve date candidates ───────────────────────────────────────────────────

function extractRuntimeShowings() {
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

function showingDateFromObj(showing) {
  for (const key of ["startTime", "startDate", "date", "showingDate", "startedAt"]) {
    const v = String((showing || {})[key] || "");
    const m = v.match(/(20\d{2}-\d{2}-\d{2})/);
    if (m) return m[1];
  }
  return "";
}

async function resolveDateCandidates(eventId, showingId, urlDate) {
  const out = [];
  const add = d => {
    d = String(d || "").trim();
    if (/^20\d{2}-\d{2}-\d{2}$/.test(d) && !out.includes(d)) out.push(d);
  };

  // Từ performance resource
  for (const r of extractRuntimeShowings()) {
    if (r.id === String(showingId)) add(r.date);
  }
  for (const r of extractRuntimeShowings()) add(r.date);

  // Từ event API
  try {
    const res = await tbFetchJson(`${API_TB_ZONE}/gin/api/v2/events/${eventId}`);
    if (res.ok) {
      const showings = res.data?.data?.result?.showings || [];
      for (const s of showings) {
        if (String(s.id) === String(showingId)) add(showingDateFromObj(s));
      }
      for (const s of showings) add(showingDateFromObj(s));
    }
  } catch {}

  add(urlDate);
  add(new Date().toISOString().slice(0, 10));
  return out;
}

// ── Collect API zones từ showing + seatmap JSON ──────────────────────────────

function* walkObj(obj) {
  if (!obj) return;
  if (Array.isArray(obj)) { for (const x of obj) yield* walkObj(x); return; }
  if (typeof obj === "object") { yield obj; for (const v of Object.values(obj)) yield* walkObj(v); }
}

function collectApiZones(showJson, seatmapJson, target) {
  const candidates = [];

  function consider(d, source) {
    const name = d.ticketTypeName || d.sectionName || d.section_name ||
      d.name || d.label || d.title || d.shortName || "";
    if (!name) return;
    const score = zoneScoreTb(target, name);
    if (score <= 0) return;

    let ticketTypeId = d.ticketTypeId || d.ticket_type_id ||
      (("price" in d || "ticketTypeName" in d || "quantity" in d || "maxQuantity" in d) ? d.id : null);
    let sectionId = d.sectionId || d.section_id;
    if (sectionId == null && source === "seatmap") sectionId = d.id;

    ticketTypeId = ticketTypeId != null && String(ticketTypeId).match(/^\d+$/) ? parseInt(ticketTypeId) : null;
    sectionId = sectionId != null && String(sectionId).match(/^\d+$/) ? parseInt(sectionId) : null;

    candidates.push({
      name: String(name),
      score: score + (source === "showing" ? 40 : 0),
      ticketTypeId,
      sectionId,
      source,
      raw: d,
    });
  }

  for (const d of walkObj(showJson)) consider(d, "showing");
  for (const d of walkObj(seatmapJson)) consider(d, "seatmap");

  // Merge sectionId từ candidate khác cùng tên
  for (const c of candidates) {
    if (c.sectionId == null) {
      for (const other of candidates) {
        if (other === c || other.sectionId == null) continue;
        if (zoneScoreTb(c.name, other.name) > 0 || zoneScoreTb(other.name, c.name) > 0) {
          c.sectionId = other.sectionId;
          break;
        }
      }
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  return candidates;
}

// ── API zone ticket status ────────────────────────────────────────────────────

function apiZoneTicketStatus(apiZone) {
  const raw = (apiZone || {}).raw || {};
  const ticketType = raw.ticketType || raw.ticket_type || {};
  const status = raw.status;
  const ticketStatus = normTb(ticketType.status || raw.ticketStatus || raw.ticket_status || raw.statusCode || "");
  const statusName = normTb(ticketType.statusName || ticketType.status_name || raw.statusName || raw.status_name || "");

  let soldOut = false, salable = false;
  if (["sold out", "soldout", "het ve"].includes(ticketStatus)) soldOut = true;
  if (statusName.includes("het ve")) soldOut = true;
  if (String(status) === "2") soldOut = true;
  if (["book now", "on sale", "available", "dang ban", "mo ban"].includes(ticketStatus)) salable = true;
  if (statusName.includes("mua ve ngay")) salable = true;
  if (String(status) === "1") salable = true;
  if (soldOut) salable = false;

  return { status, ticketStatus, statusName, soldOut, salable };
}

function chooseBestSalable(candidates) {
  const salable = [], soldOut = [], unknown = [];
  for (const c of candidates) {
    const info = apiZoneTicketStatus(c);
    c.apiAvailability = info;
    if (info.soldOut) soldOut.push(c);
    else if (info.salable) salable.push(c);
    else unknown.push(c);
  }
  if (salable.length) return { chosen: salable[0], salable, soldOut };
  if (unknown.length) return { chosen: unknown[0], salable, soldOut };
  return { chosen: null, salable, soldOut };
}

// ── Modal detector ────────────────────────────────────────────────────────────

function isTbZoneModalOpen() {
  const modal = document.querySelector(".ReactModal__Content.ReactModal__Content--after-open") ||
    document.querySelector(".ReactModal__Content") ||
    document.querySelector(".tbox-modal__content");

  if (modal) {
    const r = modal.getBoundingClientRect?.();
    const txt = String(modal.innerText || "");
    const hasInput = !!modal.querySelector("input[readonly], input.ant-input");
    const hasPlus = Array.from(modal.querySelectorAll("button"))
      .some(b => String(b.innerText || b.textContent || "").trim() === "+");
    const hasContinue = /Vui lòng chọn vé|Tiếp tục|Chọn khu vực khác/i.test(txt);
    if (r && r.width > 100 && r.height > 100 && (hasInput || hasPlus || hasContinue || /Khu\s+/i.test(txt) || /TICKET/i.test(txt)))
      return true;
  }

  const bodyText = String(document.body?.innerText || "");
  return bodyText.includes("Vui lòng chọn vé") && bodyText.includes("Chọn khu vực khác");
}

// ── Konva zone click (qua runInPage) ─────────────────────────────────────────

async function konvaZonePointsTb(sectionId) {
  return runInPage(function(args) {
    const wantedSid = String(args.sectionId);

    function safeStr(v) { return v === undefined || v === null ? "" : String(v); }
    function kids(n) {
      try {
        if (!n) return [];
        if (n.children && typeof n.children.length === "number") return Array.from(n.children);
        if (typeof n.getChildren === "function") return Array.from(n.getChildren());
      } catch {}
      return [];
    }
    function attr(n, k) {
      try {
        if (!n) return undefined;
        if (n.attrs && Object.prototype.hasOwnProperty.call(n.attrs, k)) return n.attrs[k];
        if (typeof n.getAttr === "function") return n.getAttr(k);
      } catch {}
      return undefined;
    }
    function getRect(n) {
      try {
        const r = n.getClientRect({ skipShadow: true, skipStroke: false });
        if (r && isFinite(r.x) && r.width > 1 && r.height > 1) return r;
      } catch {}
      try {
        const r = n.getClientRect();
        if (r && isFinite(r.x) && r.width > 1 && r.height > 1) return r;
      } catch {}
      return null;
    }
    function isWhite(n) {
      const f = safeStr(attr(n, "fill")).toLowerCase().replace(/\s+/g, "");
      return f === "#fff" || f === "#ffffff" || f === "rgb(255,255,255)";
    }
    function bestChild(group) {
      const arr = kids(group);
      let best = null, bestScore = -1;
      for (const c of arr) {
        const r = getRect(c);
        if (!r) continue;
        const a = r.width * r.height;
        let score = a;
        const cn = c.getClassName?.() || "";
        if (cn === "Path") score *= 3;
        if (!isWhite(c)) score *= 8;
        if (score > bestScore) { bestScore = score; best = c; }
      }
      return best || arr[0] || group;
    }

    const stage = window.Konva?.stages?.[0];
    if (!stage) return [{ x: -1, y: -1, mode: "NO_STAGE" }];

    const container = stage.container?.() || document.querySelector(".konvajs-content");
    if (!container) return [{ x: -1, y: -1, mode: "NO_CONTAINER" }];

    const box = container.getBoundingClientRect();
    if (!box || !box.width) return [{ x: -1, y: -1, mode: "BAD_CONTAINER_RECT" }];

    const stageKids = kids(stage);
    const layer = stageKids[1];
    if (!layer) return [{ x: -1, y: -1, mode: "NO_LAYER_1", debug: `stageKids=${stageKids.length}` }];

    const groups = kids(layer);
    const sidList = groups.map((g, i) => ({ i, sid: attr(g, "data-section-id"), childCount: kids(g).length }));

    let group = null, groupIndex = -1;
    for (let i = 0; i < groups.length; i++) {
      if (safeStr(attr(groups[i], "data-section-id")) === wantedSid) {
        group = groups[i]; groupIndex = i; break;
      }
    }

    if (!group) return [{
      x: -1, y: -1,
      mode: `NO_MATCH_SECTION_ID wanted=${wantedSid}`,
      debug: JSON.stringify(sidList).slice(0, 800),
    }];

    const main = bestChild(group);
    const r = getRect(main) || getRect(group);
    if (!r) return [{ x: -1, y: -1, mode: `MATCH_BUT_NO_RECT sid=${wantedSid}` }];

    let cx = r.x + r.width / 2;
    let cy = r.y + r.height / 2;
    if (r.height > 180) cy = r.y + r.height * 0.38;

    const stageW = Number(stage.width?.() || stage.attrs?.width || box.width || 1);
    const stageH = Number(stage.height?.() || stage.attrs?.height || box.height || 1);

    const out = [];
    const rels = [[0.50, 0.50], [0.50, 0.38], [0.35, 0.50], [0.65, 0.50], [0.50, 0.62]];
    const debug = `sidList=${JSON.stringify(sidList).slice(0, 300)}`;

    // First point từ cx/cy tính sẵn
    out.push({
      x: box.left + cx * (box.width / stageW),
      y: box.top + cy * (box.height / stageH),
      mode: `SECTION_ID_EXACT groupIndex=${groupIndex} sid=${wantedSid}`,
      debug,
    });
    // Rel points
    for (const [rx, ry] of rels) {
      out.push({
        x: box.left + (r.x + r.width * rx) * (box.width / stageW),
        y: box.top + (r.y + r.height * ry) * (box.height / stageH),
        mode: `SECTION_ID_ALT rx=${rx} ry=${ry}`,
        debug: `sid=${wantedSid}`,
      });
    }
    return out;
  }, { sectionId });
}

async function clickZoneKonvaTb(target, apiZone) {
  if (!apiZone?.sectionId) {
    svpLog(`⚠️ Không có sectionId cho zone: ${target}`, "yellow");
    return false;
  }

  let points;
  try {
    points = await konvaZonePointsTb(apiZone.sectionId);
  } catch(e) {
    svpLog(`❌ Konva evaluate lỗi: ${e.message}`, "red");
    return false;
  }

  if (!points?.length || points[0].x < 0) {
    svpLog(`⚠️ Konva không tìm được zone: ${target} | ${points?.[0]?.mode} | ${(points?.[0]?.debug || "").slice(0, 200)}`, "yellow");
    return false;
  }

  svpLog(`🔎 Konva candidates: ${points.length} | ${points[0].mode} | ${(points[0].debug || "").slice(0, 150)}`, "blue");

  const offsets = [[0,0],[3,0],[-3,0],[0,3],[0,-3],[8,0],[-8,0],[0,8],[0,-8]];

  for (const p of points.slice(0, 10)) {
    if (isTbZoneModalOpen()) {
      svpLog(`✅ Popup mở trước khi thử point tiếp: ${target}`, "green");
      return true;
    }
    const bx = p.x, by = p.y;
    const hit = elemAt(bx, by);
    svpLog(`🎯 Thử click: mode=${p.mode} point=(${bx.toFixed(1)},${by.toFixed(1)}) hit=${hit}`, "blue");

    for (const [dx, dy] of offsets) {
      await realClick(bx + dx, by + dy);
      for (let i = 0; i < 8; i++) {
        await sleep(120);
        if (isTbZoneModalOpen()) {
          svpLog(`✅ Popup mở: ${target} | point=(${(bx+dx).toFixed(1)},${(by+dy).toFixed(1)})`, "green");
          return true;
        }
      }
    }
  }

  svpLog(`⚠️ Click Konva xong nhưng popup chưa mở: ${target}`, "yellow");
  return false;
}

// ── Modal info ────────────────────────────────────────────────────────────────

function getTbModalInfo() {
  const modal = document.querySelector(".ReactModal__Content.ReactModal__Content--after-open") ||
    document.querySelector(".ReactModal__Content") ||
    document.querySelector(".tbox-modal__content");

  if (!modal) return { visible: false, reason: "NO_MODAL" };

  const r = modal.getBoundingClientRect();
  const txt = String(modal.innerText || "");
  const input = modal.querySelector("input[readonly].ant-input") ||
    modal.querySelector("input[readonly]") ||
    modal.querySelector("input.ant-input");
  const btns = Array.from(modal.querySelectorAll("button"));
  const plusBtn = btns.find(b => String(b.innerText || b.textContent || "").trim() === "+");
  const minusBtn = btns.find(b => String(b.innerText || b.textContent || "").trim() === "-");
  const contBtn = btns.find(b => /tiếp tục|tiep tuc|vui lòng chọn vé/i.test(String(b.innerText || b.textContent || "")));

  function center(el) {
    if (!el) return null;
    const br = el.getBoundingClientRect();
    if (!br || br.width <= 0) return null;
    return { x: br.left + br.width / 2, y: br.top + br.height / 2, el, disabled: !!el.disabled };
  }

  return {
    visible: !!(r && r.width > 100 && r.height > 100),
    qty: input ? parseInt(input.value || "0") : null,
    plus: center(plusBtn),
    minus: center(minusBtn),
    cont: center(contBtn),
  };
}

// ── Set modal quantity ────────────────────────────────────────────────────────

async function setTbModalQuantity(targetQty) {
  // Chờ modal visible
  for (let i = 0; i < 30; i++) {
    if (getTbModalInfo().visible) break;
    await sleep(100);
  }

  for (let attempt = 0; attempt < 20; attempt++) {
    const info = getTbModalInfo();
    if (!info.visible) return false;

    const cur = info.qty;
    if (cur == null) {
      svpLog("⚠️ Popup không có input số lượng", "yellow");
      return false;
    }
    if (cur === targetQty) {
      svpLog(`✅ Quantity đúng: ${cur}`, "green");
      return true;
    }

    if (cur < targetQty && info.plus?.el) {
      info.plus.el.click();
    } else if (cur > targetQty && info.minus?.el) {
      info.minus.el.click();
    } else {
      svpLog(`⚠️ Không click được +/-: cur=${cur} target=${targetQty}`, "yellow");
      break;
    }
    await sleep(120);
  }

  svpLog(`⚠️ Set quantity chưa đạt: ${getTbModalInfo().qty} / cần ${targetQty}`, "yellow");
  return false;
}

// ── Click Tiếp tục ────────────────────────────────────────────────────────────

async function clickTbModalContinue() {
  for (let i = 0; i < 20; i++) {
    const info = getTbModalInfo();
    if (info.cont && !info.cont.disabled) {
      info.cont.el.click();
      svpLog("🖱️ Đã click Tiếp tục", "blue");
      return true;
    }
    await sleep(150);
  }
  svpLog("⚠️ Không tìm thấy nút Tiếp tục trong popup", "yellow");
  return false;
}

// ── Main flow: Ticketbox seat_zone ────────────────────────────────────────────

async function runTicketboxSeatZone(cfg) {
  const aseat = cfg.auto_seat || {};
  const priorityList = aseat.zone_priority || aseat.priority_targets || [];
  const quantity = parseInt(aseat.quantity) || 1;

  svpLog(`🎟️ Ticketbox seat_zone | ưu tiên=${JSON.stringify(priorityList)} | SL=${quantity}`, "blue");

  const info = extractTicketboxInfo();
  svpLog(`🔎 eventId=${info.eventId} | showingId=${info.showingId} | date=${info.date}`, "blue");

  if (!info.eventId || !info.showingId) {
    svpLog("❌ Không tìm được eventId/showingId Ticketbox", "red");
    return false;
  }

  const dates = await resolveDateCandidates(info.eventId, info.showingId, info.date);
  svpLog(`🔎 Date candidates: ${dates.join(", ")}`, "blue");

  let lastErr = null;

  for (const target of priorityList) {
    svpLog(`🎯 Ưu tiên zone: ${target}`, "yellow");

    // Lấy API metadata
    let apiZone = null;
    for (const date of dates) {
      try {
        const showUrl = `${API_TB_ZONE}/event/api/v1/events/showings/${info.showingId}?date=${date}`;
        const seatmapUrl = `${API_TB_ZONE}/event/api/v1/events/showings/${info.showingId}/seatmap`;

        svpLog(`📡 GET showings/${info.showingId}?date=${date}`, "blue");
        const showRes = await tbFetchJson(showUrl);
        if (!showRes.ok) { lastErr = `showings HTTP=${showRes.status}`; continue; }

        svpLog(`📡 GET seatmap/${info.showingId}`, "blue");
        const seatmapRes = await tbFetchJson(seatmapUrl);
        if (!seatmapRes.ok) { lastErr = `seatmap HTTP=${seatmapRes.status}`; continue; }

        const candidates = collectApiZones(showRes.data || {}, seatmapRes.data || {}, target);
        if (!candidates.length) continue;

        const { chosen, soldOut } = chooseBestSalable(candidates);

        if (chosen) {
          apiZone = chosen;
          svpLog(`✅ API match: ${apiZone.name} | sectionId=${apiZone.sectionId} | ticketTypeId=${apiZone.ticketTypeId}`, "green");
          if (soldOut.length) svpLog(`⏭️ Bỏ qua zone hết vé: ${soldOut.map(x => x.name).join(", ")}`, "yellow");
          break;
        }

        // Tất cả hết vé
        lastErr = `target ${target} hết vé theo API`;
        svpLog(`⏭️ ${lastErr}`, "yellow");
        apiZone = null;
        break;
      } catch(e) {
        lastErr = e.message;
        svpLog(`⚠️ API metadata lỗi date=${date}: ${e.message}`, "yellow");
      }
    }

    // Skip nếu API xác định hết vé
    if (apiZone === null && lastErr?.includes("hết vé theo API")) {
      svpLog(`⏭️ Skip target hết vé: ${target}`, "yellow");
      continue;
    }

    // Click Konva zone
    const clicked = await clickZoneKonvaTb(target, apiZone);
    if (!clicked) {
      lastErr = `không click được zone: ${target}`;
      svpLog(`⚠️ ${lastErr}; thử ưu tiên tiếp theo`, "yellow");
      continue;
    }

    // Set quantity
    if (!await setTbModalQuantity(quantity)) {
      svpLog("⚠️ Không set được số lượng. Popup đã mở đúng zone.", "yellow");
      return true; // popup mở đúng, để user tự xử
    }

    // Click Tiếp tục
    if (!await clickTbModalContinue()) {
      svpLog("⚠️ Không click được Tiếp tục. Số lượng đã đúng.", "yellow");
      return true;
    }

    await sleep(800);
    svpLog("✅ Đã chọn zone + số lượng + bấm Tiếp tục. Nếu captcha hiện, kéo tay.", "green");
    return true;
  }

  svpLog(`❌ Không chọn được seat_zone. Lỗi cuối: ${lastErr}`, "red");
  return false;
}