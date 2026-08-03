// ============================================================================
// TEST THU CONG TUNG API CTIKET - paste vao Console (F12) tren tab cticket.vn
// dang o trang /buy/{eventId}?ocid=...
//
// Chay TUNG BUOC mot, kiem tra ket qua truoc khi sang buoc tiep theo.
// KHONG dong tab giua cac buoc (can giu cookie session + booking_token).
// ============================================================================

// ---- BUOC 0: HOOK QUAN SAT - bat popup/toast/modal + network lien quan stock ----
// Paste va chay CAI NAY DAU TIEN, truoc khi bam + chon ve.
// Muc dich: xem THUC TE khi het ve giua chung thi web co hien thong bao/popup gi khong,
// va API tra ve response nhu the nao (de code seat_zone.js bat dung, thay vi doan mo hinh).
function testWatchSoldOut() {
  console.log("%c[WATCH] Dang theo doi DOM popup/toast + network...", "color: orange; font-weight: bold");

  // 1) Bat moi node moi them vao DOM trong luc chay (toast/modal/snackbar/alert)
  const KEYWORDS = /toast|modal|dialog|snackbar|notif|alert|swal|popup|het.?v[eé]|kh[oô]ng.?c[oò]n|s[oó]ld.?out/i;
  const mo = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const node of m.addedNodes) {
        if (node.nodeType !== 1) continue;
        const cls = node.className ? String(node.className) : "";
        const role = node.getAttribute ? node.getAttribute("role") : "";
        const txt = (node.textContent || "").trim().slice(0, 200);
        if (KEYWORDS.test(cls) || KEYWORDS.test(role || "") || KEYWORDS.test(txt)) {
          console.log("%c[WATCH][DOM MOI] class=%s role=%s", "color: red; font-weight: bold", cls, role);
          console.log("  noi dung:", txt);
          console.log("  element:", node);
        }
      }
    }
  });
  mo.observe(document.body, { childList: true, subtree: true });
  window.__test_stopWatch = () => { mo.disconnect(); console.log("[WATCH] da dung theo doi DOM"); };

  // 2) Hook fetch() de log request/response lien quan zone/ticket/stock/cart
  if (!window.__test_origFetch) {
    window.__test_origFetch = window.fetch;
    window.fetch = async function (...args) {
      const url = typeof args[0] === "string" ? args[0] : args[0]?.url || "";
      const res = await window.__test_origFetch.apply(this, args);
      if (/zone|ticket|cart|reserv|stock|quantity|book/i.test(url)) {
        const clone = res.clone();
        clone.text().then((body) => {
          console.log(
            `%c[WATCH][FETCH] ${res.status} ${url}`,
            res.ok ? "color: green" : "color: red; font-weight: bold"
          );
          try { console.log("  body:", JSON.parse(body)); } catch { console.log("  body(raw):", body.slice(0, 500)); }
        });
      }
      return res;
    };
    console.log("[WATCH] da hook fetch()");
  }
}
// Chay: testWatchSoldOut()
// Sau do bam + lien tuc vao zone gan het ve (hoac dua 2 tab tranh nhau 1 ve cuoi),
// quan sat console: co [DOM MOI] nao xuat hien khong, va [FETCH] response tra ve gi
// luc zone vua het (status code? message field? co field con lai bao nhieu ve khong?).
// Goi window.__test_stopWatch() de tat MutationObserver khi xong.


