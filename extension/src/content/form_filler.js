// src/content/form_filler.js
// Tự điền form checkout cho cả 1Zone và Ticketbox

async function fill1ZoneForm(cfg) {
  svpLog("📝 Điền form 1Zone...", "blue");

  await waitForElement("input[data-id='txt-name']", 15000).catch(() => null);

  try {
    const nameInp = document.querySelector("input[data-id='txt-name']");
    if (nameInp) {
      nameInp.focus();
      nameInp.value = "";
      nameInp.dispatchEvent(new Event("input", { bubbles: true }));
      await sleep(30);
      nameInp.value = cfg.name || "";
      nameInp.dispatchEvent(new Event("input", { bubbles: true }));
      nameInp.dispatchEvent(new Event("change", { bubbles: true }));
    }

    const phoneInp = document.querySelector("input[data-id='txt-phoneNumber']");
    if (phoneInp) {
      phoneInp.focus();
      phoneInp.value = cfg.phone || "";
      phoneInp.dispatchEvent(new Event("input", { bubbles: true }));
      phoneInp.dispatchEvent(new Event("change", { bubbles: true }));
    }

    // Địa chỉ nếu có
    const addrInp = document.querySelector("input[name='địaChỉCủaBạn'], input[data-id='txt-note']");
    if (addrInp && cfg.address) {
      addrInp.value = cfg.address;
      addrInp.dispatchEvent(new Event("input", { bubbles: true }));
    }

    // Checkbox điều khoản
    const cb = document.querySelector("input[type='checkbox']");
    if (cb && !cb.checked) cb.click();

    window.dispatchEvent(new Event("resize"));
    svpLog("✅ Đã điền form 1Zone", "green");
    return true;
  } catch (e) {
    svpLog(`❌ Điền form 1Zone lỗi: ${e.message}`, "red");
    return false;
  }
}

async function fillTicketboxForm(cfg) {
  svpLog("📝 Điền form Ticketbox...", "blue");

  await waitForElement("label[for^='question_']", 15000).catch(() => null);
  await sleep(500);

  try {
    const labels = Array.from(document.querySelectorAll("label[for^='question_']"));
    for (const label of labels) {
      const txt = (label.innerText || "").toLowerCase().trim();
      const fid = label.getAttribute("for");
      if (!fid) continue;
      const inp = document.getElementById(fid);
      if (!inp) continue;

      if (/tên|full name|họ và tên|^name/.test(txt)) {
        inp.value = cfg.name || "";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (/điện thoại|phone|số điện thoại|mobile/.test(txt)) {
        inp.value = cfg.phone || "";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (/email/.test(txt)) {
        inp.value = cfg.email || "";
        inp.dispatchEvent(new Event("input", { bubbles: true }));
      }
    }
    svpLog("✅ Đã điền form Ticketbox", "green");
    return true;
  } catch (e) {
    svpLog(`❌ Điền form Ticketbox lỗi: ${e.message}`, "red");
    return false;
  }
}

async function autoFillForm(cfg) {
  const platform = detectPlatform();
  if (platform === "1Zone") return fill1ZoneForm(cfg);
  if (platform === "Ticketbox") return fillTicketboxForm(cfg);
  svpLog("⚠️ Không nhận diện được platform để fill form", "yellow");
  return false;
}
