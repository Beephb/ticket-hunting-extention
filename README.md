# Săn Vé Pro v2.0

Bot tự động săn và mua vé concert/sự kiện trên **1Zone** và **Ticketbox**, chạy trực tiếp trong Chrome thông qua Extension — không cần mở Chrome với flag đặc biệt, không cần Playwright.

---

## Kiến trúc tổng quan

```
Desktop App (Python)          Chrome Extension
┌─────────────────┐          ┌──────────────────────────────────┐
│  Giao diện cấu  │◄────────►│  background.js (singleton)       │
│  hình + Log     │  HTTP    │  - Inject content scripts        │
│  port 9279      │  API     │  - Poll config từ App            │
└─────────────────┘          │  - executeScript (Konva/Seats.io)│
                             └──────────────┬───────────────────┘
                                            │ inject
                                            ▼
                             ┌──────────────────────────────────┐
                             │  Content Scripts (tab)           │
                             │  runner.js → điều phối           │
                             │  hunt_*.js → săn vé              │
                             │  seat_*.js → chọn ghế            │
                             │  form_filler.js → điền form      │
                             └──────────────────────────────────┘
```

---

## Cấu trúc thư mục

```
SanVePro/
├── app/
│   ├── main.py              # Desktop App — giao diện + localhost API
│   ├── requirements.txt
│   └── config.json          # Tự tạo khi lưu lần đầu
│
└── extension/
    ├── manifest.json
    ├── icons/
    └── src/
        ├── background/
        │   └── background.js        # Service worker singleton
        ├── content/
        │   ├── utils.js             # Helpers dùng chung
        │   ├── api.js               # Fetch API 1Zone/Ticketbox
        │   ├── zone_matcher.js      # Match zone theo tên ưu tiên
        │   ├── konva_clicker.js     # Click Konva canvas qua executeScript
        │   ├── hunt_1zone.js        # Hunt vé 1Zone
        │   ├── hunt_ticketbox.js    # Hunt vé Ticketbox
        │   ├── seat_1zone_zone.js   # Chọn khu (zone) 1Zone
        │   ├── seat_1zone_map.js    # Chọn ghế cụ thể 1Zone (Seats.io)
        │   ├── seat_ticketbox_zone.js  # Chọn khu Ticketbox (Konva)
        │   ├── seat_ticketbox_map.js   # Chọn ghế cụ thể Ticketbox
        │   ├── form_filler.js       # Điền form checkout
        │   └── runner.js            # Điều phối trung tâm
        └── popup/
            ├── popup.html
            └── popup.js
```

---

## Cài đặt

### 1. Desktop App

```powershell
cd app
pip install customtkinter
python main.py
```

App khởi động **localhost API tại port 9279** — Extension đọc config từ đây.

### 2. Chrome Extension

1. Mở Chrome → `chrome://extensions/`
2. Bật **Developer mode** (góc trên phải)
3. Click **Load unpacked** → chọn thư mục `extension/`

### 3. Đổi phím tắt (tuỳ chọn)

Vào `chrome://extensions/shortcuts` để remap phím tắt.

---

## Cấu hình

Điền trong Desktop App rồi bấm **Lưu config**:

| Trường | Mô tả |
|---|---|
| Họ tên / SĐT / Email / Địa chỉ | Dùng để tự điền form checkout |
| Platform | `1Zone` hoặc `Ticketbox` |
| Kiểu chọn vé | `seat_zone` (chọn khu) hoặc `seat_map` (chọn ghế cụ thể) |
| Ưu tiên zone/khu | Mỗi dòng 1 zone, thử theo thứ tự từ trên xuống |
| Số lượng vé | 1, 2, 3... |

### Cú pháp nhập ưu tiên

**seat_zone** — tên khu vực, mỗi dòng 1 khu:
```
HIÊN 1
HIÊN 2
VIP A
```

**seat_map** — hỗ trợ nhiều dạng:
```
CUỐN LẤY ANH ĐI     ← tên khu (text match)
M:18                 ← hàng M ghế 18
M:15-20              ← hàng M ghế 15 đến 20
A-D:5-15             ← hàng A đến D, ghế 5 đến 15
M:18,20,22           ← hàng M các ghế cụ thể
```

---

## Sử dụng

### Popup Extension

| Nút | Phím tắt | Chức năng |
|---|---|---|
| 🏹 Hunt + chọn tự động | `Alt+1` | Săn vé → chọn ghế → điền form tự động hoàn toàn |
| ▶ Chọn ghế | `Alt+2` | Chỉ chọn ghế trên trang hiện tại |
| 📝 Điền form | `Alt+3` | Chỉ điền form checkout |
| 🔍 Chỉ Hunt | — | Săn vé, navigate vào booking rồi dừng |
| ⏹ Dừng Hunt | — | Dừng poller + clicker |

### Flow tự động (Alt+1)

```
Bấm Alt+1
    ↓
Hunt: Poll API mỗi 200-300ms
    ↓ (khi có vé)
Direct nav vào /booking/ hoặc /select-ticket
    ↓ (nếu bị queue → chờ tối đa 120s)
Chọn ghế (Konva click / Seats.io select)
    ↓ (nếu thất bại → toast thông báo, user tự chọn)
Click Tiếp tục / Thanh toán
    ↓
Tự điền form checkout
```

---

## Chi tiết kỹ thuật

### Hunt 1Zone
- Poll `https://prod.1zone.vn/ticketing/api/v4/ticket-summary/get-summary-event/{eventId}?type=group&calendarId={id}` mỗi **200ms**
- Khi `availableTickets > 0` → `location.href = /booking/{slug}?calendarId={id}`
- Queue-aware: chờ DOM detect thoát queue tối đa **120s**, không reload không click
- Fallback JS Clicker: nếu không lấy được booking URL hoặc direct nav fail → inject MutationObserver + setInterval(150ms) click nút "Mua vé"

