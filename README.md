# Săn Vé Pro v2.0

Bot tự động săn và mua vé concert/sự kiện trên **1Zone** và **Ticketbox**, chạy trực tiếp trong Chrome thông qua Extension. Không cần Playwright, không cần Chrome flag đặc biệt — extension đọc cookie/session sẵn có của user.

**Tốc độ reserve thực đo:**
- **Ticketbox API-first: ~235ms** (vs Konva click cũ ~3-5s, nhanh hơn 15-20x)
- **1Zone Tier P: ~3-5s** (bottleneck là Turnstile, không thể bypass)

---

## ✨ Tính năng đã hoàn chỉnh

| Module | Platform | Status |
|---|---|---|
| Hunt poll API + queue-aware | 1Zone | ✅ |
| Hunt poll API + queue-aware | Ticketbox | ✅ |
| Reserve API-first (submit-ticket-info) | Ticketbox | ✅ 235ms |
| Reserve hybrid (Konva click + frontend sign) | 1Zone | ✅ |
| XHR hook capture orderId/bookingCode | Cả 2 | ✅ |
| Konva fallback khi API fail | Ticketbox | ✅ |
| Auto navigate checkout + fill form | Cả 2 | ✅ |
| Captcha pause gate (chờ user solve) | Ticketbox | ✅ |
| Stop hunt signal (dừng tức thì) | Cả 2 | ✅ |
| Desktop UI: clock realtime sync time.is | — | ✅ |
| Desktop UI: reserve card hiển thị bookingCode + countdown | — | ✅ |
| Desktop UI: tokens card hiển thị JWT + captcha cache | — | ✅ |
| Popup clock realtime | — | ✅ |
| Log mask PII (token/email/phone) | — | ✅ |

## 🚫 Tính năng KHÔNG làm + lý do

| Tính năng | Lý do |
|---|---|
| Ticketbox extension tự refresh access_token | Endpoint `/refresh_token` có field `signature` SHA-256 unknown algorithm — frontend tự handle |
| 1Zone Tier E3 (mutate body để bypass UI click) | Phase A1 test 2026-05-23: `x-signature` cover body bytes, mutation → 401 |
| Captcha overlay UI custom | Ticketbox cache token 1h trong `tkc_xxx` — solve 1 lần dùng nhiều giờ |
| Auto thanh toán | Payment luôn user-in-the-loop để tránh charge nhầm |

---

## 🏗 Kiến trúc tổng quan

```
┌─────────────────────────┐          ┌──────────────────────────────────────┐
│  Desktop App (Python)   │          │  Chrome Extension (MV3)              │
│  ─────────────────────  │          │  ──────────────────────────────────  │
│  CustomTkinter UI       │          │  background.js (service worker)      │
│  • Tab Chọn Vé          │  HTTP    │  • Inject content scripts            │
│  • Tab Thông Tin        │ ◄──────► │  • Inject MAIN world hook            │
│  • Reserve card         │  port    │  • Relay log + event tới desktop     │
│  • Tokens card          │  9279    │  • Keyboard shortcuts Alt+1/2/3      │
│  • Clock sync time.is   │          └──────────────┬───────────────────────┘
│  • Log realtime         │                         │ executeScript
└─────────────────────────┘                         ▼
                                     ┌──────────────────────────────────────┐
                                     │  Per-tab scripts                     │
                                     │  ──────────────────────────────────  │
                                     │  MAIN world (page context):          │
                                     │    page_bridge.js — postMessage      │
                                     │    network_hook.js — patch XHR+fetch │
                                     │                                      │
                                     │  Isolated world (content):           │
                                     │    runner.js — điều phối trung tâm   │
                                     │    page_bridge_client.js — relay     │
                                     │    platforms/1zone/* — flow 1Zone    │
                                     │    platforms/ticketbox/* — flow TB   │
                                     └──────────────────────────────────────┘
```

### Chiến lược 2 platform

| | Ticketbox | 1Zone |
|---|---|---|
| Strategy | **Pure API-first** | **Hybrid frontend-hook** |
| Token | `TBoxJWT` cookie (TTL 120s, frontend tự refresh) | JWT localStorage + Turnstile + `x-signature` |
| Reserve | `POST /event/api/v1/bookings/submit-ticket-info` direct | Click UI → frontend tự sign + send |
| Fallback | Konva click cũ | (Konva LÀ flow chính) |
| Output | `bookingCode` | `orderId` |
| Latency | ~235ms | ~3-5s |

---

## 📂 Cấu trúc thư mục chi tiết

