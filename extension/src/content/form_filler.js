// src/content/form_filler.js
// Convert từ form_fillers.py — giữ nguyên toàn bộ logic

// ── Scan Fields ───────────────────────────────────────────────────────────────
// Quét DOM tìm tất cả input/textarea/select + label/placeholder/name/id
// Trả về list để Desktop hiển thị cho user chọn keyword

function svpScanFields() {
  const results = [];
  const seen = new Set();

  const inputs = document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='checkbox']):not([type='radio']), textarea, select");

  for (const el of inputs) {
    // Tìm label gần nhất
    let labelText = "";
    if (el.id) {
      const lbl = document.querySelector(`label[for="${el.id}"]`);
      if (lbl) labelText = lbl.innerText?.trim() || "";
    }
    if (!labelText) {
      // Label wrap
      const parent = el.closest("label");
      if (parent) labelText = parent.innerText?.trim().replace(el.value, "").trim() || "";
    }
    if (!labelText) {
      // Label sibling trước đó
      let prev = el.previousElementSibling;
      while (prev) {
        if (prev.tagName === "LABEL" || prev.matches("span,div,p")) {
          labelText = prev.innerText?.trim() || "";
          if (labelText) break;
        }
        prev = prev.previousElementSibling;
      }
    }

    const placeholder = el.getAttribute("placeholder") || "";
    const name        = el.getAttribute("name") || "";
    const id          = el.getAttribute("id") || "";

    // Bỏ qua nếu không có gợi ý gì
    if (!labelText && !placeholder && !name && !id) continue;

    // Dedup theo key
    const key = `${labelText}|${placeholder}|${name}|${id}`;
    if (seen.has(key)) continue;
    seen.add(key);

    results.push({ label: labelText, placeholder, name, id });
  }

  return results;
}

// ── Fill custom fields (dùng chung 3 platform) ────────────────────────────────

async function fillCustomFields(cfg) {
  const customFields = cfg?.custom_fields;
  svpLog(`🔍 fillCustomFields: custom_fields=${JSON.stringify(customFields)}`, "blue");
  if (!customFields || !customFields.length) {
    svpLog("⚠️ Không có custom_fields trong config", "yellow");
    return;
  }

  const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
  const nativeTextSetter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;

  const inputs = document.querySelectorAll(
    "input:not([type='hidden']):not([type='submit']):not([type='button']):not([type='checkbox']):not([type='radio']), textarea"
  );

  for (const field of customFields) {
    const kw = (field.keyword || "").toLowerCase().trim();
    const val = field.value || "";
    if (!kw || !val) continue;

    for (const el of inputs) {
      // Gom label + placeholder + name + id thành 1 chuỗi để so
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

      try {
        if (el.tagName === "TEXTAREA") {
          if (nativeTextSetter) nativeTextSetter.call(el, val);
          else el.value = val;
        } else {
          nativeSetter.call(el, val);
        }
        el.dispatchEvent(new Event("input",  { bubbles: true }));
        el.dispatchEvent(new Event("change", { bubbles: true }));
        svpLog(`✅ Custom field [${kw}] → "${val}"`, "green");
      } catch {}
      break; // Tìm thấy 1 field là đủ, không điền trùng
    }
  }
}

// ── 1Zone ────────────────────────────────────────────────────────────────────

