// src/popup/popup.js
const API_BASE = "http://127.0.0.1:9279";
const LOGS = [];

async function fetchConfig() {
  try {
    const res = await fetch(`${API_BASE}/config`, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    return res.json();
  } catch { return null; }
}

async function saveEnabled(val) {
  try {
    await fetch(`${API_BASE}/config`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ auto_seat: { enabled: val } }),
      signal: AbortSignal.timeout(2000),
    });
  } catch {}
}

function renderConfig(cfg) {
  const as = cfg?.auto_seat || {};
  document.getElementById("cfg-platform").textContent = as.platform || "—";
  document.getElementById("cfg-mode").textContent = as.seat_mode || "—";
  const zones = (as.zone_priority || as.priority_targets || []).slice(0, 3).join(", ") || "—";
  document.getElementById("cfg-zones").textContent = zones;
  document.getElementById("cfg-qty").textContent = as.quantity || 1;
  document.getElementById("bot-toggle").checked = !!as.enabled;
}

function addLog(msg) {
  LOGS.push(msg);
  if (LOGS.length > 20) LOGS.shift();
  const box = document.getElementById("log-box");
  box.textContent = LOGS.slice(-4).join("\n");
  box.scrollTop = box.scrollHeight;
}

async function init() {
  const cfg = await fetchConfig();
  const dot = document.getElementById("app-dot");
  const status = document.getElementById("app-status");

  if (cfg) {
    dot.className = "dot online";
    status.textContent = "Desktop App đang chạy";
    document.getElementById("sub-text").textContent = "v2.0.0 · Kết nối OK";
    renderConfig(cfg);
    addLog(`Config loaded: ${cfg?.auto_seat?.platform} / ${cfg?.auto_seat?.seat_mode}`);
  } else {
    dot.className = "dot offline";
    status.textContent = "Desktop App chưa chạy (port 9279)";
    addLog("⚠️ Không kết nối được App — hãy mở main.py");
  }

  // Toggle bot
  document.getElementById("bot-toggle").addEventListener("change", async e => {
    await saveEnabled(e.target.checked);
    addLog(e.target.checked ? "🟢 Bot bật" : "⏸ Bot tắt");
    const tabs = await chrome.tabs.query({ url: ["https://ticket.1zone.vn/*", "https://ticketbox.vn/*"] });
    for (const tab of tabs) {
      chrome.tabs.sendMessage(tab.id, { type: "CONFIG_RELOAD" }).catch(() => {});
    }
  });

  // Helper gửi message tới tab hiện tại
  async function sendToTab(type, label) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type }).catch(() => {
        addLog(`❌ Tab chưa load content script`);
      });
      addLog(`✅ ${label}`);
    }
  }

  // Alt+2: Chọn ghế ngay
  document.getElementById("btn-run").addEventListener("click", () => sendToTab("RUN_NOW", "Gửi lệnh chọn ghế"));

  // Alt+1: Hunt + chọn tự động
  document.getElementById("btn-hunt").addEventListener("click", () => sendToTab("HUNT_NOW", "Bắt đầu Hunt + auto chọn ghế"));

  // Chỉ Hunt (không set flag auto seat)
  document.getElementById("btn-hunt-only").addEventListener("click", async () => {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      chrome.tabs.sendMessage(tab.id, { type: "HUNT_ONLY" }).catch(() => {
        addLog("❌ Tab chưa load content script");
      });
      addLog("✅ Bắt đầu Hunt (chỉ navigate, không chọn ghế)");
    }
  });

  // Alt+3: Điền form
  document.getElementById("btn-fill").addEventListener("click", () => sendToTab("FILL_FORM_NOW", "Gửi lệnh điền form"));

  // Dừng Hunt
  document.getElementById("btn-stop-hunt").addEventListener("click", () => sendToTab("STOP_HUNT", "Đã gửi dừng Hunt"));

  // Mở app (chỉ thông báo vì không mở app từ extension)
  document.getElementById("btn-open-app").addEventListener("click", () => {
    addLog("ℹ️ Hãy mở main.py thủ công để khởi động Desktop App");
  });
}

init();

// Refresh mỗi 5 giây
setInterval(async () => {
  const cfg = await fetchConfig();
  if (cfg) renderConfig(cfg);
}, 5000);
