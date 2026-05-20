// src/content/seat_1zone_zone.js
// 1Zone seat_zone — convert từ seat_selector_1zone_zone.py
// Konva-native: tìm Path theo attrs.zoneId, click thật để frontend tự mở dialog/captcha/token
// KHÔNG POST add-to-cart trực tiếp — chờ frontend tự POST sau khi click Tiếp tục

const API_BASE_1Z_ZONE = "https://prod.1zone.vn/ticketing/api";

// ── Helpers ───────────────────────────────────────────────────────────────────

function norm1ZZone(s) {
  s = String(s || "").trim().toLowerCase();
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/_/g, " ").replace(/[^a-z0-9]+/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function tokens1ZZone(s) {
  return norm1ZZone(s).split(" ").filter(Boolean);
}

// ── Walk object deep ──────────────────────────────────────────────────────────

function* walk1ZZone(obj) {
  if (!obj) return;
  if (Array.isArray(obj)) { for (const x of obj) yield* walk1ZZone(x); return; }
  if (typeof obj === "object") { yield obj; for (const v of Object.values(obj)) yield* walk1ZZone(v); }
}

// ── Extract event info ────────────────────────────────────────────────────────

function extract1ZZoneInfo() {
  const out = { url: location.href, eventId: "", calendarId: "", slug: "" };
  try {
    const m = location.pathname.match(/\/(?:events|booking)\/([^/?]+)/);
    if (m) out.slug = m[1];
  } catch {}
  try {
    out.calendarId = new URL(location.href).searchParams.get("calendarId") || "";
  } catch {}
  try {
    const d = window.__NEXT_DATA__?.props?.pageProps;
    const id = d?.event?.id || d?.eventId || d?.event?.eventId;
    if (id) out.eventId = String(id);
  } catch {}
  try {
    for (const e of performance.getEntriesByType("resource")) {
      const name = e.name;
      if (!out.eventId) {
        const m = name.match(/get-summary-event\/([A-Za-z0-9]+)/) ||
          name.match(/\/event\/([A-Za-z0-9]+)\/tickets/) ||
          name.match(/\/event\/([A-Za-z0-9]+)\/seatmap/) ||
          name.match(/\/event\/([A-Za-z0-9]+)\//);
        if (m) out.eventId = m[1];
      }
      if (!out.calendarId) {
        const m = name.match(/[?&]calendarId=([A-Za-z0-9]+)/);
        if (m) out.calendarId = m[1];
      }
      if (out.eventId && out.calendarId) break;
    }
  } catch {}
  return out;
}

// ── Zones API ─────────────────────────────────────────────────────────────────

async function getZonesApi1Z(eventId, calendarId) {
  const url = `${API_BASE_1Z_ZONE}/v4/ticket-summary/get-summary-event/${eventId}/zones?calendarId=${encodeURIComponent(calendarId)}`;
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json", "x-accept-language": "vi", "Accept-Language": "vi" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`zones API ${res.status}`);
  return res.json();
}

// ── Extract zones từ API response ────────────────────────────────────────────

function extractZones1Z(zonesJson) {
  const zones = [];
  const seen = new Set();

  for (const item of walk1ZZone(zonesJson)) {
    if (!item || typeof item !== "object") continue;
    const name = item.zoneName || item.name || item.title || item.label || item.zone || item.ticketClassName || "";
    const zoneId = item.zoneId || item.referenceId || item.id || item._id || item.zone_id || "";
    const ticketClassId = item.ticketClassId || item.ticket_class_id || item.classId || item.ticketClass || item.PK || "";
    let available = item.countTicketsAvailable ?? item.availableTickets ?? item.available ?? item.quantity ?? item.remaining ?? 0;
    try { available = parseInt(available) || 0; } catch { available = 0; }
    if (!name || !zoneId) continue;
    const key = `${zoneId}|${ticketClassId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    zones.push({
      raw: item,
      name: String(name),
      zoneId: String(zoneId),
      ticketClassId: String(ticketClassId || ""),
      available,
      isCaptchaEnable: !!item.isCaptchaEnable,
    });
  }
  return zones;
}

// ── Zone score + match ────────────────────────────────────────────────────────

function zoneScore1Z(target, candidate) {
  const tks = tokens1ZZone(target);
  const cks = tokens1ZZone(candidate);
  if (!tks.length || !cks.length) return 0;
  const t = tks.join(" "), c = cks.join(" ");
  if (t === c) return 1000;

  if (tks.length === 1) {
    return cks.includes(tks[0]) ? 850 - Math.abs(cks.length - 1) : 0;
  }

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

function matchZone1Z(zones, wantedName, quantity) {
  const candidates = [];
  for (const z of zones) {
    if (parseInt(z.available || 0) < quantity) continue;
    const score = zoneScore1Z(wantedName, z.name || "");
    if (score > 0) candidates.push({ ...z, score });
  }
  candidates.sort((a, b) => b.score - a.score || b.available - a.available);
  return candidates[0] || null;
}

function formatZoneList1Z(zones) {
  return zones.filter(z => z.available > 0).map(z => `${z.name}(${z.available})`).join(", ") || "không có";
}

// ── Dialog detector ───────────────────────────────────────────────────────────

function dialog1ZZoneVisible() {
  const dialogs = Array.from(document.querySelectorAll('div[role="dialog"][data-state="open"], div[role="dialog"]'));
  for (const d of dialogs) {
    const r = d.getBoundingClientRect?.();
    if (!r || r.width < 180 || r.height < 180) continue;
    const txt = String(d.innerText || "");
    const hasAdd = !!d.querySelector('button[data-id="btn-add"]');
    const hasContinue = !!d.querySelector('button[data-id="btn-continue"]');
    if (hasAdd && hasContinue && /Chọn số lượng vé|Tiếp tục/i.test(txt)) return true;
  }
  return false;
}

// ── Konva zone points (qua runInPage) ────────────────────────────────────────

async function konvaZonePoints1Z(zoneId) {
  return runInPage(function(args) {
    const zoneId = args.zoneId;
    function safe(v) { return v === undefined || v === null ? "" : String(v); }
    function rectOf(n) {
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
    function add(out, x, y, mode, debug) {
      if (!isFinite(x) || !isFinite(y)) return;
      const key = Math.round(x) + ":" + Math.round(y);
      if (out._seen[key]) return;
      out._seen[key] = true;
      out.push({ x, y, mode, debug });
    }

    const stage = window.Konva?.stages?.[0];
    if (!stage) return [{ x: -1, y: -1, mode: "NO_KONVA_STAGE", debug: "" }];

    const paths = Array.from(stage.find ? stage.find("Path") : []);
    const target = paths.find(p => safe(p.attrs?.zoneId) === safe(zoneId) && !p.attrs?.disabled);
    if (!target) return [{
      x: -1, y: -1, mode: "NO_ZONE_PATH",
      debug: JSON.stringify(paths.slice(0, 8).map((p, i) => ({
        i, text: p.attrs?.text, zoneId: p.attrs?.zoneId, disabled: p.attrs?.disabled
      }))).slice(0, 1200),
    }];

    const r = rectOf(target);
    if (!r) return [{ x: -1, y: -1, mode: "ZONE_PATH_NO_RECT", debug: JSON.stringify(target.attrs || {}).slice(0, 800) }];

    const attrs = target.attrs || {};
    const container = stage.container?.() || document.querySelector(".konvajs-content") || document.querySelector("canvas");
    const box = container?.getBoundingClientRect?.() || { left: 0, top: 0, width: 0, height: 0 };
    const stageW = Number(stage.width?.() || stage.attrs?.width || box.width || 1);
    const stageH = Number(stage.height?.() || stage.attrs?.height || box.height || 1);
    const sx = box.width && stageW ? box.width / stageW : 1;
    const sy = box.height && stageH ? box.height / stageH : 1;

    const debug = JSON.stringify({
      text: attrs.text, zoneId: attrs.zoneId, ticketClassId: attrs.ticketClassId, disabled: attrs.disabled,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      box: { left: Math.round(box.left||0), top: Math.round(box.top||0), w: Math.round(box.width||0), h: Math.round(box.height||0) },
      stage: { w: Math.round(stageW), h: Math.round(stageH) },
    });

    const out = []; out._seen = {};
    const rels = [
      [0.50, 0.50, "center"], [0.50, 0.42, "upper-center"], [0.50, 0.58, "lower-center"],
      [0.35, 0.50, "left-center"], [0.65, 0.50, "right-center"],
      [0.25, 0.50, "left-safe"], [0.75, 0.50, "right-safe"],
    ];

    // A) SCALED — getClientRect trả stage coords, cần scale vào DOM container
    for (const [rx, ry, m] of rels)
      add(out, box.left + (r.x + r.width * rx) * sx, box.top + (r.y + r.height * ry) * sy, "SCALED_" + m, debug);

    // B) DIRECT fallback
    for (const [rx, ry, m] of rels)
      add(out, r.x + r.width * rx, r.y + r.height * ry, "DIRECT_" + m, debug);

    // C) attrs.x/y fallback
    const ax = Number(attrs.x || 0), ay = Number(attrs.y || 0);
    if (ax || ay) {
      for (const [rx, ry, m] of [[0.5,0.5,"attr-center"],[0.38,0.45,"attr-left-upper"],[0.62,0.45,"attr-right-upper"]]) {
        add(out, box.left + (ax + r.width * rx) * sx, box.top + (ay + r.height * ry) * sy, "ATTR_" + m, debug);
        add(out, ax + r.width * rx, ay + r.height * ry, "ATTR_DIRECT_" + m, debug);
      }
    }

    delete out._seen;
    return out;
  }, { zoneId });
}

// ── Click zone Konva ──────────────────────────────────────────────────────────

async function clickZoneKonva1Z(zone) {
  let points;
  try {
    points = await konvaZonePoints1Z(zone.zoneId);
  } catch(e) {
    svpLog(`❌ Konva evaluate lỗi: ${e.message}`, "red");
    return false;
  }

  if (!points?.length || points[0].x < 0) {
    svpLog(`⚠️ Không tìm thấy Konva Path zone: ${zone.name} | ${points?.[0]?.mode} | ${(points?.[0]?.debug || "").slice(0, 300)}`, "yellow");
    return false;
  }

  svpLog(`🔎 Konva zone: ${zone.name} | zoneId=${zone.zoneId} | candidates=${points.length} | ${(points[0].debug || "").slice(0, 200)}`, "blue");

  const offsets = [[0,0],[5,0],[-5,0],[0,5],[0,-5]];

  for (const p of points.slice(0, 10)) {
    const bx = p.x, by = p.y;
    const hit = elemAt(bx, by);
    svpLog(`🎯 Thử click zone ${zone.name}: mode=${p.mode} point=(${bx.toFixed(1)},${by.toFixed(1)}) hit=${hit}`, "blue");

    for (const [dx, dy] of offsets) {
      await realClick(bx + dx, by + dy);
      for (let i = 0; i < 8; i++) {
        await sleep(100);
        if (dialog1ZZoneVisible()) {
          svpLog(`✅ Popup quantity đã mở: ${zone.name} | point=(${(bx+dx).toFixed(1)},${(by+dy).toFixed(1)})`, "green");
          return true;
        }
      }
    }
  }

  svpLog(`⚠️ Click Konva xong nhưng chưa thấy popup quantity: ${zone.name}`, "yellow");
  return false;
}

// ── UI info (popup dialog) ────────────────────────────────────────────────────

function getUiInfo1Z() {
  const dialogs = Array.from(document.querySelectorAll('div[role="dialog"][data-state="open"], div[role="dialog"]'));
  const root = dialogs.find(d => {
    const r = d.getBoundingClientRect?.();
    return r && r.width > 180 && r.height > 180 && d.querySelector('button[data-id="btn-add"]');
  });

  function center(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r || r.width <= 0 || r.height <= 0) return null;
    const st = window.getComputedStyle(el);
    if (st.visibility === "hidden" || st.display === "none") return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, el, disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true" };
  }

  if (!root) return { dialogVisible: false, qty: null, plus: null, minus: null, pay: null, turnstileLen: 0 };

  const plusEl = root.querySelector('button[data-id="btn-add"]');
  const minusEl = root.querySelector('button[data-id="btn-sub"]');
  const contEl = root.querySelector('button[data-id="btn-continue"]');

  // Đọc quantity từ span số trong cùng hàng với btn-add
  let qty = null;
  try {
    const row = plusEl?.closest(".flex.items-center.gap-2") || plusEl?.parentElement;
    const spans = Array.from(row?.querySelectorAll("span") || []);
    for (const sp of spans) {
      const t = String(sp.innerText || sp.textContent || "").trim();
      if (/^\d+$/.test(t)) { qty = parseInt(t); break; }
    }
  } catch {}
  if (qty === null) {
    const allSpans = Array.from(root.querySelectorAll("span, div, p"))
      .map(e => String(e.innerText || e.textContent || "").trim())
      .filter(t => /^\d{1,2}$/.test(t))
      .map(t => parseInt(t));
    if (allSpans.length) qty = allSpans[0];
  }

  const turnstile = root.querySelector('input[name="cf-turnstile-response"]') ||
    document.querySelector('input[name="cf-turnstile-response"]');
  const turnstileLen = String(turnstile?.value || "").length;

  return { dialogVisible: true, qty, plus: center(plusEl), minus: center(minusEl), pay: center(contEl), turnstileLen };
}

// ── Set quantity ──────────────────────────────────────────────────────────────

async function setQuantity1Z(quantity) {
  quantity = Math.max(1, quantity);

  // Chờ dialog visible + plus button
  for (let i = 0; i < 40; i++) {
    const info = getUiInfo1Z();
    if (info.dialogVisible && info.plus) break;
    await sleep(100);
  }

  for (let attempt = 0; attempt < 40; attempt++) {
    const info = getUiInfo1Z();
    if (!info.dialogVisible) return false;
    const cur = info.qty;
    if (cur == null) { svpLog("⚠️ Không đọc được số lượng trong popup", "yellow"); return false; }
    if (cur === quantity) { svpLog(`✅ Quantity đúng: ${cur}`, "green"); return true; }

    if (cur < quantity) {
      if (!info.plus || info.plus.disabled) { svpLog(`⚠️ Không bấm được nút +. Hiện=${cur}, cần=${quantity}`, "yellow"); return false; }
      info.plus.el.click();
    } else {
      if (!info.minus || info.minus.disabled) { svpLog(`⚠️ Không bấm được nút -. Hiện=${cur}, cần=${quantity}`, "yellow"); return false; }
      info.minus.el.click();
    }
    await sleep(120);
  }

  const info = getUiInfo1Z();
  svpLog(`⚠️ Set quantity chưa đạt. Hiện=${info.qty}, cần=${quantity}`, "yellow");
  return false;
}

// ── Wait Turnstile ────────────────────────────────────────────────────────────

async function waitTurnstile1Z(timeoutMs = 8000) {
  const start = Date.now();
  let lastLen = 0;
  while (Date.now() - start < timeoutMs) {
    const info = getUiInfo1Z();
    lastLen = info.turnstileLen || 0;
    if (lastLen > 120) {
      svpLog(`✅ Turnstile token ready: len=${lastLen}`, "green");
      return true;
    }
    await sleep(200);
  }
  svpLog(`⚠️ Turnstile token chưa sẵn sàng: len=${lastLen}. Vẫn thử bấm tiếp tục.`, "yellow");
  return false;
}

// ── Click Tiếp tục và chờ add-to-cart response ───────────────────────────────

async function clickPayAndWait1Z(calendarId) {
  await waitTurnstile1Z(8000);

  const info = getUiInfo1Z();
  if (!info.pay) {
    svpLog("⚠️ Không tìm thấy nút Tiếp tục trong popup", "yellow");
    return true; // popup đã mở, để user tự xử
  }

  svpLog(`🖱️ Click button: Tiếp tục`, "blue");

  // Intercept add-to-cart response bằng XHR/fetch intercept
  let orderId = null;
  const origFetch = window.fetch;
  const fetchPromise = new Promise(resolve => {
    const timeout = setTimeout(() => resolve(null), 18000);
    window.fetch = async function(...args) {
      const res = await origFetch.apply(this, args);
      const url = String(args[0] || "");
      if (url.includes("/ticketing/api/v3/order/add-to-cart") ||
          url.includes("/order/add-to-cart")) {
        try {
          const clone = res.clone();
          const data = await clone.json();
          // Tìm orderId
          function findOrderId(obj) {
            if (!obj || typeof obj !== "object") return "";
            for (const [k, v] of Object.entries(obj)) {
              if (["orderId", "id", "_id"].includes(k) && v && String(v) !== "0") return String(v);
              const sub = findOrderId(v);
              if (sub) return sub;
            }
            return "";
          }
          orderId = findOrderId(data);
          clearTimeout(timeout);
          resolve({ status: res.status, orderId });
        } catch {}
      }
      return res;
    };
  });

  info.pay.el.click();

  // Chờ response
  const result = await Promise.race([
    fetchPromise,
    sleep(18000).then(() => null),
  ]);

  // Restore fetch
  window.fetch = origFetch;

  if (!result) {
    svpLog("⚠️ Không bắt được response add-to-cart sau khi bấm", "yellow");
    return true;
  }

  if (result.status === 200 || result.status === 201) {
    svpLog(`✅ Frontend add-to-cart OK. orderId=${result.orderId || "unknown"}`, "green");
    if (result.orderId) {
      await sleep(500);
      svpLog("➡️ Chuyển sang trang checkout/form...", "blue");
      location.href = `https://ticket.1zone.vn/checkout?orderId=${encodeURIComponent(result.orderId)}&calendarId=${encodeURIComponent(calendarId)}`;
      return true;
    }
    return true;
  }

  svpLog(`⚠️ Frontend add-to-cart HTTP=${result.status}`, "yellow");
  return false;
}

// ── Main flow: 1Zone seat_zone ────────────────────────────────────────────────

async function run1ZoneSeatZone(cfg) {
  const aseat = cfg.auto_seat || {};
  const priorities = (aseat.zone_priority || aseat.priority_targets || []).map(p => String(p).trim()).filter(Boolean);
  const quantity = Math.max(1, parseInt(aseat.quantity) || 1);

  if (!priorities.length) {
    svpLog("❌ Chưa nhập khu ưu tiên cho 1Zone seat_zone", "red");
    return false;
  }

  svpLog(`🎟️ 1Zone seat_zone KONVA_NATIVE | ưu tiên=${JSON.stringify(priorities)} | SL=${quantity}`, "yellow");

  const info = extract1ZZoneInfo();
  svpLog(`🔎 eventId=${info.eventId} | calendarId=${info.calendarId}`, "blue");

  if (!info.eventId || !info.calendarId) {
    svpLog(`❌ Không lấy được eventId/calendarId`, "red");
    return false;
  }

  // GET zones API
  svpLog("📡 GET zones API...", "blue");
  let zonesData;
  try {
    zonesData = await getZonesApi1Z(info.eventId, info.calendarId);
  } catch(e) {
    svpLog(`❌ Zones API lỗi: ${e.message}`, "red");
    return false;
  }

  const zones = extractZones1Z(zonesData);
  if (!zones.length) {
    svpLog("❌ Không parse được danh sách zone từ API", "red");
    return false;
  }

  svpLog(`📋 Zone còn vé: ${formatZoneList1Z(zones)}`, "blue");

  let lastErr = null;
  for (let idx = 0; idx < priorities.length; idx++) {
    const wanted = priorities[idx];
    svpLog(`🎯 Thử zone ưu tiên ${idx+1}: ${wanted}`, "yellow");

    const zone = matchZone1Z(zones, wanted, quantity);
    if (!zone) {
      lastErr = `không tìm thấy hoặc không đủ vé zone: ${wanted}`;
      svpLog(`⚠️ ${lastErr}`, "yellow");
      continue;
    }

    svpLog(`🧭 Match zone: ${zone.name} | zoneId=${zone.zoneId} | ticketClassId=${zone.ticketClassId || "unknown"} | còn=${zone.available} | SL=${quantity}`, "green");

    // Click Konva
    if (!await clickZoneKonva1Z(zone)) {
      lastErr = `không click được Konva zone: ${zone.name}`;
      svpLog(`⚠️ ${lastErr}; thử ưu tiên tiếp theo nếu có`, "yellow");
      continue;
    }

    // Set quantity
    if (!await setQuantity1Z(quantity)) {
      svpLog("⚠️ Đã mở đúng zone nhưng không set được số lượng. Dừng để tránh chọn sai.", "yellow");
      return true;
    }

    // Click Tiếp tục + chờ add-to-cart
    return await clickPayAndWait1Z(info.calendarId);
  }

  svpLog(`❌ Không chọn được 1Zone seat_zone. Lỗi cuối: ${lastErr}`, "red");
  return false;
}