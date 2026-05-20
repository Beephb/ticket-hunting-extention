// src/content/form_filler.js
// Convert từ form_fillers.py — giữ nguyên toàn bộ logic

// ── 1Zone ────────────────────────────────────────────────────────────────────

async function fill1Zone(cfg) {
  svpLog("📝 Điền form 1Zone...", "blue");
  const name = cfg.name || "";
  const phone = cfg.phone || "";
  const email = cfg.email || "";
  const address = cfg.address || "";

  // Đợi input tên xuất hiện — tín hiệu form đã load
  try {
    await waitForElement("input[data-id='txt-name']", 15000);
  } catch {
    svpLog("❌ Form 1Zone chưa load (timeout 15s)", "red");
    return false;
  }

  try {
    // Điền tên
    const nameInp = document.querySelector("input[data-id='txt-name']");
    if (nameInp) {
      nameInp.focus();
      // Dùng native setter để React nhận được
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      nativeSetter.call(nameInp, name);
      nameInp.dispatchEvent(new Event("input", { bubbles: true }));
      nameInp.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Điền SĐT
    const phoneInp = document.querySelector("input[data-id='txt-phoneNumber']");
    if (phoneInp) {
      phoneInp.focus();
      const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
      nativeSetter.call(phoneInp, phone);
      phoneInp.dispatchEvent(new Event("input", { bubbles: true }));
      phoneInp.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Điền địa chỉ nếu có field
    try {
      const addrInp = document.querySelector("input[name='địaChỉCủaBạn'], input[data-id='txt-note']");
      if (addrInp && address) {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;
        nativeSetter.call(addrInp, address);
        addrInp.dispatchEvent(new Event("input", { bubbles: true }));
        addrInp.dispatchEvent(new Event("change", { bubbles: true }));
      }
    } catch {}

    // Check checkbox đồng ý điều khoản nếu có
    try {
      const cb = document.querySelector("input[type='checkbox']");
      if (cb && !cb.checked) cb.click();
    } catch {}

    // Trigger resize để UI update
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

  // Đợi labels xuất hiện
  try {
    await waitForElement("label[for^='question_']", 15000);
  } catch {
    svpLog("❌ Form Ticketbox chưa load (timeout 15s)", "red");
    return false;
  }

  // Delay nhỏ để tất cả fields render xong
  await sleep(500);

  try {
    const labels = Array.from(document.querySelectorAll("label[for^='question_']"));
    for (const label of labels) {
      try {
        const txt = (label.innerText || "").toLowerCase().trim();
        const fid = label.getAttribute("for");
        if (!fid) continue;

        const inp = document.getElementById(fid);
        if (!inp) continue;

        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value").set;

        if (["tên", "full name", "họ và tên", "name"].some(k => txt.includes(k))) {
          nativeSetter.call(inp, name);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (["điện thoại", "phone", "số điện thoại", "mobile"].some(k => txt.includes(k))) {
          nativeSetter.call(inp, phone);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
        } else if (txt.includes("email")) {
          nativeSetter.call(inp, email);
          inp.dispatchEvent(new Event("input", { bubbles: true }));
          inp.dispatchEvent(new Event("change", { bubbles: true }));
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
