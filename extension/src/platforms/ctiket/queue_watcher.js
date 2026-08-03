// src/platforms/ctiket/queue_watcher.js
// Chay khi tab dang o trang queue: cticket.vn/buy/{eid}/queue?ocid=...
// Tu dong: whoami -> lay captcha token -> poll waiting-room/enter
//   - people_ahead > 0 → poll lai moi POLL_INTERVAL_MS
//   - people_ahead = 0 → luu booking_token + click button chuyen trang
//   - button khong xuat hien sau 10s → KHONG break, goi lai enter() de React re-render
//
// window.watchCtiketQueue duoc export de runner.js goi khi SPA nav sang /queue.

const _CK_BOOKING_TOKEN_KEY = "__svp_ck_booking_token__";
const _CK_POLL_INTERVAL_MS  = 900; // giam tu 2000ms — detect people_ahead=0 nhanh hon,
                                    // danh doi: nhieu request hon (~2.2x), chap nhan duoc
                                    // vi endpoint enter() nhe, khong phai API tranh mua truc tiep.

let _ckWatching = false;

function _ckIsQueuePage() {
  return /\/buy\/[a-zA-Z0-9_-]+\/queue/.test(location.pathname);
}

function _ckExtractIds() {
  const m = location.pathname.match(/\/buy\/([a-zA-Z0-9_-]+)\/queue/);
  const eventId = m ? m[1] : null;
  let ocid = null;
  try { ocid = new URL(location.href).searchParams.get("ocid") || null; } catch {}
  return { eventId, ocid };
}

// Tra ve { ok, jwt, status } thay vi chi jwt|null — de watchLoop phan biet duoc
// loi mang/qua tai (timeout, 5xx) voi that su chua dang nhap (401/403).
async function _ckWhoami() {
  try {
    const res = await fetch("https://cticket.vn/sessions/whoami?tokenize_as=jwt", {
      method: "GET", credentials: "include",
      headers: { "Accept": "application/json, text/plain, */*" },
      signal: AbortSignal.timeout(6000),
    });
    if (!res.ok) return { ok: false, status: res.status };
    const data = await res.json();
    return { ok: true, jwt: data?.tokenized || null, status: res.status };
  } catch (e) {
    return { ok: false, status: 0, error: e.message }; // 0 = network error/timeout, khong phai auth
  }
}

function _ckGetCaptchaToken() {
  // Giao tiep voi MAIN world (ctiket_captcha_bridge.js) qua CustomEvent
  // vi window khac nhau giua ISOLATED va MAIN world
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("captcha timeout 15s")), 15000);
    document.addEventListener("svp:captchaResult", (e) => {
      clearTimeout(timeout);
      if (e.detail.error) reject(new Error(e.detail.error));
      else resolve(e.detail.token);
    }, { once: true });
    document.dispatchEvent(new CustomEvent("svp:getCaptcha"));
  });
}

async function _ckEnterWaitingRoom(eventId, jwt, captchaToken) {
  try {
    const res = await fetch(
      `https://cticket.vn/tix/private/booking/events/${eventId}/waiting-room/enter`,
      {
        method: "GET", credentials: "include",
        headers: {
          "Accept": "application/json",
          "Authorization": `Bearer ${jwt}`,
          "x-captcha-token": captchaToken,
        },
        signal: AbortSignal.timeout(8000),
      }
    );
    const text = await res.text();
    let data = null;
    try { data = JSON.parse(text); } catch {}
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    return { ok: false, status: 0, data: null, error: e.message };
  }
}

function _ckDecodeJwtExp(jwt) {
  try {
    const payload = jwt.split(".")[1];
    const padded = payload + "=".repeat((4 - payload.length % 4) % 4);
    const json = JSON.parse(atob(padded.replace(/-/g, "+").replace(/_/g, "/")));
    return json.exp ? json.exp * 1000 : null;
  } catch { return null; }
}

// Tim button chuyen trang sau khi pass queue. Uu tien id (on dinh nhat, khong doi
// theo build nhu class hash CSS-in-JS kieu "b1rq0yli b1kojs1a"), fallback theo text,
// fallback cuoi la class cu (phong khi Ctiket lai doi id).
function _ckFindQueueButton() {
  return document.querySelector("#queue-footer-button-go-to-buy")
    || [...document.querySelectorAll("button")].find(b =>
         /chuy[eê]n \u0111[eế]n trang mua v[eé]|v[aà]o mua v[eé] ngay|ti[eế]p t[uụ]c/i.test(b.textContent)
       )
    || document.querySelector("button.btn.btn-primary");
}

