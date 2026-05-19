// src/content/zone_matcher.js
// Match zone/section theo tên ưu tiên người dùng nhập

// ── Zone score ────────────────────────────────────────────────────────────────
// Giống logic Python: VIP không ăn SVIP, match chặt theo token

function zoneScore(target, candidate) {
  const tks = normTokens(target);
  const cks = normTokens(candidate);
  if (!tks.length || !cks.length) return 0;

  const t = tks.join(" ");
  const c = cks.join(" ");
  if (t === c) return 1000;

  if (tks.length === 1) {
    return cks.includes(tks[0]) ? 850 - Math.abs(cks.length - 1) : 0;
  }

  // All tokens phải xuất hiện theo thứ tự
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

// ── Extract zones từ 1Zone API response ──────────────────────────────────────

function* walkObj(obj) {
  if (obj && typeof obj === "object") {
    yield obj;
    for (const v of Object.values(obj)) yield* walkObj(v);
  } else if (Array.isArray(obj)) {
    for (const item of obj) yield* walkObj(item);
  }
}

function extract1ZoneZones(data) {
  const zones = [];
  const seen = new Set();

  function tryItem(item) {
    if (!item || typeof item !== "object") return;
    const name = item.zoneName || item.name || item.title || item.label || item.zone || item.ticketClassName || "";
    const zoneId = item.zoneId || item.referenceId || item.id || item._id || item.zone_id || "";
    const ticketClassId = item.ticketClassId || item.ticket_class_id || item.classId || item.ticketClass || item.PK || "";
    let available = item.countTicketsAvailable ?? item.availableTickets ?? item.available ?? item.quantity ?? item.remaining ?? 0;
    try { available = parseInt(available) || 0; } catch { available = 0; }
    if (!name || !zoneId) return;
    const key = `${zoneId}|${ticketClassId}`;
    if (seen.has(key)) return;
    seen.add(key);
    zones.push({ name: String(name), zoneId: String(zoneId), ticketClassId: String(ticketClassId || ""), available, isCaptchaEnable: !!item.isCaptchaEnable });
  }

  // Duyệt deep walk
  function walk(obj) {
    if (!obj) return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    if (typeof obj === "object") { tryItem(obj); Object.values(obj).forEach(walk); }
  }
  walk(data);
  return zones;
}

// ── Extract sections từ Ticketbox API response ────────────────────────────────

function extractTbSections(data) {
  const sections = [];
  const seen = new Set();

  function tryItem(item) {
    if (!item || typeof item !== "object") return;
    const name = item.name || item.title || item.sectionName || item.label || "";
    const sectionId = item.id || item.sectionId || item._id || "";
    let available = item.availableQuantity ?? item.available ?? item.remaining ?? 0;
    try { available = parseInt(available) || 0; } catch { available = 0; }
    if (!name || !sectionId) return;
    const key = String(sectionId);
    if (seen.has(key)) return;
    seen.add(key);
    sections.push({ name: String(name), sectionId: String(sectionId), available });
  }

  function walk(obj) {
    if (!obj) return;
    if (Array.isArray(obj)) { obj.forEach(walk); return; }
    if (typeof obj === "object") { tryItem(obj); Object.values(obj).forEach(walk); }
  }
  walk(data);
  return sections;
}

// ── Match best zone theo priority list ───────────────────────────────────────

function matchBestZone(zones, priorityList, quantity) {
  for (const wanted of priorityList) {
    let best = null;
    let bestScore = 0;
    for (const z of zones) {
      const avail = parseInt(z.available) || 0;
      if (avail < quantity) continue;
      const score = zoneScore(wanted, z.name || z.sectionName || "");
      if (score > bestScore) { bestScore = score; best = z; }
    }
    if (best) return { zone: best, wantedName: wanted };
  }
  return null;
}
