// src/platforms/ctiket/seat_zone.js
// Ctiket — GA seatmap theo zone (ticket_category), không có seatmap ghế cụ thể.
// Flow đơn giản hơn 1Zone/Ticketbox: không cần click Konva/DOM, chỉ gọi API thuần:
//   1. GET /tix/public/events/v2/{eventId}  -> list ticket_categories (zone) + for_sale
//   2. GET /sessions/whoami?tokenize_as=jwt -> JWT auth (cookie Google OAuth session)
//   3. GET /tix/private/booking/events/{eventId}/waiting-room/enter -> booking_token
//   4. GET /tix/private/booking/events/{eventId}/quiz -> check quiz_required
//   5. POST /tix/private/booking/events/{eventId}/booking -> dat ve, tra order public_id

const CTIKET_API_BASE = "https://cticket.vn";

// -- Helpers chuan hoa ten zone (giong pattern Ticketbox/1Zone) --

function normCk(s) {
  s = String(s || "").trim().toLowerCase();
  s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  s = s.replace(/_/g, " ").replace(/[^a-z0-9]+/g, " ");
  return s.replace(/\s+/g, " ").trim();
}

function tokensCk(s) {
  return normCk(s).split(" ").filter(Boolean);
}

function zoneScoreCk(target, candidate) {
  const tks = tokensCk(target);
  const cks = tokensCk(candidate);
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

// -- Tu detect eventId/occurrenceId tu URL tab dang mo --
// URL pattern: https://cticket.vn/buy/{eventId}?ocid={occurrenceId}&entryCode=&step=2
// (giong cach Ticketbox tu lay showingId tu /events/{id}/bookings/{id})

function extractCtiketInfo() {
  const out = { url: location.href, eventId: null, occurrenceId: null };

  try {
    const m = location.pathname.match(/\/buy\/([a-zA-Z0-9]+)/);
    if (m) out.eventId = m[1];
  } catch {}

  try {
    out.occurrenceId = new URL(location.href).searchParams.get("ocid") || null;
  } catch {}

  return out;
}

async function getCtiketEventInfo(eventId) {
  const res = await fetch(`${CTIKET_API_BASE}/tix/public/events/v2/${encodeURIComponent(eventId)}`, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) throw new Error(`event info API ${res.status}`);
  return res.json();
}

function extractZonesCk(eventInfo) {
  const cats = eventInfo?.ticket_categories || [];
  return cats.map(c => ({
    id: c.id,
    name: c.name || c.zone || "Khu vuc",
    price: c.price,
    maxBuy: c.max_buy,
    forSale: !!c.for_sale,
    ticketType: c.ticket_type || "ga",
  }));
}

function matchZoneCk(zones, wantedName) {
  let best = null, bestScore = 0;
  for (const z of zones) {
    if (!z.forSale) continue;
    const score = zoneScoreCk(wantedName, z.name);
    if (score > bestScore) { bestScore = score; best = z; }
  }
  return bestScore > 0 ? best : null;
}

async function ctiketWhoami() {
  const res = await fetch(`${CTIKET_API_BASE}/sessions/whoami?tokenize_as=jwt`, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json, text/plain, */*" },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return null;
  const data = await res.json();
  return data?.tokenized || null;
}

const CTIKET_RECAPTCHA_SITE_KEY = "6Leg798rAAAAAOQwZrZvhwtxUCvmXkNk3bGbexv0";

// grecaptcha duoc trang Ctiket tu load san - chi can goi lai execute() de lay token,
// khong can tu dung widget captcha rieng (khac han slide/rotate cua Ticketbox).
function getCtiketCaptchaToken() {
  return new Promise((resolve, reject) => {
    if (typeof grecaptcha === "undefined") {
      reject(new Error("grecaptcha chua load tren trang nay"));
      return;
    }
    grecaptcha.ready(() => {
      grecaptcha.execute(CTIKET_RECAPTCHA_SITE_KEY, { action: "submit" })
        .then(resolve)
        .catch(reject);
    });
  });
}

async function ctiketEnterWaitingRoom(eventId, jwt, captchaToken) {
  const res = await fetch(`${CTIKET_API_BASE}/tix/private/booking/events/${eventId}/waiting-room/enter`, {
    method: "GET",
    credentials: "include",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${jwt}`,
      "x-captcha-token": captchaToken,
    },
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, data };
}

async function ctiketCheckQuiz(eventId, jwt, bookingToken) {
  const res = await fetch(`${CTIKET_API_BASE}/tix/private/booking/events/${eventId}/quiz`, {
    method: "GET",
    credentials: "include",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${jwt}`,
      "booking-token": bookingToken,
    },
    signal: AbortSignal.timeout(6000),
  });
  if (!res.ok) return { quiz_required: false };
  return res.json();
}

// Giu booking_token song trong luc dang chon zone/dien thong tin (~5s/lan).
// Server tu thu hoi token sau ~7 phut neu khong co keep-alive (xem flow capture).
async function ctiketKeepAlive(eventId, jwt, bookingToken) {
  const res = await fetch(`${CTIKET_API_BASE}/tix/private/booking/events/${eventId}/keep-alive`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwt}`,
      "booking-token": bookingToken,
      "Origin": "https://cticket.vn",
    },
    body: "{}",
    signal: AbortSignal.timeout(6000),
  });
  return res.ok;
}

let _ckKeepAliveTimer = null;

function startCtiketKeepAlive(eventId, jwt, bookingToken, intervalMs = 5000) {
  stopCtiketKeepAlive();
  _ckKeepAliveTimer = setInterval(async () => {
    try {
      const ok = await ctiketKeepAlive(eventId, jwt, bookingToken);
      if (!ok) svpLog("Ctiket: keep-alive that bai (token co the het han)", "yellow");
    } catch (e) {
      svpLog(`Ctiket: keep-alive loi - ${e.message}`, "yellow");
    }
  }, intervalMs);
}

function stopCtiketKeepAlive() {
  if (_ckKeepAliveTimer) {
    clearInterval(_ckKeepAliveTimer);
    _ckKeepAliveTimer = null;
  }
}

async function ctiketSubmitBooking(eventId, jwt, bookingToken, { items, claimerInfo, occurrenceId, paymentMethod }) {
  const payload = {
    payment_method: paymentMethod || "BANK_TRANSFER",
    billing_info: { export_bill: false },
    items,
    claimer_info: claimerInfo,
    delivery_info: { delivery_method: "email" },
    occurrence_id: occurrenceId,
    attendees_info: [],
  };

  const res = await fetch(`${CTIKET_API_BASE}/tix/private/booking/events/${eventId}/booking`, {
    method: "POST",
    credentials: "include",
    headers: {
      "Accept": "application/json",
      "Content-Type": "application/json",
      "Authorization": `Bearer ${jwt}`,
      "booking-token": bookingToken,
      "Origin": "https://cticket.vn",
    },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(10000),
  });
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { ok: res.ok, status: res.status, data, raw: text };
}

async function runCtiketSeatZone(cfg) {
  const BOOKING_TOKEN_KEY = "__svp_ck_booking_token__";

  const info = extractCtiketInfo();
  const eventId = info.eventId;
  const occurrenceId = info.occurrenceId;
  const claimerInfo = {
    full_name: cfg?.name,
    email: cfg?.email,
    phone_number: cfg?.phone,
  };

  if (!eventId || !occurrenceId) {
    svpLog(`Ctiket: khong detect duoc eventId/occurrenceId tu URL (${info.url})`, "red");
    return false;
  }
  if (!claimerInfo?.full_name || !claimerInfo?.email || !claimerInfo?.phone_number) {
    svpLog("Ctiket: thieu claimer_info (ho ten/email/sdt) trong cfg", "red");
    return false;
  }

  // Doc booking_token + jwt da duoc queue_watcher.js luu san qua background
  let tokenData = null;
  try {
    const resp = await chrome.runtime.sendMessage({ type: "SVP_GET_CK_TOKEN" });
    tokenData = resp?.payload || null;
  } catch (e) {
    svpLog(`Ctiket: loi doc token tu background (${e.message})`, "red");
    return false;
  }

  if (!tokenData || tokenData.eventId !== eventId) {
    svpLog("Ctiket: chua co booking_token cho event nay - can qua trang queue truoc (queue_watcher.js se tu luu)", "red");
    return false;
  }
  if (Date.now() >= tokenData.expAt) {
    svpLog("Ctiket: booking_token da het han (~7 phut) - quay lai trang queue de lay token moi", "red");
    return false;
  }
  const { jwt, bookingToken } = tokenData;

  // Bat dau keep-alive ngay khi co token hop le - giu song trong luc
  // goi API zone info, check quiz, submit booking ben duoi.
  startCtiketKeepAlive(eventId, jwt, bookingToken);

  try {
    return await _runCtiketSeatZoneInner(cfg, { eventId, occurrenceId, jwt, bookingToken });
  } finally {
    stopCtiketKeepAlive();
  }
}

async function _runCtiketSeatZoneInner(cfg, { eventId, occurrenceId, jwt, bookingToken }) {
  const aseat = cfg?.auto_seat?.["ctiket"] || cfg?.auto_seat || {};
  const priorities = aseat.zone_priority || aseat.priority_targets || cfg?.zone_priority || [];
  const quantity = aseat.quantity || cfg?.quantity || 1;
  const claimerInfo = {
    full_name: cfg?.name,
    email: cfg?.email,
    phone_number: cfg?.phone,
  };
  let eventInfo;
  try {
    eventInfo = await getCtiketEventInfo(eventId);
  } catch (e) {
    svpLog(`Ctiket: loi lay event info - ${e.message}`, "red");
    return false;
  }
  const zones = extractZonesCk(eventInfo);
  if (!zones.length) {
    svpLog("Ctiket: event khong co ticket_categories nao", "yellow");
    return false;
  }

  let matched = null;
  for (const wanted of priorities) {
    matched = matchZoneCk(zones, wanted);
    if (matched) { svpLog(`Ctiket: match zone "${wanted}" -> "${matched.name}"`, "green"); break; }
  }
  if (!matched) {
    svpLog("Ctiket: chua co zone nao trong priority list con ban", "yellow");
    return false;
  }

  const quiz = await ctiketCheckQuiz(eventId, jwt, bookingToken);
  if (quiz?.quiz_required) {
    svpLog("Ctiket: event nay yeu cau quiz truoc khi dat ve - chua ho tro tu dong", "yellow");
    return false;
  }

  const items = [{
    ticket_category_id: matched.id,
    quantity,
    desire_count: quantity,
    ticket_type: matched.ticketType,
  }];

  const result = await ctiketSubmitBooking(eventId, jwt, bookingToken, {
    items, claimerInfo, occurrenceId,
    paymentMethod: cfg?.ctiket?.paymentMethod,
  });

  if (!result.ok || !result.data?.public_id) {
    svpLog(`Ctiket: booking that bai (status=${result.status}) - ${result.raw?.slice(0, 200)}`, "red");
    return false;
  }

  svpLog(`Ctiket: dat ve thanh cong! Order #${result.data.public_id} - ${result.data.amount}d`, "green");

  try {
    location.href = result.data.invoice_url || `https://cticket.vn/checkout/${result.data.public_id}`;
  } catch {}

  return true;
}