```
SanVePro_v2/
│
├── README.md                              # File này
├── .gitignore                             # Loại trừ logs, config user, HAR file
│
├── app/                                   # ── DESKTOP APP (Python) ──
│   ├── main.py                            # Toàn bộ desktop: UI + API server + time sync
│   ├── requirements.txt                   # customtkinter
│   └── config.json                        # Config user (gitignored, tự tạo)
│
├── extension/                             # ── CHROME EXTENSION (MV3) ──
│   ├── manifest.json                      # Permissions, web_accessible_resources
│   ├── icons/                             # icon16/48/128.png
│   └── src/
│       ├── background/
│       │   └── background.js              # Service worker — inject orchestrator
│       │                                  #   + Poll config /3s, relay log/event
│       │                                  #   + 2-step inject (MAIN trước, content sau)
│       │
│       ├── popup/
│       │   ├── popup.html                 # Toolbar UI (icon extension)
│       │   └── popup.js                   # Control panel + clock realtime
│       │
│       ├── utils/
│       │   └── mask.js                    # PII/token mask helpers (maskToken/Email/Phone)
│       │
│       ├── shared/
│       │   └── logger.js                  # svpLog + svpEvent (structured)
│       │                                  #   tự mask trước khi gửi background
│       │
│       ├── injected/                      # ── MAIN WORLD (page context) ──
│       │   ├── page_bridge.js             # Bridge bằng window.postMessage
│       │   └── network_hook.js            # Patch fetch + XMLHttpRequest
│       │                                  #   Match URL patterns, emit event
│       │
│       ├── content/                       # ── ISOLATED WORLD ──
│       │   ├── runner.js                  # Entry orchestrator
│       │   │                              #   - Message router (HUNT/RUN/STOP)
│       │   │                              #   - Hunt flag handler post-navigate
│       │   │                              #   - Indicator badge + toast
│       │   │                              #   - SPA navigation watcher
│       │   ├── page_bridge_client.js      # Receive postMessage từ MAIN world
│       │   │                              #   Forward bridge event lên background
│       │   ├── utils.js                   # sleep, normText, realClick, detectPlatform
│       │   │                              #   + svpShouldStop / svpRequestStop
│       │   ├── api.js                     # Legacy API helpers (1Zone + TB)
│       │   ├── zone_matcher.js            # Token-based zone fuzzy match
│       │   ├── konva_clicker.js           # Konva click helpers + runInPage wrapper
│       │   └── form_filler.js             # Auto-fill form checkout (shared 2 platforms)
│       │
│       └── platforms/                     # ── PER-PLATFORM MODULES ──
│           ├── 1zone/
│           │   ├── hunt.js                # Poll summary API 200ms + queue-aware
│           │   ├── xhr_intercept.js       # Capture add-to-cart response → orderId
│           │   ├── seat_zone.js           # Konva click zone → modal qty → Tiếp tục
│           │   └── seat_map.js            # Seats.io chart.trySelectObjects
│           │
│           └── ticketbox/
│               ├── hunt.js                # Poll event API 300ms + queue/captcha detect
│               ├── xhr_intercept.js       # Capture 9 endpoints (login/refresh/captcha/reserve/checkout)
│               ├── token_manager.js       # Read-only TBoxJWT cookie + parse JWT exp
│               │                          #   buildHeaders() cho mọi API call
│               ├── reserve_api.js         # submitTicketInfo() direct POST
│               │                          #   buildZoneItems / buildMapItems helpers
│               ├── captcha.js             # Captcha detector + waitForResolved
│               │                          #   Proactive wait 6s + pause/resume
│               ├── seat_zone.js           # API-first reserve → fallback Konva
│               └── seat_map.js            # API-first reserve → fallback Konva
│
└── tests/
    └── phase_a1_signature_test.js         # Snippet test 1Zone signature (đã chạy 2026-05-23)
                                           # Kết quả: BODY_SIGNED → Tier E3 disable vĩnh viễn
```

### File quan trọng nhất (đọc theo thứ tự)

1. **`app/main.py`** — Desktop entry point, API server port 9279
2. **`extension/manifest.json`** — Permissions + web_accessible_resources
3. **`extension/src/background/background.js`** — Inject orchestrator
4. **`extension/src/content/runner.js`** — Content script entry, message router
5. **`extension/src/platforms/ticketbox/reserve_api.js`** — API-first reserve flow
6. **`extension/src/injected/network_hook.js`** — XHR/fetch patch trong MAIN world

---

## 🚀 Cài đặt

### 1. Desktop App

```powershell
cd app
pip install customtkinter
python main.py
```

→ Khởi động API tại `http://127.0.0.1:9279`

### 2. Chrome Extension

1. Mở `chrome://extensions/`
2. Bật **Developer mode** (góc trên phải)
3. Click **Load unpacked** → chọn thư mục `extension/`
4. Pin icon extension cho dễ access

