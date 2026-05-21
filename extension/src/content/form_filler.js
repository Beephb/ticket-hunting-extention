// src/content/form_filler.js
// Convert từ form_fillers.py — giữ nguyên toàn bộ logic

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
    return true;
  } catch(e) {
    svpLog(`❌ fill_ticketbox lỗi: ${e.message}`, "red");
    return false;
  }
}

// ── Router ────────────────────────────────────────────────────────────────────

async function autoFillForm(cfg) {
  const platform = detectPlatform();
  if (platform === "1Zone") return fill1Zone(cfg);
  if (platform === "Ticketbox") return fillTicketbox(cfg);
  svpLog("⚠️ Không nhận diện được platform để fill form", "yellow");
  return false;
}