// ---- BUOC 0.5: QUET STOCK THEO ZONE tu API public - tim zone nao dang it ve ----
// Dung khi dang o trang /event/{slug} (KHONG can /buy/, khong can dang nhap).
// Muc dich: khoi phai mo tung event bang mat de doan zone nao gan het,
// API public da co san du lieu nay (hunt.js dang poll API nay roi, chi la chua parse ra so luong).
async function testScanZoneStock(slugOverride) {
  const slug = slugOverride || (location.pathname.match(/\/event\/([^/?#]+)/) || [])[1];
  if (!slug) {
    console.error("Khong lay duoc slug. Dung o trang /event/{slug}, hoac truyen tay: testScanZoneStock('slug-cua-event')");
    return;
  }
  const url = `https://cticket.vn/tix/public/events/v2/${slug}`;
  const res = await fetch(url, { credentials: "include", headers: { Accept: "application/json" } });
  console.log("STATUS:", res.status, "| URL:", url);
  const data = await res.json();
  window.__test_lastEventData = data; // luu lai de tu inspect them neu can

  // Quet de quy toan bo JSON, tim moi key co ve la "so luong con lai"
  const QTY_KEYS = /remain|available|left|stock|sold.?out|quantity|slots?$/i;
  const NAME_KEYS = /^name$|zone.?name|ticket.?name|title$/i;
  const found = [];

  function walk(obj, path, nearestName) {
    if (!obj || typeof obj !== "object") return;
    let nameHere = nearestName;
    if (Array.isArray(obj)) {
      obj.forEach((item, i) => walk(item, `${path}[${i}]`, nameHere));
      return;
    }
    for (const k of Object.keys(obj)) {
      if (NAME_KEYS.test(k) && typeof obj[k] === "string") nameHere = obj[k];
    }
    for (const k of Object.keys(obj)) {
      const v = obj[k];
      if (QTY_KEYS.test(k) && (typeof v === "number" || typeof v === "boolean")) {
        found.push({ zone: nameHere || "(khong ro ten)", field: k, value: v, path: `${path}.${k}` });
      } else if (v && typeof v === "object") {
        walk(v, `${path}.${k}`, nameHere);
      }
    }
  }
  walk(data, "root", null);

  if (found.length === 0) {
    console.warn("Khong tim thay field so luong nao qua regex. In full JSON de tu doc tay:");
    console.log(data);
  } else {
    console.log("%cCac field so-luong tim duoc (sap theo value tang dan):", "color: green; font-weight: bold");
    console.table(found.sort((a, b) => (typeof a.value === "number" ? a.value : 0) - (typeof b.value === "number" ? b.value : 0)));
  }
  return found;
}
// Chay: await testScanZoneStock()  (dang o trang /event/{slug})
// Hoac quet nhieu event lien tiep: for (const s of ["slug1","slug2"]) { await testScanZoneStock(s); }
// Zone nao value nho (1-2) la ung vien de test scenario het ve / gan het.


// ---- BUOC 1: Test whoami (lay JWT) ----
async function testWhoami() {
  const res = await fetch("https://cticket.vn/sessions/whoami?tokenize_as=jwt", {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json, text/plain, */*" },
  });
  console.log("STATUS:", res.status);
  const data = await res.json();
  console.log("JWT (tokenized):", data.tokenized ? data.tokenized.slice(0, 50) + "..." : "KHONG CO - chua login?");
  window.__test_jwt = data.tokenized; // luu lai de dung buoc sau
  return data;
}
// Chay: await testWhoami()


// ---- BUOC 2: Test detect eventId/occurrenceId tu URL ----
function testExtractInfo() {
  const m = location.pathname.match(/\/buy\/([a-zA-Z0-9]+)/);
  const eventId = m ? m[1] : null;
  const occurrenceId = new URL(location.href).searchParams.get("ocid");
  console.log("eventId:", eventId);
  console.log("occurrenceId:", occurrenceId);
  window.__test_eventId = eventId;
  window.__test_occurrenceId = occurrenceId;
  return { eventId, occurrenceId };
}
// Chay: testExtractInfo()


// ---- BUOC 2.5: Lay reCAPTCHA v3 invisible token (site key tu trang Ctiket) ----
// grecaptcha da duoc load san boi chinh trang Ctiket, chi can goi lai execute()
const CTIKET_RECAPTCHA_SITE_KEY = "6Leg798rAAAAAOQwZrZvhwtxUCvmXkNk3bGbexv0";

function testGetCaptchaToken() {
  return new Promise((resolve, reject) => {
    if (typeof grecaptcha === "undefined") {
      reject(new Error("grecaptcha chua duoc load tren trang nay - thu reload lai trang /buy/..."));
      return;
    }
    grecaptcha.ready(() => {
      grecaptcha.execute(CTIKET_RECAPTCHA_SITE_KEY, { action: "submit" })
        .then(token => {
          console.log("captcha token:", token.slice(0, 40) + "...");
          window.__test_captchaToken = token;
          resolve(token);
        })
        .catch(reject);
    });
  });
}
// Chay: await testGetCaptchaToken()


// ---- BUOC 3: Test enter waiting-room (lay booking_token) ----
async function testEnterWaitingRoom() {
  if (!window.__test_jwt || !window.__test_eventId) { console.error("Chạy testWhoami() và testExtractInfo() trước!"); return; }
  if (!window.__test_captchaToken) { console.error("Chạy await testGetCaptchaToken() trước!"); return; }
  const res = await fetch(`https://cticket.vn/tix/private/booking/events/${window.__test_eventId}/waiting-room/enter`, {
    method: "GET", credentials: "include",
    headers: {
      "Accept": "application/json",
      "Authorization": `Bearer ${window.__test_jwt}`,
      "x-captcha-token": window.__test_captchaToken,
    },
  });
  console.log("STATUS:", res.status);
  const text = await res.text();
  console.log("BODY:", text);
  try {
    const data = JSON.parse(text);
    window.__test_bookingToken = data.booking_token;
    console.log("booking_token:", data.booking_token ? data.booking_token.slice(0, 40) + "..." : "KHONG CO");
    console.log("people_ahead:", data.people_ahead);
  } catch {}
}
// Chay: await testEnterWaitingRoom()


// ---- BUOC 4: Test check quiz ----
async function testCheckQuiz() {
  if (!window.__test_jwt || !window.__test_bookingToken) {
    console.error("Chay cac buoc truoc trc!");
    return;
  }
  const res = await fetch(
    `https://cticket.vn/tix/private/booking/events/${window.__test_eventId}/quiz`,
    {
      method: "GET",
      credentials: "include",
      headers: {
        "Accept": "application/json",
        "Authorization": `Bearer ${window.__test_jwt}`,
        "booking-token": window.__test_bookingToken,
      },
    }
  );
  console.log("STATUS:", res.status);
  const data = await res.json();
  console.log("quiz_required:", data.quiz_required);
  return data;
}
// Chay: await testCheckQuiz()


// ---- BUOC 5: Test lay danh sach zone (ticket_categories) ----
async function testGetZones() {
  if (!window.__test_eventId) { console.error("Chay testExtractInfo() truoc!"); return; }
  const res = await fetch(
    `https://cticket.vn/tix/public/events/v2/${window.__test_eventId}`,
    { method: "GET", credentials: "include", headers: { "Accept": "application/json" } }
  );
  const data = await res.json();
  const zones = (data.ticket_categories || []).map(c => ({
    id: c.id, name: c.name, price: c.price, for_sale: c.for_sale,
  }));
  console.table(zones);
  window.__test_zones = data.ticket_categories;
  return zones;
}
// Chay: await testGetZones()


// ---- BUOC 6 (CAN THAN - SE DAT VE THAT NEU CHAY): Test booking ----
// CHI chay buoc nay khi da chac chan muon dat ve thuc su, vi se tao order thuc te
// can thanh toan (du chua mat tien nhung se chiem 1 slot ve trong vai phut).
async function testBooking(ticketCategoryId, quantity = 1) {
  if (!window.__test_jwt || !window.__test_bookingToken || !window.__test_occurrenceId) {
    console.error("Chay cac buoc truoc trc!");
    return;
  }
  const payload = {
    payment_method: "BANK_TRANSFER",
    billing_info: { export_bill: false },
    items: [{
      ticket_category_id: ticketCategoryId,
      quantity, desire_count: quantity, ticket_type: "ga",
    }],
    claimer_info: {
      full_name: "TEN CUA MAY",   // <-- sua truoc khi chay
      email: "email@cua-may.com", // <-- sua truoc khi chay
      phone_number: "+84xxxxxxxxx", // <-- sua truoc khi chay
    },
    delivery_info: { delivery_method: "email" },
    occurrence_id: window.__test_occurrenceId,
    attendees_info: [],
  };
  console.log("Payload se gui:", payload);

  const res = await fetch(
    `https://cticket.vn/tix/private/booking/events/${window.__test_eventId}/booking`,
    {
      method: "POST",
      credentials: "include",
      headers: {
        "Accept": "application/json",
        "Content-Type": "application/json",
        "Authorization": `Bearer ${window.__test_jwt}`,
        "booking-token": window.__test_bookingToken,
        "Origin": "https://cticket.vn",
      },
      body: JSON.stringify(payload),
    }
  );
  console.log("STATUS:", res.status);
  const text = await res.text();
  console.log("BODY:", text);
}
// Chay: await testBooking("sao-tram2-svip-b", 1)   <-- thay ticket_category_id thuc te