### 3. Phím tắt (mặc định)

| Phím | Action |
|---|---|
| `Alt+1` | Hunt + auto chọn ghế + điền form |
| `Alt+2` | Chỉ chọn ghế trên trang hiện tại |
| `Alt+3` | Chỉ điền form checkout |

Đổi tại `chrome://extensions/shortcuts`.

---

## 📋 Cấu hình

Trong Desktop App, điền các field rồi bấm **Lưu config**:

### Tab "Chọn Vé"

| Trường | Mô tả |
|---|---|
| **Nền tảng** | `1Zone` hoặc `Ticketbox` |
| **Kiểu chọn ghế** | `Chọn zone (khu)` hoặc `Chọn ghế cụ thể` |
| **Ưu tiên** | Tên khu / cú pháp ghế (xem dưới) |
| **Số lượng vé** | 1, 2, 3... |
| **Bật bot tự động** | Tick để cho phép Alt+1 chạy auto |

### Tab "Thông Tin"

| Trường | Dùng để |
|---|---|
| Họ tên | Auto-fill form checkout |
| Số điện thoại | Auto-fill form checkout |
| Email | Auto-fill form checkout |
| Địa chỉ | Auto-fill form 1Zone |

### Cú pháp nhập ưu tiên

**Mode `Chọn zone (khu)`** — tên khu, mỗi dòng 1 ưu tiên:
```
HIÊN 1
HIÊN 2
VIP A
```

**Mode `Chọn ghế cụ thể`** — hỗ trợ nhiều dạng:
```
Zone 2                 ← chỉ tên khu (chọn ghế bất kỳ trong khu)
M:18                   ← hàng M, ghế 18
M:15-20                ← hàng M, ghế 15 đến 20
M:18,20,22             ← hàng M, các ghế cụ thể
A-D:5-15               ← hàng A đến D, ghế 5 đến 15
Zone 2|M:8-18          ← khu Zone 2 + hàng M + ghế 8-18
Zone 2|M               ← khu Zone 2 + hàng M (bất kỳ ghế)
M                      ← chỉ hàng M (bất kỳ zone, bất kỳ ghế)
M-19                   ← exact seat M-19
```

---

## 🎯 Flow tự động (Alt+1)

```
Bấm Alt+1 trên tab event
    ↓
Hunt: Poll API mỗi 200-300ms
    ↓ (khi có vé)
Direct nav vào /booking/ hoặc /select-ticket
    ↓ (nếu bị queue → chờ tối đa 120-180s, không reload)
[TICKETBOX]:                          [1ZONE]:
  Captcha gate                         (Không có captcha)
  (chờ user solve nếu hiện)
    ↓                                    ↓
  Try API submit-ticket-info           Konva click zone
  (timeout 1500ms)                       ↓
    ↓ success                          Modal qty → set quantity
  bookingCode capture                    ↓
    ↓                                  Wait Turnstile token
  Navigate question-form                 ↓
                                       Click Tiếp tục
    ↓ fail (fallback)                    ↓
  Konva click → modal qty → Tiếp tục   Hook capture orderId
                                         ↓
    ↓                                  Navigate /checkout?orderId=xxx
  Form auto-fill                         ↓
    ↓                                  Form auto-fill
  User confirm thanh toán              User confirm thanh toán
```

---

## 🔍 Trạng thái thực tế từng platform

### Ticketbox (Production-ready)

```
✅ Hunt poll 300ms detect mở bán
✅ Captcha pause gate (đợi user solve, max 90s)
✅ API-first reserve submit-ticket-info (~235ms)
✅ bookingCode capture từ response trực tiếp
✅ Konva click fallback khi API fail
✅ Navigate question-form auto, form fill auto
✅ Stop signal dừng tức thì
```

**Pre-conditions:**
- Login Ticketbox (cookie TBoxJWT sẵn)
- Solve captcha slide 1 lần / suất diễn (token cache TTL 1h)

### 1Zone (Production-ready)

```
✅ Hunt poll 200ms detect availableTickets > 0
✅ Queue handler tối đa 120s
✅ Konva click zone / Seats.io select seat
✅ Wait Turnstile (~3-5s)
✅ XHR hook capture orderId từ add-to-cart response
✅ Navigate checkout auto
✅ Stop signal dừng tức thì
```

**Pre-conditions:**
- Login 1Zone (JWT trong localStorage)
- Mở tab booking trước (Turnstile cần render trong page thật)

---

## 🛠 Quy tắc kỹ thuật

