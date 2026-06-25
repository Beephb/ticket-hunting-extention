// ============================================================================
// TEST THU CONG TUNG API CTIKET - paste vao Console (F12) tren tab cticket.vn
// dang o trang /buy/{eventId}?ocid=...
//
// Chay TUNG BUOC mot, kiem tra ket qua truoc khi sang buoc tiep theo.
// KHONG dong tab giua cac buoc (can giu cookie session + booking_token).
// ============================================================================

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
