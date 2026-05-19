// src/content/seat_1zone_zone.js
// 1Zone seat_zone — Konva-native flow
// Giữ nguyên toàn bộ logic đã xác nhận hoạt động trong Python

// ── Dialog checker ────────────────────────────────────────────────────────────

function dialog1ZoneVisible() {
  const dialogs = Array.from(document.querySelectorAll(
    'div[role="dialog"][data-state="open"], div[role="dialog"]'
  ));
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

// ── Đọc UI info từ dialog ────────────────────────────────────────────────────

function get1ZoneDialogInfo() {
  const dialogs = Array.from(document.querySelectorAll(
    'div[role="dialog"][data-state="open"], div[role="dialog"]'
  ));
  const root = dialogs.find(d => {
    const r = d.getBoundingClientRect?.();
    return r && r.width > 180 && r.height > 180 && d.querySelector('button[data-id="btn-add"]');
  });
  if (!root) return null;

  function center(el) {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (!r || r.width <= 0) return null;
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, el };
  }

  const plusBtn = root.querySelector('button[data-id="btn-add"]');
  const contBtn = root.querySelector('button[data-id="btn-continue"]');
  const minusBtn = root.querySelector('button[data-id="btn-sub"]');

  // Đọc quantity — span nằm giữa btn-sub và btn-add
  // DOM thật: <span class="w-10 h-10 rounded-xl bg-(--event-border,...)">1</span>
  let qty = 1;
  try {
    // Tìm span chỉ chứa số thuần, không có children, nằm trong vùng quantity control
    const allSpans = Array.from(root.querySelectorAll("span"));
    const qtySpan = allSpans.find(s =>
      s.children.length === 0 && /^\s*\d+\s*$/.test(s.textContent) &&
      (s.className.includes("w-10") || s.className.includes("rounded-xl"))
    );
    if (qtySpan) qty = parseInt(qtySpan.textContent.trim()) || 1;
  } catch {}

  // Turnstile token
  let turnstileLen = 0;
  try {
    const inp = root.querySelector('input[name="cf-turnstile-response"]');
    turnstileLen = (inp?.value || "").length;
  } catch {}

  return {
    dialogVisible: true,
    qty,
    plus: center(plusBtn),
    minus: center(minusBtn),
    pay: center(contBtn),
    turnstileLen,
  };
}

// ── Set quantity trong dialog ─────────────────────────────────────────────────

async function set1ZoneQuantity(targetQty) {
  // Detect step size
  let stepSize = 1;
  const infoInit = get1ZoneDialogInfo();
  if (!infoInit || !infoInit.dialogVisible) return false;

  const qtyBefore = infoInit.qty;
  if (infoInit.plus?.el) {
    infoInit.plus.el.click();
    await sleep(150); // detect step size chờ ít hơn
    const infoAfter = get1ZoneDialogInfo();
    if (infoAfter) {
      stepSize = Math.max(1, infoAfter.qty - qtyBefore);
      if (infoAfter.qty !== qtyBefore && infoAfter.minus?.el) {
        infoAfter.minus.el.click();
        await sleep(150);
      }
    }
  }

  svpLog(`📐 Step size: ${stepSize}`, "blue");

  // Tìm target gần nhất đạt được
  const startQty = get1ZoneDialogInfo()?.qty || 1;
  let achievableTarget = targetQty;
  if (stepSize > 1) {
    const offset = (targetQty - startQty) % stepSize;
    if (offset !== 0) {
      achievableTarget = targetQty + (stepSize - offset);
      svpLog(`⚠️ Target ${targetQty} không đạt được với step=${stepSize}, dùng ${achievableTarget}`, "yellow");
    }
  }

  // Set quantity bằng .click() trực tiếp trên element — React nhận được
  for (let attempt = 0; attempt < 30; attempt++) {
    const info = get1ZoneDialogInfo();
    if (!info || !info.dialogVisible) return false;

    if (info.qty === achievableTarget) {
      svpLog(`✅ Quantity đúng: ${info.qty}`, "green");
      return true;
    }

    svpLog(`🔢 Quantity: ${info.qty} → target: ${achievableTarget}`, "blue");

    if (info.qty < achievableTarget && info.plus?.el) {
      info.plus.el.click();
    } else if (info.qty > achievableTarget && info.minus?.el) {
      info.minus.el.click();
    } else {
      svpLog(`⚠️ Không click được nút`, "yellow");
      break;
    }
    await sleep(80);
  }
  return false;
}