async function watchLoop() {
  if (_ckWatching) return;
  _ckWatching = true;

  const { eventId, ocid } = _ckExtractIds();
  if (!eventId) {
    svpLog("Ctiket queue_watcher: khong lay duoc eventId tu URL", "red");
    _ckWatching = false;
    return;
  }

  svpLog(`Ctiket queue_watcher: bat dau — eventId=${eventId} ocid=${ocid || "?"}`, "blue");

  // JWT TTL ~7 ngay — lay 1 lan dung suot. Retry vai lan neu loi do server qua tai
  // (5xx/timeout) — chi that su dung han khi la loi auth ro rang (401/403).
  const WHOAMI_MAX_RETRIES = 8;
  let jwt = null;
  for (let i = 0; i < WHOAMI_MAX_RETRIES; i++) {
    const r = await _ckWhoami();
    if (r.ok && r.jwt) { jwt = r.jwt; break; }
    if (r.status === 401 || r.status === 403) {
      svpLog(`Ctiket queue_watcher: chua dang nhap (status=${r.status}) — can dang nhap Google truoc`, "red");
      _ckWatching = false;
      return;
    }
    svpLog(
      `Ctiket queue_watcher: whoami loi (status=${r.status || 0}${r.error ? ", " + r.error : ""}) — ` +
      `co the do server qua tai, thu lai (${i + 1}/${WHOAMI_MAX_RETRIES})...`,
      "yellow"
    );
    await new Promise(res => setTimeout(res, _CK_POLL_INTERVAL_MS));
  }
  if (!jwt) {
    svpLog(`Ctiket queue_watcher: whoami that bai lien tuc sau ${WHOAMI_MAX_RETRIES} lan thu — dung lai. Thu F5 lai trang.`, "red");
    _ckWatching = false;
    return;
  }

  while (_ckIsQueuePage()) {
    // Lay captcha moi moi vong (TTL recaptcha token ~2 phut)
    let captchaToken;
    try {
      captchaToken = await _ckGetCaptchaToken();
    } catch (e) {
      svpLog(`Ctiket queue_watcher: captcha loi (${e.message}) — thu lai...`, "yellow");
      await new Promise(r => setTimeout(r, _CK_POLL_INTERVAL_MS));
      continue;
    }

    const enter = await _ckEnterWaitingRoom(eventId, jwt, captchaToken);

    if (!enter.ok || !enter.data?.booking_token) {
      svpLog(`Ctiket queue_watcher: enter that bai (status=${enter.status}), thu lai...`, "yellow");
      await new Promise(r => setTimeout(r, _CK_POLL_INTERVAL_MS));
      continue;
    }

    const { booking_token: bookingToken, people_ahead = 0, estimated_waiting_time = 0 } = enter.data;

    if (people_ahead > 0) {
      const eta = estimated_waiting_time > 0 ? ` (~${Math.round(estimated_waiting_time)}s)` : "";
      svpLog(`Ctiket queue_watcher: con ${people_ahead} nguoi phia truoc${eta} — poll lai...`, "blue");
      await new Promise(r => setTimeout(r, _CK_POLL_INTERVAL_MS));
      continue;
    }

    // people_ahead = 0 → DA PASS QUEUE
    svpLog("Ctiket queue_watcher: da pass queue! Luu token va cho button render...", "green");

    const expAt = _ckDecodeJwtExp(bookingToken) || (Date.now() + 10 * 60 * 1000);

    try {
      await chrome.runtime.sendMessage({
        type: "SVP_SAVE_CK_TOKEN",
        payload: { eventId, jwt, bookingToken, expAt, savedAt: Date.now(), ocid: ocid || null },
      });
      svpLog(`Ctiket queue_watcher: da luu booking_token (het han ${new Date(expAt).toLocaleTimeString()})`, "green");
    } catch (e) {
      svpLog(`Ctiket queue_watcher: luu token loi (${e.message}) — van navigate`, "yellow");
    }

    // Poll DOM cho den khi button xuat hien roi click (toi da 10s)
    // Neu khong thay button → KHONG break, tiep tuc vong while
    // goi lai enter() de lay response moi, React moi re-render button
    svpLog("Ctiket queue_watcher: cho button render...", "blue");
    const clicked = await (async () => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const btn = _ckFindQueueButton();
        if (btn) {
          svpLog(`Ctiket queue_watcher: click button "${btn.textContent.trim()}"`, "green");
          // Chi bao "queue_passed" (cho phep auto-chon-ghe o buy page) neu day la
          // mode full-hunt (autoSeat=true, tuc _CK_BOOKING... hunt_done flag co san).
          // Mode hunt-only (chi flag rieng __svp_ck_queue_only__) → qua duoc queue
          // nhung KHONG duoc trigger auto-chon-ghe, dung y dinh "chi san ve".
          window.__svp_queue_passed__ = !!sessionStorage.getItem("__svp_hunt_done__");
          btn.click();
          return true;
        }
        await new Promise(r => setTimeout(r, 100));
      }
      return false;
    })();

    if (clicked) break;

    // Button khong xuat hien — goi lai enter() o vong tiep theo
    svpLog("Ctiket queue_watcher: button khong xuat hien sau 10s — goi lai enter()...", "yellow");
    await new Promise(r => setTimeout(r, _CK_POLL_INTERVAL_MS));
  }

  _ckWatching = false;
}

// Auto-start neu dang o trang queue luc inject
if (_ckIsQueuePage()) {
  watchLoop();
}

// Export global de runner.js goi khi SPA nav sang /queue
window.watchCtiketQueue = watchLoop;