### Hunt Ticketbox
- Poll `https://api-v2.ticketbox.vn/gin/api/v2/events/{eventId}` mỗi **300ms**
- Tìm showing tốt nhất: ưu tiên `isSalable=true` + cùng ngày + id lớn hơn
- Direct nav: GET showings → GET seatmap → `location.href = /events/{id}/bookings/{showingId}/select-ticket`
- State detection sau navigate: `queue | captcha | select | form`
- Queue-aware: chờ tối đa **180s**

### Konva Click (1Zone seat_zone, Ticketbox seat_zone)
- Dùng `chrome.scripting.executeScript` với `world: "MAIN"` để truy cập `window.Konva` thật
- Không bị CSP chặn (khác với script injection)
- Tọa độ: `viewportX = box.left + (konvaX / stageW) * box.width`
- Thử nhiều điểm click, detect dialog/popup mở là thành công

### Seats.io (1Zone seat_map)
- Truy cập `window.seatsio.charts[0]` qua `executeScript`
- Label format: `{zoneName}-{rowName}-{code}` (ví dụ: `CUỐN LẤY ANH ĐI-M-18`)
- Retry loop: nếu ghế bị "Ignoring" (hết/held) → bỏ qua, thử cụm ghế tiếp theo
- Tối đa 30 lần retry

### Zone Matching
- Token-based: `VIP` không match `VIP A`, phải match đúng token
- Score: exact = 1000, partial = 700-850
- Ưu tiên theo thứ tự danh sách config

---

## Nguyên tắc kỹ thuật quan trọng

1. **Không POST add-to-cart trực tiếp** — luôn click button UI thật để frontend tự sinh Turnstile token
2. **Không dùng CDP/Playwright** — Extension chạy trong Chrome thật, có đầy đủ cookie/session
3. **executeScript world=MAIN** — bypass CSP để truy cập window.Konva, window.seatsio
4. **element.click() thay vì MouseEvent** — React synthetic event system nhận được
5. **Queue-aware** — không reload, không click, chờ redirect tự nhiên

---

## Trạng thái các module

| Module | Platform | Trạng thái |
|---|---|---|
| Hunt + API Poller | 1Zone | ✅ Hoàn chỉnh |
| Hunt + API Poller | Ticketbox | ✅ Hoàn chỉnh |
| seat_zone (Konva) | 1Zone | ✅ Hoàn chỉnh |
| seat_map (Seats.io) | 1Zone | ✅ Hoàn chỉnh |
| seat_zone (Konva) | Ticketbox | ✅ Hoàn chỉnh |
| seat_map | Ticketbox | ✅ Hoàn chỉnh |
| Form fill | 1Zone | ✅ Hoàn chỉnh |
| Form fill | Ticketbox | ✅ Hoàn chỉnh |
| Auto hunt → seat → form | Cả 2 | ✅ Hoàn chỉnh |

---

## Debug

### Console Chrome (F12, filter `[SVP]`)

```
[SVP] ✅ Săn Vé Pro v2.0.0 injected
[SVP] 🏹 Bắt đầu Hunt: 1Zone (+ auto chọn ghế)
[SVP] 📡 API Poller — poll mỗi 200ms
[SVP] 🎯 10 vé available! Chuyển sang direct nav...
[SVP] 🎯 Hunt flag detected — tự động chạy seat selector...
[SVP] 🔎 Konva zone: HIÊN 1 | candidates=18
[SVP] ✅ Popup quantity đã mở: HIÊN 1
[SVP] ✅ Quantity đúng: 2
[SVP] ✅ Turnstile token ready: len=1050
[SVP] ✅ Đã navigate sang checkout
[SVP] 📝 Tự động điền form checkout...
[SVP] ✅ Đã điền form 1Zone
```

### Red-dot test (kiểm tra tọa độ Konva)

Chạy trong Console khi đang ở trang booking:

```js
(() => {
  const TARGET = "HIÊN 1";
  const stage = window.Konva?.stages?.[0];
  if (!stage) return console.log("NO_STAGE");
  const node = stage.find("Path").find(p =>
    !p.attrs?.disabled &&
    String(p.attrs?.text || "").toUpperCase().includes(TARGET.toUpperCase())
  );
  if (!node) return console.log("ZONE_NOT_FOUND");
  const box = stage.container().getBoundingClientRect();
  const r = node.getClientRect();
  const vx = box.left + (r.x + r.width/2) / stage.width() * box.width;
  const vy = box.top  + (r.y + r.height/2) / stage.height() * box.height;
  const dot = Object.assign(document.createElement("div"), {
    style: `position:fixed;left:${vx}px;top:${vy}px;width:16px;height:16px;
            background:red;border-radius:50%;z-index:999999;
            pointer-events:none;transform:translate(-50%,-50%)`
  });
  document.body.appendChild(dot);
  console.log("Red dot tại:", { vx, vy });
})();
```

### Đổi phím tắt

Vào `chrome://extensions/shortcuts` để remap `Alt+1/2/3`.

---

## Known Issues

- **Double log**: Mỗi dòng log hiện 2 lần do extension inject content script 2 lần (1 lần ở trang event, 1 lần ở trang booking). Không ảnh hưởng đến kết quả, đang nghiên cứu fix.
- **Seats.io "Ignoring selection"**: Ghế đã sold/held — bot tự động bỏ qua và thử ghế tiếp theo.
- **Turnstile**: Cần chờ token load (~3-5s) trước khi click Tiếp tục — bình thường.
