// src/platforms/ctiket/seat_zone.js
// Ctiket — DOM click flow (không pure API vì server track session state theo step)
// Flow:
//   Step 1: /buy/{eid} — click + zone match → click "Tiếp tục"
//   Step 2: dialog thông tin (?step=2) — điền SĐT → click "Cập nhật thông tin"
//   Step 3: review + thanh toán — click "Tiếp tục" → server POST /booking tự động

const CTIKET_API_BASE = "https://cticket.vn";

// ── Zone matching helpers ─────────────────────────────────────────────────────

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

// ── URL helpers ───────────────────────────────────────────────────────────────

function extractCtiketInfo() {
  const out = { url: location.href, eventId: null, occurrenceId: null };
  try {
    const m = location.pathname.match(/\/buy\/([a-zA-Z0-9_-]+)/);
    if (m) out.eventId = m[1];
  } catch {}
  try {
    out.occurrenceId = new URL(location.href).searchParams.get("ocid") || null;
  } catch {}
  return out;
}

// ── DOM helpers ───────────────────────────────────────────────────────────────

// Poll DOM cho đến khi selector tìm thấy element (tối đa timeoutMs)
async function waitForElement(selector, timeoutMs = 8000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const el = document.querySelector(selector);
    if (el) return el;
    await new Promise(r => setTimeout(r, intervalMs));
  }
  return null;
}