// ── Chờ Turnstile token ──────────────────────────────────────────────────────

async function waitTurnstile(timeoutMs = 10000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const info = get1ZoneDialogInfo();
    if (info && info.turnstileLen > 100) {
      svpLog(`✅ Turnstile token ready: len=${info.turnstileLen}`, "green");
      return true;
    }
    await sleep(200);
  }
  svpLog("⚠️ Timeout chờ Turnstile token", "yellow");
  return false;
}

// ── Main flow: 1Zone seat_zone ───────────────────────────────────────────────

async function run1ZoneSeatZone(cfg) {
  const aseat = cfg.auto_seat || {};
  const priorityList = aseat.zone_priority || aseat.priority_targets || [];
  const quantity = parseInt(aseat.quantity) || 1;

  svpLog(`🎟️ 1Zone seat_zone | ưu tiên=${JSON.stringify(priorityList)} | SL=${quantity}`, "blue");

  // 1. Lấy eventId + calendarId
  const info = extract1ZoneInfo();
  svpLog(`🔎 eventId=${info.eventId} | calendarId=${info.calendarId}`, "blue");

  if (!info.eventId || !info.calendarId) {
    svpLog("❌ Không tìm được eventId / calendarId. Hãy vào đúng trang booking.", "red");
    return false;
  }

  // 2. GET zones API
  svpLog("📡 GET zones API...", "blue");
  let zonesData;
  try {
    zonesData = await api1zoneGetZones(info.eventId, info.calendarId);
  } catch (e) {
    svpLog(`❌ Zones API lỗi: ${e.message}`, "red");
    return false;
  }

  const zones = extract1ZoneZones(zonesData);
  const available = zones.filter(z => z.available > 0);
  svpLog(`📋 Zone còn vé: ${available.map(z => `${z.name} (${z.available})`).join(", ")}`, "blue");

  if (!available.length) {
    svpLog("⚠️ Không có zone nào còn vé.", "yellow");
    return false;
  }

  // 3. Match zone theo priority
  const match = matchBestZone(available, priorityList, quantity);
  if (!match) {
    svpLog(`⚠️ Không match được zone nào trong priority: ${JSON.stringify(priorityList)}`, "yellow");
    return false;
  }

  const zone = match.zone;
  svpLog(`🧭 Match zone: ${zone.name} | zoneId=${zone.zoneId} | còn=${zone.available} | SL=${quantity}`, "green");

  // 4. Chờ Konva load xong trong page context (fix isolated world)
  const konvaReady = await waitForKonva(15000);
  if (!konvaReady) return false;

  // 5. Click Konva zone
  const clicked = await konvaClickZone("zoneId", zone.zoneId, zone.name, dialog1ZoneVisible);
  if (!clicked) return false;

  // 5. Set quantity
  const qtyOk = await set1ZoneQuantity(quantity);
  if (!qtyOk) svpLog(`⚠️ Không set được đúng quantity ${quantity}`, "yellow");

  // 6. Chờ Turnstile
  await waitTurnstile(12000);

  // 7. Click Tiếp tục
  const info2 = get1ZoneDialogInfo();
  if (!info2 || !info2.pay) {
    svpLog("❌ Không tìm thấy nút Tiếp tục", "red");
    return false;
  }
  svpLog("🖱️ Click Tiếp tục", "blue");
  await realClick(info2.pay.x, info2.pay.y);

  // 8. Chờ chuyển trang checkout
  await sleep(1500);
  svpLog("✅ Đã click Tiếp tục — chờ checkout...", "green");
  return true;
}