async function fill1Zone(cfg) {
  svpLog("📝 Điền form 1Zone...", "blue");
  const name = cfg.name || "";
  const phone = cfg.phone || "";
  const address = cfg.address || "";

  try {
    await waitForElement("input[data-id='txt-name']", 15000);
  } catch {
    svpLog("❌ Form 1Zone chưa load (timeout 15s)", "red");
    return false;
  }

  try {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;

    const nameInp = document.querySelector("input[data-id='txt-name']");
    if (nameInp) {
      nameInp.focus();
      nativeSetter.call(nameInp, name);
      nameInp.dispatchEvent(new Event("input", { bubbles: true }));
      nameInp.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const phoneInp = document.querySelector("input[data-id='txt-phoneNumber']");
    if (phoneInp) {
      phoneInp.focus();
      nativeSetter.call(phoneInp, phone);
      phoneInp.dispatchEvent(new Event("input", { bubbles: true }));
      phoneInp.dispatchEvent(new Event("change", { bubbles: true }));
    }

    try {
      const addrInp = document.querySelector("input[name='địaChỉCủaBạn'], input[data-id='txt-note']");
      if (addrInp && address) {
        nativeSetter.call(addrInp, address);
        addrInp.dispatchEvent(new Event("input", { bubbles: true }));
      }
    } catch {}

    try {
      const cb = document.querySelector("input[type='checkbox']");
      if (cb && !cb.checked) cb.click();
    } catch {}

    window.dispatchEvent(new Event("resize"));
    svpLog("✅ Đã điền form 1Zone", "green");
    await fillCustomFields(cfg);
    return true;
  } catch(e) {
    svpLog(`❌ fill_1zone lỗi: ${e.message}`, "red");
    return false;
  }
}

// ── Ticketbox ─────────────────────────────────────────────────────────────────

async function fillTicketbox(cfg) {
  svpLog("📝 Điền form Ticketbox...", "blue");
  const name = cfg.name || "";
  const phone = cfg.phone || "";
  const email = cfg.email || "";

  try {
    await waitForElement("label[for^='question_']", 15000);
  } catch {
    svpLog("❌ Form Ticketbox chưa load (timeout 15s)", "red");
    return false;
  }

  await sleep(500);

  try {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const labels = Array.from(document.querySelectorAll("label[for^='question_']"));

    for (const label of labels) {
      try {
        const txt = (label.innerText || "").toLowerCase().trim();
        const fid = label.getAttribute("for");
        if (!fid) continue;

        const el = document.getElementById(fid);
        if (!el) continue;

        // Radio group (Ant Design) — đồng ý điều khoản
        if (el.classList.contains("ant-radio-group") || el.tagName === "DIV") {
          const radio = el.querySelector("input[type='radio']");
          if (radio && !radio.checked) {
            radio.click();
            svpLog("✅ Đã tick đồng ý điều khoản", "green");
          }
          continue;
        }

        // Input text thường
        if (el.tagName !== "INPUT") continue;

        if (["tên", "full name", "họ và tên", "họ & tên", "name"].some(k => txt.includes(k))) {
          nativeSetter.call(el, name);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (["điện thoại", "phone", "số điện thoại", "mobile"].some(k => txt.includes(k))) {
          nativeSetter.call(el, phone);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (txt.includes("email")) {
          nativeSetter.call(el, email);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        }
      } catch { continue; }
    }

    svpLog("✅ Đã điền form Ticketbox", "green");
    await fillCustomFields(cfg);
    return true;
  } catch(e) {
    svpLog(`❌ fill_ticketbox lỗi: ${e.message}`, "red");
    return false;
  }
}

// ── Ctiket ────────────────────────────────────────────────────────────────────

async function fillCtiket(cfg) {
  svpLog("📝 Điền form Ctiket...", "blue");
  const name  = cfg.name  || "";
  const phone = cfg.phone || "";
  const email = cfg.email || "";

  try {
    await waitForElement("input, textarea", 15000);
  } catch {
    svpLog("❌ Form Ctiket chưa load (timeout 15s)", "red");
    return false;
  }

  try {
    const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
    const inputs = Array.from(document.querySelectorAll("input:not([type='hidden']):not([type='submit']):not([type='button']), textarea"));

    for (const el of inputs) {
      let labelText = "";
      if (el.id) {
        const lbl = document.querySelector(`label[for="${el.id}"]`);
        if (lbl) labelText = lbl.innerText?.trim() || "";
      }
      const haystack = [
        labelText,
        el.getAttribute("placeholder") || "",
        el.getAttribute("name") || "",
      ].join(" ").toLowerCase();

      let val = null;
      if (["tên","họ tên","full name","name"].some(k => haystack.includes(k))) val = name;
      else if (["điện thoại","phone","mobile","số điện thoại"].some(k => haystack.includes(k))) val = phone;
      else if (haystack.includes("email")) val = email;

      if (val !== null) {
        try {
          nativeSetter.call(el, val);
          el.dispatchEvent(new Event("input",  { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        } catch {}
      }
    }

    svpLog("✅ Đã điền form Ctiket", "green");
    await fillCustomFields(cfg);
    return true;
  } catch(e) {
    svpLog(`❌ fill_ctiket lỗi: ${e.message}`, "red");
    return false;
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

async function autoFillForm(cfg) {
  const platform = detectPlatform();
  if (platform === "1Zone")     return fill1Zone(cfg);
  if (platform === "Ticketbox") return fillTicketbox(cfg);
  if (platform === "Ctiket")    return fillCtiket(cfg);
  svpLog("⚠️ Không nhận diện được platform để fill form", "yellow");
  return false;
}