// Điền value vào input theo cách React nhận được (simulate native setter + input event)
function fillReactInput(input, value) {
  input.focus();
  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  nativeSetter.call(input, "");
  input.dispatchEvent(new Event("input", { bubbles: true }));
  // Simulate typing từng ký tự để React state update đúng
  for (const char of String(value)) {
    input.dispatchEvent(new KeyboardEvent("keydown", { key: char, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keypress", { key: char, bubbles: true }));
    nativeSetter.call(input, input.value + char);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup", { key: char, bubbles: true }));
  }
  input.dispatchEvent(new Event("change", { bubbles: true }));
  input.blur();
}

function normalizePhoneVN(phone) {
  if (!phone) return phone;
  const p = String(phone).trim().replace(/\s+/g, "");
  if (p.startsWith("0")) return p; // giữ nguyên 0xxx vì form nhận dạng này
  if (p.startsWith("+84")) return "0" + p.slice(3);
  if (p.startsWith("84")) return "0" + p.slice(2);
  return p;
}

// ── Step 1: Chọn zone + click Tiếp tục ───────────────────────────────────────

// Re-query plusBtn theo tên zone (tránh stale reference sau React re-render)
function ckFindPlusBtn(zoneName) {
  for (const wrapper of document.querySelectorAll(".ticket-wrapper")) {
    const nameEl = wrapper.querySelector("p");
    if (!nameEl) continue;
    if (nameEl.textContent.trim() === zoneName) {
      return wrapper.querySelector("button:last-child") || null;
    }
  }
  return null;
}

// Click + cho 1 zone, trả về số lượng thực tế click được
async function ckClickPlus(zoneName, quantity) {
  let actual = 0;
  for (let i = 0; i < quantity; i++) {
    const btn = ckFindPlusBtn(zoneName);
    if (!btn || btn.disabled) {
      svpLog(`Ctiket step1: zone "${zoneName}" het ve sau ${actual} ve`, "yellow");
      break;
    }
    btn.click();
    actual++;
    await new Promise(r => setTimeout(r, 200));
  }
  return actual;
}

async function ckStep1SelectZone(zoneItems, allowPartial) {
  // zoneItems: [{zone: string, quantity: number}] — mỗi zone có số lượng riêng
  svpLog("Ctiket step1: tim zone tren trang...", "blue");

  const firstWrapper = await waitForElement(".ticket-wrapper", 8000);
  if (!firstWrapper) {
    svpLog("Ctiket step1: khong tim thay ticket-wrapper", "red");
    return false;
  }

  let totalClicked = 0;
  let totalWanted = zoneItems.reduce((s, i) => s + (i.quantity || 1), 0);

  // Duyệt từng zone item theo priority
  for (const item of zoneItems) {
    const wanted = item.zone;
    const qty = item.quantity || 1;

    // Tìm zone match tốt nhất còn vé
    let bestMatch = null, bestScore = 0;
    for (const wrapper of document.querySelectorAll(".ticket-wrapper")) {
      const nameEl = wrapper.querySelector("p");
      if (!nameEl) continue;
      const name = nameEl.textContent.trim();
      const plusBtn = wrapper.querySelector("button:last-child");
      if (!plusBtn || plusBtn.disabled) continue;
      const score = zoneScoreCk(wanted, name);
      if (score > bestScore) { bestScore = score; bestMatch = name; }
    }

    if (!bestMatch) {
      svpLog(`Ctiket step1: zone "${wanted}" khong con ve — bo qua`, "yellow");
      continue;
    }

    svpLog(`Ctiket step1: match "${wanted}" -> "${bestMatch}" — click + x${qty}`, "green");
    const clicked = await ckClickPlus(bestMatch, qty);
    totalClicked += clicked;

    if (clicked < qty && !allowPartial) {
      svpLog(`Ctiket step1: zone "${bestMatch}" chi co ${clicked}/${qty} ve, allow_partial=false`, "yellow");
    }
  }

  if (totalClicked === 0) {
    svpLog("Ctiket step1: khong chon duoc ve nao", "red");
    return false;
  }

  if (totalClicked < totalWanted && !allowPartial) {
    svpLog(`Ctiket step1: chi chon duoc ${totalClicked}/${totalWanted} ve, allow_partial=false — dung`, "red");
    return false;
  }

  svpLog(`Ctiket step1: da chon ${totalClicked}/${totalWanted} ve — click Tiep tuc`, "green");
  await new Promise(r => setTimeout(r, 500));

  const continueBtn = document.querySelector('[data-id="buy-button-continue-desktop"]')
    || document.querySelector('[id="buy-button-continue-desktop"]')
    || [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Tiếp tục" && !b.disabled);

  if (!continueBtn) {
    svpLog("Ctiket step1: khong tim thay nut Tiep tuc", "red");
    return false;
  }

  continueBtn.click();
  return true;
}

// ── Step 2: Điền thông tin + click Cập nhật ──────────────────────────────────

async function ckStep2FillInfo(phone, cfg) {
  svpLog("Ctiket step2: doi dialog thong tin xuat hien...", "blue");

  // Đợi dialog xuất hiện
  const phoneInput = await waitForElement("#claimerInfo\\.phoneNumber", 8000);
  if (!phoneInput) {
    svpLog("Ctiket step2: dialog khong xuat hien sau 8s", "red");
    return false;
  }

  const normalizedPhone = normalizePhoneVN(phone);
  svpLog(`Ctiket step2: dien SDT ${normalizedPhone}`, "blue");
  fillReactInput(phoneInput, normalizedPhone);

  // Điền custom fields vào dialog nếu có
  if (cfg?.custom_fields?.length) {
    const allInputs = document.querySelectorAll(
      "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='checkbox']):not([type='radio']), textarea"
    );
    for (const field of cfg.custom_fields) {
      const kw = (field.keyword || "").toLowerCase().trim();
      const val = field.value || "";
      if (!kw || !val) continue;
      for (const el of allInputs) {
        let labelText = "";
        if (el.id) {
          const lbl = document.querySelector(`label[for="${el.id}"]`);
          if (lbl) labelText = lbl.innerText?.trim() || "";
        }
        const haystack = [
          labelText,
          el.getAttribute("placeholder") || "",
          el.getAttribute("name") || "",
          el.getAttribute("id") || "",
        ].join(" ").toLowerCase();
        if (!haystack.includes(kw)) continue;
        fillReactInput(el, val);
        svpLog(`Ctiket step2: custom field [${kw}] → "${val}"`, "green");
        break;
      }
    }
  }

  await new Promise(r => setTimeout(r, 500));

  // Click "Cập nhật thông tin"
  const saveBtn = document.querySelector("#claimer-info-dialog-button-save")
    || [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Cập nhật thông tin" && !b.disabled);

  if (!saveBtn) {
    svpLog("Ctiket step2: khong tim thay nut Cap nhat thong tin", "red");
    return false;
  }

  svpLog("Ctiket step2: click Cap nhat thong tin...", "blue");
  saveBtn.click();
  return true;
}

// ── Step 3: Click Tiếp tục để submit booking ─────────────────────────────────

async function ckStep3Submit() {
  svpLog("Ctiket step3: doi trang review...", "blue");

  // Đợi dialog đóng và trang review xuất hiện
  await new Promise(r => setTimeout(r, 1000));

  // Đợi dialog biến mất
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const dialog = document.querySelector("#claimer-info-dialog-button-save");
    if (!dialog) break;
    await new Promise(r => setTimeout(r, 200));
  }

  await new Promise(r => setTimeout(r, 500));

  // Click "Tiếp tục" ở trang review
  const continueBtn = document.querySelector('[data-id="buy-button-continue-desktop"], [id="buy-button-continue-desktop"]')
    || [...document.querySelectorAll("button")].find(b => b.textContent.trim() === "Tiếp tục" && !b.disabled);

  if (!continueBtn) {
    svpLog("Ctiket step3: khong tim thay nut Tiep tuc", "red");
    return false;
  }

  svpLog("Ctiket step3: click Tiep tuc de submit booking...", "green");
  continueBtn.click();
  return true;
}

// ── Main entry ────────────────────────────────────────────────────────────────

async function runCtiketSeatZone(cfg) {
  const info = extractCtiketInfo();
  const { eventId, occurrenceId } = info;

  if (!eventId || !occurrenceId) {
    svpLog(`Ctiket: khong detect duoc eventId/occurrenceId tu URL (${info.url})`, "red");
    return false;
  }

  const aseat = cfg?.auto_seat?.["ctiket"] || cfg?.auto_seat || {};
  const allowPartial = !!aseat.allow_partial;
  const phone = cfg?.phone;

  // Đọc items mới [{zone, quantity}] hoặc fallback zone_priority + quantity cũ
  let zoneItems = [];
  if (aseat.items && aseat.items.length) {
    zoneItems = aseat.items.filter(i => i.zone);
  } else {
    const zones = aseat.zone_priority || aseat.priority_targets || cfg?.zone_priority || [];
    const qty = aseat.quantity || cfg?.quantity || 1;
    zoneItems = zones.map(z => ({ zone: z, quantity: qty }));
  }

  if (!zoneItems.length) {
    svpLog("Ctiket: chua cau hinh zone/items", "red");
    return false;
  }
  if (!phone) {
    svpLog("Ctiket: thieu so dien thoai trong cfg", "red");
    return false;
  }

  // Step 1: chọn zone
  const step1Ok = await ckStep1SelectZone(zoneItems, allowPartial);
  if (!step1Ok) return false;

  // Step 2: điền thông tin (dialog xuất hiện sau khi click Tiếp tục ở step 1)
  // Sau khi click "Cập nhật thông tin" → dừng để user kiểm tra rồi tự bấm tiếp
  const step2Ok = await ckStep2FillInfo(phone, cfg);
  if (!step2Ok) return false;

  svpLog("Ctiket: da dien thong tin — vui long kiem tra va bam Tiep tuc de dat ve", "green");
  return true;
}