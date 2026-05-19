# Săn Vé Pro v2.0 — Desktop App + Chrome Extension

## Cấu trúc dự án

```
sanve/
├── app/
│   ├── main.py           ← Desktop App (chạy cái này)
│   ├── requirements.txt
│   └── config.json       ← tự tạo khi lưu lần đầu
└── extension/
    ├── manifest.json
    ├── icons/            ← tự tạo icon (xem bên dưới)
    └── src/
        ├── background/
        │   └── background.js
        ├── content/
        │   ├── utils.js
        │   ├── api.js
        │   ├── zone_matcher.js
        │   ├── konva_clicker.js
        │   ├── seat_1zone_zone.js
        │   ├── seat_1zone_map.js
        │   ├── seat_ticketbox_zone.js
        │   ├── seat_ticketbox_map.js
        │   ├── form_filler.js
        │   └── runner.js
        └── popup/
            ├── popup.html
            └── popup.js
```

---

## Cài đặt

### 1. Desktop App

```bash
cd app
pip install -r requirements.txt
python main.py
```

App sẽ tự khởi động **localhost API tại port 9279**.

### 2. Tạo icon cho Extension (bắt buộc để load)

Tạo thư mục `extension/icons/` và thêm 3 file PNG:
- `icon16.png` — 16×16px
- `icon48.png` — 48×48px
- `icon128.png` — 128×128px

Tạm thời có thể dùng bất kỳ file PNG nào rename lại.

Hoặc chạy script Python nhanh:
```python
from PIL import Image, ImageDraw
import os
os.makedirs("extension/icons", exist_ok=True)
for sz in [16, 48, 128]:
    img = Image.new("RGBA", (sz, sz), (251, 191, 36, 255))
    img.save(f"extension/icons/icon{sz}.png")
print("Done")
```

### 3. Load Extension vào Chrome

1. Mở Chrome → `chrome://extensions/`
2. Bật **Developer mode** (góc trên phải)
3. Click **Load unpacked**
4. Chọn thư mục `extension/`
5. Extension xuất hiện với icon vàng

---

## Cách dùng

### Bước 1 — Cấu hình trong Desktop App

Điền đầy đủ:
- Họ tên, SĐT, email, địa chỉ (dùng khi fill form checkout)
- **Platform**: 1Zone hoặc Ticketbox
- **Kiểu chọn vé**: `seat_zone` (chọn khu) hoặc `seat_map` (chọn ghế cụ thể)
- **Ưu tiên zone**: mỗi dòng một zone, ví dụ:
  ```
  HIÊN 1
  HIÊN 2
  HIÊN 3
  ```
  Hoặc cho seat_map:
  ```
  M:20
  M:18,20
  K-O:18-20
  ```
- **Số lượng**: 1, 2, 3...
- Bấm **Lưu config**

### Bước 2 — Bật bot

Tick **Bật bot tự động** → Lưu config

### Bước 3 — Mở trang vé

Vào trang 1Zone hoặc Ticketbox trong Chrome. Extension tự detect trang và chạy khi vào đúng trang booking.

### Bước 4 — Kiểm tra log

- Log hiện trong **console Chrome** (F12 → Console, filter `[SVP]`)
- Log gửi về Desktop App (panel phải)

### Chạy ngay thủ công

Click icon extension → Bấm **▶ Chạy ngay**

---

## Flow hoạt động

```
Desktop App (port 9279)
    ↓ config (GET /config mỗi 3s)
Extension background.js
    ↓ broadcast config
Content script (runner.js)
    ↓ detect platform + page
    ↓ route đúng flow
    ├── 1Zone seat_zone → seat_1zone_zone.js
    │     API zones → Konva click → popup → Turnstile → Tiếp tục
    ├── 1Zone seat_map → seat_1zone_map.js
    │     API tickets → Seats.io select → click Thanh toán
    ├── Ticketbox seat_zone → seat_ticketbox_zone.js
    │     API sections → Konva click → popup qty → Continue
    └── Ticketbox seat_map → seat_ticketbox_map.js
          API seatmap → click từng ghế → Continue

Checkout page → form_filler.js tự điền thông tin
```

---

## Nguyên tắc kỹ thuật giữ nguyên từ v1

1. **Không POST API mua vé trực tiếp** — Konva/Seats.io click để frontend sinh token
2. **Click bằng MouseEvent thật** — không dùng `.click()` trực tiếp trên canvas
3. **Map tọa độ Konva → viewport** theo công thức Ticketbox đã xác nhận:
   ```js
   viewportX = stageBox.left + (konvaX / stageW) * stageBox.width
   viewportY = stageBox.top  + (konvaY / stageH) * stageBox.height
   ```
4. **Popup 1Zone chỉ nhận là thật** khi có `btn-add` + `btn-continue` + kích thước > 180px
5. **Zone matching chặt**: VIP không ăn SVIP, match theo token

---

## Debug

Mở Console Chrome (F12), filter `[SVP]`:

```
[SVP] ⚙️ Config loaded | platform=1Zone | enabled=true
[SVP] 🪑 Route: 1Zone + seat_zone
[SVP] 🔎 eventId=H2TBR7 | calendarId=AlumUr
[SVP] 📡 GET zones API...
[SVP] 📋 Zone còn vé: HIÊN 1 (10), HIÊN 2 (10)
[SVP] 🧭 Match zone: HIÊN 1 | zoneId=69f0...
[SVP] 🔎 Konva zone: HIÊN 1 | candidates=20
[SVP] 🎯 Thử click: mode=SCALED_center point=(426.7,654.0) hit=CANVAS
[SVP] ✅ Popup mở: HIÊN 1
[SVP] ✅ Quantity đúng: 1
[SVP] ✅ Turnstile token ready: len=1050
[SVP] 🖱️ Click Tiếp tục
[SVP] ✅ Đã click Tiếp tục — chờ checkout...
```

**Nếu popup không mở**: Chạy red-dot test trong console:
```js
(() => {
  const TARGET = "HIÊN 1";
  const stage = window.Konva?.stages?.[0];
  if (!stage) return console.log("NO_STAGE");
  const node = stage.find("Path").find(p => !p.attrs?.disabled && String(p.attrs?.text||"").toUpperCase().includes(TARGET.toUpperCase()));
  if (!node) return console.log("ZONE_NOT_FOUND");
  const box = stage.container().getBoundingClientRect();
  const r = node.getClientRect();
  const vx = box.left + (r.x + r.width/2) / stage.width() * box.width;
  const vy = box.top  + (r.y + r.height/2) / stage.height() * box.height;
  const dot = Object.assign(document.createElement("div"), {style: `position:fixed;left:${vx}px;top:${vy}px;width:16px;height:16px;background:red;border-radius:999px;z-index:999999;pointer-events:none;transform:translate(-50%,-50%)`});
  document.body.appendChild(dot);
  console.log({vx, vy});
})();
```

---

## Trạng thái các module

| Module | Trạng thái |
|---|---|
| 1Zone seat_zone | ✅ Hoàn chỉnh |
| 1Zone seat_map | ✅ Cơ bản hoạt động |
| Ticketbox seat_zone | ✅ Hoàn chỉnh |
| Ticketbox seat_map | ✅ Cơ bản hoạt động |
| Fill form | ✅ Cả 2 platform |
| Desktop App UI | ✅ Mới, gọn hơn |
| Localhost API | ✅ Port 9279 |