1. **Page-driven cho cả 2 platform** — fingerprint tự nhiên, ít bị detect bot
2. **Payment luôn user-in-the-loop** — không auto charge để tránh sai vé
3. **Token có TTL ngắn** → frontend tự refresh, extension chỉ đọc
4. **MAIN world XHR hook** — bypass isolated world để patch fetch/XHR thật
5. **Log mask PII** — token/email/phone đều mask trước khi gửi desktop
6. **Stop signal cooperative** — mọi loop dài check `svpShouldStop()` để abort

---

## 🐞 Debug

### Console Chrome (F12, filter `[SVP]`)

```
[SVP] ✅ Săn Vé Pro v2.0.0 injected
[SVP] 🔐 TB token (cookie-based) — hasToken=true valid=true remaining=87s user=4445570
[SVP] 🎫 TB reserve API client loaded
[SVP] 🧩 TB captcha helper loaded (v2)
[SVP] 🏹 Bắt đầu Hunt: Ticketbox (+ auto chọn ghế)
[SVP] 📡 Ticketbox API Poller — poll event mỗi 300ms
[SVP] 🎯 Showing mở bán: 27182005198633 (Mua vé ngay)
[SVP] 🎯 Hunt flag detected — tự động chạy seat selector...
[SVP] 🎫 TB reserve API → tt1070552/sec11416/x1[584860]
[SVP] ✅ TB reserve OK (235ms) — bookingCode=ac2bc08c-... expireIn=899s
[SVP] 🎫 API-first reserve OK
[SVP] 📝 Tự động điền form checkout...
[SVP] ✅ Đã điền form Ticketbox
```

### Desktop App log realtime

Log textbox bên phải, mọi event extension đều forward về (mask PII trước):
```
[23:47:08] 🕐 Time synced (google): offset=-42ms
[23:47:12] [EXT] ✅ Săn Vé Pro v2.0.0 injected
[23:47:13] [EXT] 🎫 TB reserve API → tt1070552/sec11416/x1[584860]
[23:47:13] [EXT] ✅ TB reserve OK (235ms) — bookingCode=ac2bc08c-...
```

### Status snapshot từ extension

Mở Console tab booking (context "Săn Vé Pro" trong dropdown):
```js
window.__SVP_TB_TOKEN__.status()
// → {hasAccessToken, accessTokenValid, accessTokenRemainingMs, userId, ...}

window.__SVP_TB_CAPTCHA__.isVisible()
// → true/false

window.__SVP_HOOK__.status()  // MAIN world context
// → {enabled: true, patterns: [...]}
```

---

## 📚 Tài liệu tham khảo

- **`tests/phase_a1_signature_test.js`** — Snippet test reverse 1Zone signature
- Memory files trong `.claude/memory/`:
  - `project-architecture.md` — Kiến trúc tổng quan
  - `project-roadmap.md` — 5-stage implementation plan
  - `ticketbox-token-format.md` — Cookie schema TBoxJWT chi tiết
  - `onezone-signature-test.md` — Kết quả Phase A1
  - `stage1/3/4_done.md` — Tracking các milestone

---

## 📊 Performance benchmark thực đo (2026-05-24)

| Operation | Latency |
|---|---|
| Hunt poll cycle (Ticketbox) | 300ms |
| Hunt poll cycle (1Zone) | 200ms |
| API reserve Ticketbox | **235ms** |
| Konva click reserve (1Zone) | 3-5s |
| Captcha gate proactive wait | 6s |
| Captcha solved → bot resume | 600-800ms |
| Stop hunt signal → all loops abort | <1s |
| Time sync (HTTP Date Google) | 1-2s mỗi 60s |

---

## ⚠️ Known Limitations

| Issue | Workaround |
|---|---|
| Token Ticketbox expire trong flight (>30s idle) | Reload tab để frontend tự refresh |
| Captcha hết TTL 1h | Solve lại slide trên frontend |
| Hook fetch broken trên Ticketbox (Next.js override) | XHR hook vẫn alive → reserve responses vẫn capture |
| Cloudflare/Ticketbox bot detect | Page-driven approach giảm rủi ro nhưng không zero |
| 1Zone bundle deploy đổi DOM/Konva | Có Konva fallback nhưng vẫn cần test lại |

---

## 🗺 Roadmap tiếp theo (optional)

| Việc | Effort | Status |
|---|---|---|
| Test E2E nhiều scenarios (race, alternates) | 1 ngày | Pending |
| Wire alternates config vào seat_*.js | 2-3 giờ | Pending |
| 1Zone fast paths (E1/E2/E4) | 1-2 tuần | Deferred (ROI thấp) |
| Multi-account support | 3-5 ngày | Future |
| Cloud sync config | 2-3 ngày | Future |
