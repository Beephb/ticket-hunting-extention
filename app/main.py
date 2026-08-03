# main.py — Săn Vé Pro v2.0
# Desktop App: Tab Chọn Vé (chính) + Tab Thông Tin + Log panel

import json
import os
import sys
import secrets
import threading
import logging
import http.client
import webbrowser
import base64
import io
import tempfile
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from tkinter import messagebox
from datetime import datetime
from email.utils import parsedate_to_datetime
import customtkinter as ctk

# ── Captcha solver imports (optional — graceful fallback nếu chưa cài) ────────
try:
    import numpy as np
    import cv2
    _CV2_AVAILABLE = True
except ImportError:
    _CV2_AVAILABLE = False

try:
    from PIL import Image
    _PIL_AVAILABLE = True
except ImportError:
    _PIL_AVAILABLE = False

# ── Path handling (frozen .exe vs source .py) ────────────────────────────────

def _get_base_dir():
    """Trả về thư mục chứa config.json + hunt.log.
    - Khi chạy từ PyInstaller .exe: cùng folder với .exe (portable)
    - Khi chạy .py trực tiếp: cùng folder main.py
    """
    if getattr(sys, "frozen", False):
        # Running from PyInstaller bundle
        return os.path.dirname(sys.executable)
    return os.path.dirname(os.path.abspath(__file__))

BASE_DIR = _get_base_dir()

# ── Logging ───────────────────────────────────────────────────────────────────

LOG_FILE = os.path.join(BASE_DIR, "hunt.log")

def _setup_logging():
    handler = logging.FileHandler(LOG_FILE, mode="w", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)

_setup_logging()
logger = logging.getLogger(__name__)

CONFIG_FILE = os.path.join(BASE_DIR, "config.json")
API_PORT = 9279

# ── API auth token (handshake-based) ─────────────────────────────────────────
# Mỗi lần app start, gen token mới và lưu vào file. Extension fetch /handshake
# để lấy token, cache lại, dùng trong header X-SVP-Auth cho mọi request sau.
TOKEN_FILE = os.path.join(BASE_DIR, ".api_token")

def _gen_api_token():
    """Generate random 32-char token, persist to file."""
    token = secrets.token_urlsafe(32)  # ~43 chars URL-safe base64
    try:
        with open(TOKEN_FILE, "w", encoding="utf-8") as f:
            f.write(token)
    except Exception as e:
        logger.warning(f"Cannot write {TOKEN_FILE}: {e}")
    return token

API_TOKEN = _gen_api_token()  # NEW token mỗi lần app start

# Endpoints không cần auth (chỉ handshake để extension lấy token lần đầu)
# /solve public vì captcha solver gọi trực tiếp từ content script, không có token
_PUBLIC_ENDPOINTS = {"/handshake", "/ping", "/solve"}

# ── Scan fields state ─────────────────────────────────────────────────────────
_scan_pending = False          # Desktop đang chờ kết quả scan
_scan_result  = None           # Kết quả trả về từ extension
_scan_event   = threading.Event()  # Signal khi có kết quả

# ── Hunt all state ────────────────────────────────────────────────────────────
# Dùng counter thay vì boolean "ăn 1 lần" để nhiều Chrome profile (nhiều extension
# instance cùng poll 1 server) đều nhận được lệnh, không bị race condition mất lệnh.
_hunt_all_version = 0          # Tăng mỗi lần bấm "Chạy tất cả tab"

# ── Mode label mapping (UI tiếng Việt ↔ internal key) ────────────────────────
MODE_LABEL_ZONE = "Chọn zone (khu)"
MODE_LABEL_MAP  = "Chọn ghế cụ thể"
_MODE_LABEL_TO_KEY = {
    MODE_LABEL_ZONE: "seat_zone",
    MODE_LABEL_MAP:  "seat_map",
}
_MODE_KEY_TO_LABEL = {v: k for k, v in _MODE_LABEL_TO_KEY.items()}

def _label_to_mode(label):
    return _MODE_LABEL_TO_KEY.get(label, label if label in ("seat_zone", "seat_map") else "seat_zone")

def _mode_to_label(mode):
    return _MODE_KEY_TO_LABEL.get(mode, MODE_LABEL_ZONE)

# ── Command queue (desktop → extension) ───────────────────────────────────────
# Extension poll GET /command để lấy lệnh chờ.
# Desktop UI hoặc external tool POST /command để push.
_command_queue = []  # list of {id, type, payload, createdAt}
_command_lock = threading.Lock()
_command_seq = 0

# ── Config file lock ──────────────────────────────────────────────────────────
# Bảo vệ chuỗi đọc-sửa-ghi config.json (load_config → sửa → save_config) khỏi
# race condition khi ThreadingHTTPServer xử lý nhiều request POST /config,
# /slots song song (VD nhiều Chrome profile cùng lưu config gần như đồng thời).
_config_lock = threading.Lock()

# ── Extension status tracking ─────────────────────────────────────────────────
import time
_ext_last_ping_ts = 0
_app_started_ts = time.time()

# ── Reserve + token state (Stage 4 polish UI) ────────────────────────────────
_last_reserve = None      # dict: {platform, bookingCode/orderId, expireIn, ts, ...}
_token_status = {}        # {platform: {...status...}}

# ── Time sync (clock chính xác như time.is) ──────────────────────────────────
_time_offset_sec = 0.0    # server_ts - local_ts. Update mỗi 60s
_time_sync_lock = threading.Lock()

def _sync_time_offset():
    """Sync với HTTP Date header từ Google. Trả về (offset_sec, source) hoặc (None, err)."""
    try:
        t_before = time.time()
        conn = http.client.HTTPSConnection("www.google.com", timeout=3)
        conn.request("HEAD", "/")
        resp = conn.getresponse()
        resp.read()
        conn.close()
        t_after = time.time()
        date_hdr = resp.getheader("Date")
        if not date_hdr:
            return None, "no Date header"
        server_dt = parsedate_to_datetime(date_hdr)
        server_ts = server_dt.timestamp()
        # Mid-RTT correction
        local_ts_at_server = (t_before + t_after) / 2
        return server_ts - local_ts_at_server, "google"
    except Exception as e:
        return None, str(e)

def _time_sync_loop():
    global _time_offset_sec
    while True:
        offset, source = _sync_time_offset()
        if offset is not None:
            with _time_sync_lock:
                _time_offset_sec = offset
            if _app_ref:
                _app_ref.after(0, lambda: _app_ref.add_log(
                    f"🕐 Time synced ({source}): offset={offset*1000:.0f}ms", "gray"))
        time.sleep(60)

def _now_synced_ms():
    return time.time() + _time_offset_sec

def _default_seat_cfg():
    return {
        "seat_mode": "seat_zone",
        "zone_priority": [],
        "items": [],  # [{zone, quantity}] — ưu tiên khu vực kèm SL riêng từng khu (seat_zone mode)
        "seat_map_priorities": [],  # [{zone, row, seat_range, parity}]
        "quantity": 1,
        "require_adjacent": True,
        "allow_split_seats": False,
        "allow_partial": False,
    }

DEFAULT_CONFIG = {
    "name": "", "phone": "", "email": "", "address": "",
    "custom_fields": [],  # [{keyword, value}, ...]
    "active_platform": "1Zone",  # tab nào đang được chọn hiển thị cuối cùng trên UI
    "auto_seat": {
        "1zone": _default_seat_cfg(),
        "ticketbox": _default_seat_cfg(),
        "ctiket": _default_seat_cfg(),
    },
    # Seat slots — mỗi slot là 1 bộ auto_seat độc lập (per-tab override)
    # Format: [{"name": "Slot 1", "auto_seat": {...}}, ...]
    "seat_slots": [],
}

_PLATFORM_KEY_MAP = {"1Zone": "1zone", "Ticketbox": "ticketbox", "Ctiket": "ctiket"}

# ── Config helpers ────────────────────────────────────────────────────────────

def load_config():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
    except Exception:
        return json.loads(json.dumps(DEFAULT_CONFIG))  # deep copy

    for k, v in DEFAULT_CONFIG.items():
        if k not in cfg:
            cfg[k] = v if not isinstance(v, dict) else json.loads(json.dumps(v))

    # Migrate config cũ: auto_seat là 1 dict chung (có "platform" + "zone_priority" trực tiếp)
    # → chuyển thành map theo platform, giữ lại đúng platform đang dùng trước đó.
    old_as = cfg.get("auto_seat", {})
    if "platform" in old_as or "zone_priority" in old_as:
        old_platform = old_as.get("platform", "1Zone")
        old_key = _PLATFORM_KEY_MAP.get(old_platform, "1zone")
        new_as = {
            "1zone": _default_seat_cfg(),
            "ticketbox": _default_seat_cfg(),
            "ctiket": _default_seat_cfg(),
        }
        for k in new_as[old_key]:
            if k in old_as:
                new_as[old_key][k] = old_as[k]
        cfg["auto_seat"] = new_as
        cfg["active_platform"] = old_platform

    # Đảm bảo đủ field cho cả 3 platform (phòng trường hợp thêm field mới sau này)
    for pk in ("1zone", "ticketbox", "ctiket"):
        cfg["auto_seat"].setdefault(pk, _default_seat_cfg())
        for k, v in _default_seat_cfg().items():
            cfg["auto_seat"][pk].setdefault(k, v)

    # Đảm bảo seat_slots tồn tại
    cfg.setdefault("seat_slots", [])
    for slot in cfg["seat_slots"]:
        slot.setdefault("name", "Slot")
        slot.setdefault("auto_seat", {
            "1zone": _default_seat_cfg(),
            "ticketbox": _default_seat_cfg(),
            "ctiket": _default_seat_cfg(),
        })
        for pk in ("1zone", "ticketbox", "ctiket"):
            slot["auto_seat"].setdefault(pk, _default_seat_cfg())
            for k, v in _default_seat_cfg().items():
                slot["auto_seat"][pk].setdefault(k, v)

    return cfg

def save_config(cfg):
    # Ghi atomic: dump ra file tạm CÙNG THƯ MỤC rồi os.replace() swap vào chỗ cũ.
    # os.replace() là atomic rename ở filesystem level (cả Windows lẫn POSIX) —
    # loại bỏ hoàn toàn khoảng hở trước đây khi open(..., "w") xoá trắng
    # CONFIG_FILE rồi mới ghi dần nội dung mới: nếu 1 thread khác (GET /config,
    # GET /slots — extension poll mỗi 3s qua ThreadingHTTPServer) đọc đúng lúc
    # đó sẽ dính JSON rỗng/dở dang → json.load() lỗi → load_config() âm thầm
    # trả về DEFAULT_CONFIG, xoá sạch zone_priority/custom_fields/seat_slots
    # đã lưu ngay giữa lúc đang hunt. Dùng tempfile cùng thư mục để đảm bảo
    # os.replace() luôn same-filesystem (bắt buộc để atomic).
    dir_name = os.path.dirname(CONFIG_FILE) or "."
    fd, tmp_path = tempfile.mkstemp(prefix=".config_", suffix=".tmp", dir=dir_name)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(cfg, f, ensure_ascii=False, indent=2)
        os.replace(tmp_path, CONFIG_FILE)
    except Exception:
        try:
            os.remove(tmp_path)
        except Exception:
            pass
        raise

# ── Localhost API ─────────────────────────────────────────────────────────────

_app_ref = None

class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass

    def _send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-SVP-Auth")
            self.end_headers()
            self.wfile.write(body)
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
            # Client (extension) đã đóng connection trước khi server kịp trả lời
            # (thường do AbortSignal.timeout() hết hạn khi app đang bận xử lý
            # burst request). Không phải lỗi thật — bỏ qua, không văng traceback
            # ra console để tránh gây hiểu lầm app đang crash.
            pass

    def do_OPTIONS(self):
        try:
            self.send_response(204)
            self.send_header("Access-Control-Allow-Origin", "*")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
            self.send_header("Access-Control-Allow-Headers", "Content-Type, X-SVP-Auth")
            self.send_header("Access-Control-Max-Age", "600")
            self.end_headers()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError, OSError):
            pass

    def _check_auth(self):
        """Return True if request authorized.
        Public endpoints (/handshake, /ping) bypass auth.
        Mọi endpoint khác cần header X-SVP-Auth khớp API_TOKEN.
        """
        # Bỏ query string nếu có
        path = self.path.split("?", 1)[0]
        if path in _PUBLIC_ENDPOINTS:
            return True
        token = self.headers.get("X-SVP-Auth", "")
        if not token:
            return False
        # Constant-time compare để tránh timing attack
        return secrets.compare_digest(token, API_TOKEN)

    def _send_401(self):
        self._send_json(401, {"error": "unauthorized", "hint": "fetch /handshake first"})

    def do_GET(self):
        global _ext_last_ping_ts
        # Auth gate (trừ /handshake + /ping)
        if not self._check_auth():
            self._send_401()
            return

        if self.path == "/handshake":
            # Trả token cho extension cache
            self._send_json(200, {"token": API_TOKEN, "version": "2.0.0"})
            return
        if self.path == "/config":
            _ext_last_ping_ts = time.time()
            self._send_json(200, load_config())
        elif self.path == "/slots":
            _ext_last_ping_ts = time.time()
            cfg = load_config()
            self._send_json(200, {"slots": cfg.get("seat_slots", [])})
        elif self.path == "/hunt-all":
            _ext_last_ping_ts = time.time()
            # Trả version hiện tại — KHÔNG reset. Mỗi extension client tự so sánh
            # với version đã thấy lần trước (lưu ở chrome.storage.local riêng của
            # từng Chrome profile) để quyết định có broadcast hay không.
            self._send_json(200, {"version": _hunt_all_version})
        elif self.path == "/ping":
            _ext_last_ping_ts = time.time()
            self._send_json(200, {"ok": True})
        elif self.path == "/status":
            # KHÔNG set _ext_last_ping_ts ở đây — /status chỉ ĐỌC trạng thái.
            # Trước đây set rồi tính last_ping_ms ngay từ giá trị vừa set khiến
            # last_ping_ms luôn ≈ 0ms → "extension connected" báo sai, luôn true
            # kể cả khi extension đã ngắt kết nối thật. Timestamp chỉ nên được
            # cập nhật bởi các request THẬT từ extension (/config, /slots,
            # /hunt-all, /ping, /command, /scan-fields/poll).
            now = time.time()
            last_ping_ms = int((now - _ext_last_ping_ts) * 1000) if _ext_last_ping_ts else None
            self._send_json(200, {
                "app": {
                    "version": "2.0.0",
                    "uptimeMs": int((now - _app_started_ts) * 1000),
                },
                "timeOffsetMs": int(_time_offset_sec * 1000),
                "extension": {
                    "connected": last_ping_ms is not None and last_ping_ms < 10000,
                    "lastPingMs": last_ping_ms,
                },
                "ticketbox": {
                    "accessTokenValid": None,
                    "captchaTokenValid": None,
                    "captchaExpireInMs": None,
                },
                "onezone": {
                    "loggedIn": None,
                    "turnstilePoolSize": 0,
                },
                "ctiket": {
                    "loggedIn": None,
                },
                "commandQueueSize": len(_command_queue),
            })
        elif self.path == "/command":
            # Extension long-poll lấy command. Trả ngay (không long-poll thật).
            _ext_last_ping_ts = time.time()
            with _command_lock:
                if _command_queue:
                    cmd = _command_queue.pop(0)
                    self._send_json(200, {"command": cmd})
                else:
                    self._send_json(200, {"command": None})
        elif self.path == "/scan-fields/poll":
            # Extension poll để biết có pending scan không → trả {pending: bool}
            self._send_json(200, {"pending": _scan_pending})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        # Auth gate
        if not self._check_auth():
            self._send_401()
            return

        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            data = {}

        if self.path == "/log":
            msg = str(data.get("msg", ""))
            color = str(data.get("color", "white"))
            tag = data.get("tag") or None
            separator = bool(data.get("separator"))
            logger.info(f"[EXT]{f'[{tag}]' if tag else ''} {msg}")
            if _app_ref:
                if separator:
                    _app_ref.after(0, lambda t=tag: _app_ref.add_log_separator(t))
                else:
                    _app_ref.after(0, lambda m=msg, c=color, t=tag: _app_ref.add_log(m, c, t))
            self._send_json(200, {"ok": True})
        elif self.path == "/event":
            # Structured event từ extension svpEvent() → update UI cards
            self._handle_event(data)
            self._send_json(200, {"ok": True})
            return
        elif self.path == "/command":
            # Desktop UI hoặc tool external POST lệnh vào queue.
            # Body: {"type": "...", "payload": {...}}
            global _command_seq
            cmd_type = str(data.get("type", ""))
            if not cmd_type:
                self._send_json(400, {"error": "type required"})
                return
            with _command_lock:
                _command_seq += 1
                cmd = {
                    "id": _command_seq,
                    "type": cmd_type,
                    "payload": data.get("payload", {}),
                    "createdAt": int(time.time() * 1000),
                }
                _command_queue.append(cmd)
            logger.info(f"[CMD] queued #{cmd['id']} type={cmd_type}")
            self._send_json(200, {"ok": True, "id": cmd["id"]})
        elif self.path == "/config":
            with _config_lock:
                cfg = load_config()
                # LƯU Ý: "auto_seat" bị loại khỏi update() nông ở đây — để khối
                # deep-merge bên dưới là nơi DUY NHẤT ghi vào cfg["auto_seat"].
                # Trước đó "auto_seat" cũng nằm trong DEFAULT_CONFIG nên bị dòng
                # update() này ghi đè NGUYÊN CỤC trước khi deep-merge kịp chạy —
                # khiến deep-merge vô nghĩa (merge pv vào chính pv) và còn tệ hơn
                # bug gốc: xoá sạch luôn các platform khác không có trong data.
                cfg.update({k: v for k, v in data.items()
                            if k in DEFAULT_CONFIG and k != "auto_seat"})
                if "auto_seat" in data and isinstance(data["auto_seat"], dict):
                    # Deep-merge theo từng platform (1zone/ticketbox/ctiket) — tránh
                    # .update() nông xoá mất zone_priority/items/... khi client chỉ
                    # gửi partial data cho 1 platform (vd chỉ {"quantity": 5}).
                    for pk, pv in data["auto_seat"].items():
                        if isinstance(pv, dict):
                            cfg["auto_seat"].setdefault(pk, {}).update(pv)
                        else:
                            cfg["auto_seat"][pk] = pv
                save_config(cfg)
            if _app_ref:
                _app_ref.after(0, _app_ref.load_config_to_ui)
            self._send_json(200, {"ok": True})
        elif self.path == "/slots":
            # POST /slots — update toàn bộ danh sách slots
            # Body: {"slots": [...]}
            slots = data.get("slots")
            if isinstance(slots, list):
                with _config_lock:
                    cfg = load_config()
                    cfg["seat_slots"] = slots
                    save_config(cfg)
                if _app_ref:
                    _app_ref.after(0, _app_ref._reload_slots_ui)
                self._send_json(200, {"ok": True})
            else:
                self._send_json(400, {"error": "slots must be array"})
        elif self.path == "/solve":
            # Captcha solver endpoint — được gọi bởi puzzle-solver.js + rotation-solver.js
            result = _solve_captcha(data)
            self._send_json(200 if result.get("ok") else 500, result)
        elif self.path == "/scan-fields":
            # Extension POST kết quả scan fields về đây
            global _scan_pending, _scan_result
            _scan_result  = data.get("fields", [])
            _scan_pending = False
            _scan_event.set()
            self._send_json(200, {"ok": True})
        else:
            self._send_json(404, {"error": "not found"})

    def _handle_event(self, payload):
        """Dispatch structured event tới UI updater."""
        global _last_reserve, _token_status
        ev = str(payload.get("event", ""))
        data = payload.get("data", {}) or {}
        platform = data.get("platform") or payload.get("platform") or "?"

        if ev == "reserve.success":
            _last_reserve = {
                "platform": platform,
                "mode": data.get("mode"),
                "bookingCode": data.get("bookingCode"),
                "orderId": data.get("orderId"),
                "showingId": data.get("showingId"),
                "eventId": data.get("eventId"),
                "zoneName": data.get("zoneName"),
                "sectionName": data.get("sectionName"),
                "ticketName": data.get("ticketName"),
                "seats": data.get("seats"),
                "quantity": data.get("quantity"),
                "expireIn": data.get("expireIn"),
                "checkoutUrl": data.get("checkoutUrl"),
                "method": data.get("method"),
                "durationMs": payload.get("durationMs"),
                "capturedAt": int(_now_synced_ms() * 1000),
            }
        elif ev == "token.status":
            _token_status[platform] = {
                **{k: v for k, v in data.items() if k != "platform"},
                "updatedAt": int(_now_synced_ms() * 1000),
            }

# ── Captcha Solver (OpenCV) ───────────────────────────────────────────────────

def _b64_to_cv2(b64_str):
    """Decode base64 data URL hoặc chuỗi base64 thuần → numpy array.
    Dùng IMREAD_UNCHANGED để giữ nguyên kênh Alpha (quan trọng cho puzzle slice).
    """
    try:
        if "base64," in b64_str:
            b64_str = b64_str.split("base64,")[1]
        elif "," in b64_str:
            b64_str = b64_str.split(",", 1)[1]
        img_bytes = base64.b64decode(b64_str)
        arr = np.frombuffer(img_bytes, dtype=np.uint8)
        return cv2.imdecode(arr, cv2.IMREAD_UNCHANGED)
    except Exception as e:
        logger.error(f"[CAPTCHA] Lỗi decode base64: {e}")
        return None

def _solve_puzzle(bg_b64, slice_b64):
    """
    Giải captcha mảnh ghép (puzzle slider).
    Dùng kênh Alpha của slice để tạo edge map chính xác hơn.
    Trả về x pixel cần kéo tính theo kích thước ảnh gốc (naturalWidth).
    """
    bg    = _b64_to_cv2(bg_b64)
    piece = _b64_to_cv2(slice_b64)

    if bg is None or piece is None:
        return {"ok": False, "error": "decode ảnh thất bại"}

    # Xử lý ảnh nền
    if len(bg.shape) == 3 and bg.shape[2] == 4:
        bg_gray = cv2.cvtColor(bg[:, :, :3], cv2.COLOR_BGR2GRAY)
    else:
        bg_gray = cv2.cvtColor(bg, cv2.COLOR_BGR2GRAY)
    bg_blur  = cv2.GaussianBlur(bg_gray, (3, 3), 0)
    bg_edges = cv2.Canny(bg_blur, 100, 200)

    # Xử lý mảnh ghép — ưu tiên kênh Alpha để bóc tách hình dáng chính xác
    if len(piece.shape) == 3 and piece.shape[2] == 4:
        slice_edges = cv2.Canny(piece[:, :, 3], 100, 200)
    else:
        slice_gray  = cv2.cvtColor(piece, cv2.COLOR_BGR2GRAY)
        slice_blur  = cv2.GaussianBlur(slice_gray, (3, 3), 0)
        slice_edges = cv2.Canny(slice_blur, 100, 200)

    # Template matching
    result = cv2.matchTemplate(bg_edges, slice_edges, cv2.TM_CCOEFF_NORMED)

    # Bảo vệ chống lỗi rìa trái (x=0 thường là false positive)
    if result.shape[1] > 25:
        result[:, :25] = -1

    _, _, _, max_loc = cv2.minMaxLoc(result)
    x = int(max_loc[0])
    return {"ok": True, "x": x}

def _solve_rotation(images_b64):
    """
    Giải captcha xoay tròn (Ticketbox style).
    Thuật toán Linear Polar Warp: biến đổi hệ tọa độ cực giúp chuyển
    chuyển động xoay tròn thành dịch chuyển tịnh tiến theo chiều dọc,
    sau đó dùng template matching để tìm độ lệch góc.
    """
    if len(images_b64) < 2:
        return {"ok": False, "error": "cần ít nhất 2 ảnh (bg + fg)"}

    img_bg     = _b64_to_cv2(images_b64[0])
    img_target = _b64_to_cv2(images_b64[1])

    if img_bg is None or img_target is None:
        return {"ok": False, "error": "decode ảnh thất bại"}

    # Chuyển sang grayscale, xử lý cả ảnh có kênh Alpha
    def to_gray(img):
        if len(img.shape) == 3 and img.shape[2] == 4:
            return cv2.cvtColor(img[:, :, :3], cv2.COLOR_BGR2GRAY)
        return cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    gray_bg     = to_gray(img_bg)
    gray_target = to_gray(img_target)

    # Đồng bộ kích thước
    h, w = gray_bg.shape[:2]
    gray_target = cv2.resize(gray_target, (w, h))

    # Xác định tâm và bán kính quét cực tối đa
    center     = (w // 2, h // 2)
    max_radius = min(w, h) // 2

    # Warp Polar: biến hình tròn → dải hình chữ nhật phẳng
    # Góc xoay (0-360°) → tọa độ Y trên ảnh kết quả
    flags      = cv2.WARP_POLAR_LINEAR + cv2.INTER_LINEAR
    polar_bg     = cv2.warpPolar(gray_bg,     (w, h), center, max_radius, flags)
    polar_target = cv2.warpPolar(gray_target, (w, h), center, max_radius, flags)

    # Nhân đôi ảnh nền theo chiều dọc để xử lý trường hợp góc vượt biên chu kỳ
    polar_bg_ext = np.vstack([polar_bg, polar_bg])

    # Template matching tìm độ dịch chuyển theo trục Y
    res = cv2.matchTemplate(polar_bg_ext, polar_target, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(res)

    y_offset = max_loc[1]

    # Quy đổi pixel dịch chuyển dọc → góc độ (h pixel = 360°)
    angle = (y_offset / h) * 360
    angle = int(angle % 360)

    logger.info(f"[CAPTCHA/rotation] angle={angle}° y_offset={y_offset} score={max_val:.4f}")
    return {"ok": True, "angle": angle}

def _solve_captcha(data):
    """Router chính — phân loại puzzle vs rotation rồi dispatch."""
    if not _CV2_AVAILABLE:
        return {"ok": False, "error": "opencv-python chưa được cài. Chạy: pip install opencv-python numpy"}

    captcha_type = str(data.get("type", "")).lower()

    try:
        if captcha_type == "puzzle":
            bg    = data.get("bg", "")
            slice_ = data.get("slice", "")
            if not bg or not slice_:
                return {"ok": False, "error": "thiếu trường 'bg' hoặc 'slice'"}
            return _solve_puzzle(bg, slice_)

        elif captcha_type == "rotation":
            images = data.get("images", [])
            if not images:
                return {"ok": False, "error": "thiếu trường 'images'"}
            return _solve_rotation(images)

        else:
            return {"ok": False, "error": f"type không hợp lệ: '{captcha_type}' (dùng 'puzzle' hoặc 'rotation')"}

    except Exception as e:
        logger.error(f"[CAPTCHA] Lỗi solve: {e}")
        return {"ok": False, "error": str(e)}


def start_api_server():
    # ThreadingHTTPServer: mỗi request xử lý trên 1 thread riêng, tránh 1 request
    # chậm (VD /solve dùng cv2) làm nghẽn toàn bộ request khác đang chờ — quan
    # trọng khi có nhiều tab/nhiều Chrome profile cùng poll liên tục mỗi 3s.
    server = ThreadingHTTPServer(("127.0.0.1", API_PORT), _Handler)
    server.daemon_threads = True  # thread con tự chết theo process chính, tránh treo khi thoát app
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server

# ── Theme ─────────────────────────────────────────────────────────────────────

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("dark-blue")

C_BG      = "#0f172a"
C_PANEL   = "#111827"
C_PANEL2  = "#0d1117"
C_ACCENT  = "#fbbf24"
C_OK      = "#22c55e"
C_ERR     = "#ef4444"
C_MUTED   = "#64748b"
C_TEXT    = "#e2e8f0"
C_BORDER  = "#1e293b"

LOG_COLORS = {
    "green": C_OK, "red": C_ERR, "yellow": "#facc15",
    "blue": "#38bdf8", "white": C_TEXT, "gray": C_MUTED,
}

# ── Seat Map Priority Row ─────────────────────────────────────────────────────

class SeatMapRow(ctk.CTkFrame):
    # Parity dropdown — hiển thị tiếng Việt, internal value là suffix cho config
    PARITY_LABELS = ["Bất kỳ", "Lẻ", "Chẵn"]
    _PARITY_TO_SUFFIX = {"Bất kỳ": "", "Lẻ": "odd", "Chẵn": "even"}
    _SUFFIX_TO_PARITY = {"": "Bất kỳ", "odd": "Lẻ", "even": "Chẵn"}

    def __init__(self, parent, on_delete, **kwargs):
        super().__init__(parent, fg_color=C_PANEL2, corner_radius=8, **kwargs)
        self.on_delete = on_delete
        # 5 columns: Khu | Hàng | Ghế số | Lẻ/Chẵn | SL   + nút xóa
        self.grid_columnconfigure((0,1,2,3), weight=1)
        self.grid_columnconfigure(4, weight=0)

        # Khu
        ctk.CTkLabel(self, text="Khu", font=("Arial", 10), text_color=C_MUTED
                     ).grid(row=0, column=0, padx=(8,2), pady=(6,0), sticky="w")
        self.inp_zone = ctk.CTkEntry(self, placeholder_text="VD: VIP A", height=30,
                                      font=("Arial", 11))
        self.inp_zone.grid(row=1, column=0, padx=(8,2), pady=(0,6), sticky="ew")

        # Hàng
        ctk.CTkLabel(self, text="Hàng", font=("Arial", 10), text_color=C_MUTED
                     ).grid(row=0, column=1, padx=2, pady=(6,0), sticky="w")
        self.inp_row = ctk.CTkEntry(self, placeholder_text="VD: M hoặc A-D", height=30,
                                     font=("Arial", 11))
        self.inp_row.grid(row=1, column=1, padx=2, pady=(0,6), sticky="ew")

        # Ghế số
        ctk.CTkLabel(self, text="Ghế số", font=("Arial", 10), text_color=C_MUTED
                     ).grid(row=0, column=2, padx=2, pady=(6,0), sticky="w")
        self.inp_seat = ctk.CTkEntry(self, placeholder_text="VD: 18 hoặc 15-20", height=30,
                                      font=("Arial", 11))
        self.inp_seat.grid(row=1, column=2, padx=2, pady=(0,6), sticky="ew")

        # Parity (Lẻ / Chẵn / Bất kỳ) — giúp event VN có ghế split parity
        ctk.CTkLabel(self, text="Lẻ/Chẵn", font=("Arial", 10), text_color=C_MUTED
                     ).grid(row=0, column=3, padx=2, pady=(6,0), sticky="w")
        self.sel_parity = ctk.CTkOptionMenu(
            self, values=self.PARITY_LABELS,
            height=30, font=("Arial", 11), width=140,
        )
        self.sel_parity.set("Bất kỳ")
        self.sel_parity.grid(row=1, column=3, padx=2, pady=(0,6), sticky="ew")

        # SL — số lượng riêng cho dòng ưu tiên này
        ctk.CTkLabel(self, text="SL", font=("Arial", 10), text_color=C_MUTED
                     ).grid(row=0, column=4, padx=2, pady=(6,0), sticky="w")
        self.inp_qty = ctk.CTkEntry(self, placeholder_text="1", height=30,
                                     font=("Arial", 11), width=50)
        self.inp_qty.grid(row=1, column=4, padx=2, pady=(0,6), sticky="ew")

        # Nút xóa (column 5)
        ctk.CTkButton(self, text="✕", width=28, height=28, fg_color="#374151",
                      hover_color="#4b5563", font=("Arial", 11),
                      command=self._delete
                      ).grid(row=0, column=5, rowspan=2, padx=(4,8), pady=4)

    def _delete(self):
        self.destroy()
        self.on_delete()

    def get_value(self):
        zone  = self.inp_zone.get().strip()
        row   = self.inp_row.get().strip().upper()
        seat  = self.inp_seat.get().strip()
        parity_suffix = self._PARITY_TO_SUFFIX.get(self.sel_parity.get(), "")
        try:
            qty = int(self.inp_qty.get().strip())
        except Exception:
            qty = 1
        qty = max(1, qty)

        # FIX bug: có "Ghế số" nhưng bỏ trống "Hàng" → dòng này sẽ bị BỎ QUA
        # khi lưu (không có Hàng thì không build được raw hợp lệ). Trước đây
        # mất trắng không báo gì — giờ viền dòng chuyển ĐỎ để cảnh báo ngay
        # trên UI (self._save_seat_config_for cũng log cảnh báo khi lưu).
        if seat and not row:
            self.configure(border_width=2, border_color="#ef4444")
        else:
            self.configure(border_width=0)

        # Build priority string theo format seat_map
        # Cú pháp mở rộng: <row>:<seat>[:odd|:even]
        raw = ""
        if row and seat:
            s = f"{row}:{seat}"
            if parity_suffix:
                s = f"{s}:{parity_suffix}"
            raw = f"{zone}|{s}" if zone else s
        elif row and not seat:
            # Chỉ row + parity → "K:*:odd"
            if parity_suffix:
                s = f"{row}:*:{parity_suffix}"
                raw = f"{zone}|{s}" if zone else s
            else:
                raw = f"{zone}|{row}" if zone else row
        elif zone and not row and not seat:
            raw = zone

        if not raw:
            return None
        return {"raw": raw, "quantity": qty}

    def has_orphan_seat(self):
        """True nếu có 'Ghế số' nhưng bỏ trống 'Hàng' — dòng này bị bỏ qua khi lưu."""
        return bool(self.inp_seat.get().strip() and not self.inp_row.get().strip())

    def set_value(self, val):
        # Chấp nhận dict mới {"raw":.., "quantity":..} hoặc string cũ (migrate)
        if isinstance(val, dict):
            raw = str(val.get("raw", ""))
            qty = val.get("quantity", 1)
        else:
            raw = str(val or "")
            qty = 1

        self.inp_qty.delete(0, "end")
        self.inp_qty.insert(0, str(max(1, int(qty) if str(qty).strip().isdigit() else 1)))

        # Parse lại raw thành zone/row/seat/parity
        if "|" in raw:
            zone_part, rest = raw.split("|", 1)
            self.inp_zone.insert(0, zone_part)
            raw = rest

        # Detect parity suffix (:odd / :even cuối)
        parity_suffix = ""
        for suf in ("odd", "even"):
            if raw.endswith(f":{suf}"):
                parity_suffix = suf
                raw = raw[: -(len(suf) + 1)]  # strip ":odd" hoặc ":even"
                break
        self.sel_parity.set(self._SUFFIX_TO_PARITY.get(parity_suffix, "Bất kỳ"))

        if ":" in raw:
            r, s = raw.split(":", 1)
            self.inp_row.insert(0, r)
            if s and s != "*":
                self.inp_seat.insert(0, s)
        elif raw:
            self.inp_zone.insert(0, raw)


class ZoneQtyRow(ctk.CTkFrame):
    """1 dòng ưu tiên zone (Tên khu + Số lượng riêng) — dùng chung cho 1Zone / Ticketbox / Ctiket."""

    def __init__(self, parent, on_delete, **kwargs):
        super().__init__(parent, fg_color=C_PANEL2, corner_radius=8, **kwargs)
        self.on_delete = on_delete
        self.grid_columnconfigure(0, weight=3)
        self.grid_columnconfigure(1, weight=1)

        # Tên zone
        ctk.CTkLabel(self, text="Tên khu", font=("Arial", 10), text_color=C_MUTED
                     ).grid(row=0, column=0, padx=(8,2), pady=(6,0), sticky="w")
        self.inp_zone = ctk.CTkEntry(self, placeholder_text="VD: SVIP B", height=30,
                                      font=("Arial", 11))
        self.inp_zone.grid(row=1, column=0, padx=(8,2), pady=(0,6), sticky="ew")

        # Số lượng
        ctk.CTkLabel(self, text="SL", font=("Arial", 10), text_color=C_MUTED
                     ).grid(row=0, column=1, padx=2, pady=(6,0), sticky="w")
        self.inp_qty = ctk.CTkEntry(self, placeholder_text="1", height=30,
                                     font=("Arial", 11), width=60)
        self.inp_qty.grid(row=1, column=1, padx=2, pady=(0,6), sticky="ew")

        # Nút xóa
        ctk.CTkButton(self, text="✕", width=28, height=28, fg_color="#374151",
                      hover_color="#4b5563", font=("Arial", 11),
                      command=self._delete
                      ).grid(row=0, column=2, rowspan=2, padx=(4,8), pady=4)

    def _delete(self):
        self.destroy()
        self.on_delete()

    def get_value(self):
        zone = self.inp_zone.get().strip()
        if not zone:
            return None
        try:
            qty = int(self.inp_qty.get().strip())
        except Exception:
            qty = 1
        return {"zone": zone, "quantity": max(1, qty)}

    def set_value(self, item):
        """item: {"zone": str, "quantity": int}"""
        if isinstance(item, dict):
            zone = item.get("zone", "")
            qty = item.get("quantity", 1)
        else:
            zone = str(item)
            qty = 1
        if zone:
            self.inp_zone.insert(0, zone)
        self.inp_qty.delete(0, "end")
        self.inp_qty.insert(0, str(qty))

# ── Main App ──────────────────────────────────────────────────────────────────

class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        global _app_ref
        _app_ref = self

        self.title("Săn Vé")
        self.geometry("960x760")
        self.configure(fg_color=C_BG)
        self.resizable(True, True)
        self._cfg = load_config()
        self._seat_map_rows = []
        self._zone_priority_rows = []
        self._slot_rows = []
        self._editing_slot_idx = None       # None = đang sửa config chung
        self._editing_slot_auto_seat = None  # buffer auto_seat khi đang sửa 1 slot
        self._build_ui()
        self.load_config_to_ui()
        self._api_server = start_api_server()
        self.add_log(f"✅ API sẵn sàng tại port {API_PORT}", "green")
        self.add_log("📌 Load extension vào Chrome, extension sẽ tự kết nối.", "blue")
        self.protocol("WM_DELETE_WINDOW", self._on_close)

        # Time sync thread
        threading.Thread(target=_time_sync_loop, daemon=True).start()

    # ── Build UI ──────────────────────────────────────────────────────────────

    def _build_ui(self):
        self.grid_columnconfigure(0, weight=0, minsize=450)
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

        # ── Left panel ──
        left = ctk.CTkFrame(self, fg_color=C_PANEL, corner_radius=16)
        left.grid(row=0, column=0, padx=(14,6), pady=14, sticky="nsew")
        left.grid_columnconfigure(0, weight=1)
        left.grid_rowconfigure(1, weight=1)

        # Tab bar
        tab_bar = ctk.CTkFrame(left, fg_color="transparent")
        tab_bar.grid(row=0, column=0, padx=14, pady=(14,0), sticky="ew")
        tab_bar.grid_columnconfigure((0,1), weight=1)

        self.btn_tab_seat = ctk.CTkButton(
            tab_bar, text="🪑  Chọn Vé", font=("Arial", 13, "bold"),
            fg_color=C_ACCENT, text_color="#0f172a", hover_color="#f59e0b",
            corner_radius=8, height=34,
            command=lambda: self._switch_tab("seat")
        )
        self.btn_tab_seat.grid(row=0, column=0, padx=(0,4), sticky="ew")

        self.btn_tab_info = ctk.CTkButton(
            tab_bar, text="👤  Thông Tin", font=("Arial", 13, "bold"),
            fg_color=C_BORDER, text_color=C_MUTED, hover_color="#1e293b",
            corner_radius=8, height=34,
            command=lambda: self._switch_tab("info")
        )
        self.btn_tab_info.grid(row=0, column=1, padx=(4,0), sticky="ew")

        # Tab content frame
        self.tab_frame = ctk.CTkScrollableFrame(left, fg_color="transparent", corner_radius=0)
        self.tab_frame.grid(row=1, column=0, padx=0, pady=0, sticky="nsew")
        self.tab_frame.grid_columnconfigure(0, weight=1)

        # Banner cảnh báo "đang sửa slot X" — nằm cố định trên đầu, ẩn mặc định
        self._edit_banner = ctk.CTkFrame(self.tab_frame, fg_color="#78350f", corner_radius=6)
        self._edit_banner.grid(row=0, column=0, padx=12, pady=(8,0), sticky="ew")
        self._edit_banner.grid_columnconfigure(0, weight=1)
        self._edit_banner_lbl = ctk.CTkLabel(
            self._edit_banner, text="", font=("Arial", 11, "bold"),
            text_color="#fde68a", anchor="w", wraplength=280,
        )
        self._edit_banner_lbl.grid(row=0, column=0, padx=(10,4), pady=6, sticky="w")
        ctk.CTkButton(self._edit_banner, text="✕ Thoát sửa slot", width=100, height=26,
                      fg_color="#92400e", hover_color="#b45309", text_color="white",
                      font=("Arial", 10), corner_radius=6,
                      command=lambda: self._stop_edit_slot()
                      ).grid(row=0, column=1, padx=(4,10), pady=6)
        self._edit_banner.grid_remove()

        # Bottom buttons
        btn_frame = ctk.CTkFrame(left, fg_color="transparent")
        btn_frame.grid(row=2, column=0, padx=14, pady=(6,6), sticky="ew")
        btn_frame.grid_columnconfigure((0,1), weight=1)

        ctk.CTkButton(btn_frame, text="💾  Lưu config", command=self._save_config,
                      fg_color="#1d4ed8", hover_color="#1e40af", height=36
                      ).grid(row=0, column=0, padx=(0,4), sticky="ew")
        ctk.CTkButton(btn_frame, text="🚀  Chạy tất cả tab", command=self._run_all_tabs,
                      fg_color="#7c3aed", hover_color="#6d28d9", height=36
                      ).grid(row=0, column=1, padx=(4,0), sticky="ew")

        # Nút xuất log + xóa log
        log_btn_frame = ctk.CTkFrame(left, fg_color="transparent")
        log_btn_frame.grid(row=3, column=0, padx=14, pady=(0,14), sticky="ew")
        log_btn_frame.grid_columnconfigure((0,1), weight=1)

        ctk.CTkButton(log_btn_frame, text="📤  Xuất log", command=self._export_log,
                      fg_color="#1e293b", hover_color="#334155", height=30,
                      font=("Arial", 11), text_color=C_MUTED
                      ).grid(row=0, column=0, padx=(0,4), sticky="ew")
        ctk.CTkButton(log_btn_frame, text="🗑  Xoá log", command=self._clear_log,
                      fg_color="#1e293b", hover_color="#334155", height=30,
                      font=("Arial", 11), text_color=C_MUTED
                      ).grid(row=0, column=1, padx=(4,0), sticky="ew")

        # ── Right panel: Log ──
        right = ctk.CTkFrame(self, fg_color=C_PANEL, corner_radius=16)
        right.grid(row=0, column=1, padx=(6,14), pady=14, sticky="nsew")
        right.grid_rowconfigure(1, weight=1)  # log_box row = 1 (cards removed)
        right.grid_columnconfigure(0, weight=1)

        # ── Header với clock realtime ─────────────────────────────────────────
        hdr = ctk.CTkFrame(right, fg_color="transparent")
        hdr.grid(row=0, column=0, padx=16, pady=(14,6), sticky="ew")
        hdr.grid_columnconfigure(0, weight=1)
        hdr.grid_columnconfigure(1, weight=0)
        hdr.grid_columnconfigure(2, weight=0)

        ctk.CTkLabel(hdr, text="📋  LOG", font=("Arial", 14, "bold"),
                     text_color=C_ACCENT).grid(row=0, column=0, sticky="w")

        self.lbl_clock = ctk.CTkLabel(
            hdr, text="🕐 --:--:--.---",
            font=("Consolas", 14, "bold"), text_color="#22c55e"
        )
        self.lbl_clock.grid(row=0, column=1, padx=(0, 10), sticky="e")

        self.lbl_status = ctk.CTkLabel(hdr, text="⏸  Chờ...",
                                        font=("Arial", 11), text_color=C_MUTED)
        self.lbl_status.grid(row=0, column=2, sticky="e")


        # ── Log box ───────────────────────────────────────────────────────────
        self.log_box = ctk.CTkTextbox(right, font=("Consolas", 11), state="disabled",
                                       fg_color=C_PANEL2, wrap="word")
        self.log_box.grid(row=1, column=0, padx=12, pady=(0,12), sticky="nsew")

        # FIX: dùng tag CỐ ĐỊNH theo màu (6 tag, config 1 lần) thay vì tạo tag
        # MỚI theo từng giây log — trước đây mỗi dòng log tạo 1 tag riêng
        # (tag_config(ts,...)) không bao giờ bị xoá, khiến bảng tag của Text
        # widget phình to vô hạn qua thời gian, làm app càng chạy lâu càng đơ.
        for _cname, _cval in LOG_COLORS.items():
            self.log_box.tag_config(_cname, foreground=_cval)

        # FIX: gộp nhiều dòng log gần nhau thành 1 lần update UI (xem add_log/
        # _flush_log_queue) — trước đây mỗi dòng log gọi .after(0,...) riêng,
        # khi hunt nhiều tab hàng chục request /log dồn dập mỗi giây khiến Tk
        # mainloop nghẽn dần, gây "Not Responding".
        self._log_queue = []
        self._log_queue_lock = threading.Lock()
        # Chống spam dòng lặp: log giống hệt liên tiếp (cùng tag, cùng nội dung,
        # cùng màu) từ 1 tab/slot sẽ KHÔNG tạo dòng mới — chỉ update counter
        # "(xN)" tại chỗ trên dòng cũ. Rất hay gặp lúc retry chọn ghế (mỗi ~1.8s
        # 1 dòng y hệt), trước đây làm log_box ngập hàng trăm dòng giống nhau.
        self._log_dedup = {}    # dedup_key (tag hoặc "_notag_") → {msg,color,count,mark,tag_label}
        self._dedup_mark_seq = 0
        self.after(100, self._flush_log_queue)

        # Build tabs
        self._build_tab_seat()
        self._build_tab_info()
        self._switch_tab("seat")

        # Start clock loop
        self._tick_clock()

    # ── Clock realtime (sync HTTP Date header mỗi 60s) ───────────────────────

    def _tick_clock(self):
        """Update label clock mỗi 100ms với time đã sync."""
        try:
            ts = _now_synced_ms()
            dt = datetime.fromtimestamp(ts)
            ms = int((ts % 1) * 1000)
            self.lbl_clock.configure(text=f"🕐 {dt.strftime('%H:%M:%S')}.{ms:03d}")
            # Sub-label: offset
            offset_ms = _time_offset_sec * 1000
            offset_str = f"sync {offset_ms:+.0f}ms" if abs(offset_ms) > 50 else "sync OK"
            self.lbl_clock.configure(text=f"🕐 {dt.strftime('%H:%M:%S')}.{ms:03d}")
        except Exception:
            pass
        self.after(100, self._tick_clock)

    # ── Tab Chọn Vé ──────────────────────────────────────────────────────────

    def _build_tab_seat(self):
        f = ctk.CTkFrame(self.tab_frame, fg_color="transparent")
        f.grid_columnconfigure(0, weight=1)
        self._tab_seat_frame = f

        # Platform — dạng tab bấm (segmented), thay cho dropdown cũ
        ctk.CTkLabel(f, text="Nền tảng", font=("Arial", 11), text_color=C_MUTED
                     ).grid(row=0, column=0, padx=16, pady=(14,0), sticky="w")
        self._platform_tab_frame = ctk.CTkFrame(f, fg_color="transparent")
        self._platform_tab_frame.grid(row=1, column=0, padx=16, pady=(2,8), sticky="ew")
        self._platform_tab_frame.grid_columnconfigure((0,1,2), weight=1)

        self._platform_value = "1Zone"
        self._platform_buttons = {}
        for i, p in enumerate(["1Zone", "Ticketbox", "Ctiket"]):
            btn = ctk.CTkButton(
                self._platform_tab_frame, text=p, font=("Arial", 12, "bold"),
                corner_radius=6, height=32,
                command=lambda p=p: self._select_platform_tab(p),
            )
            btn.grid(row=0, column=i, padx=(0 if i == 0 else 4, 0), sticky="ew")
            self._platform_buttons[p] = btn
        self._style_platform_tabs()

        # sel_platform giả lập API .get()/.set() để tương thích code cũ không cần sửa thêm
        class _FakePlatformVar:
            def __init__(self, outer): self._outer = outer
            def get(self): return self._outer._platform_value
            def set(self, val): self._outer._select_platform_tab(val, _save_prev=False)
        self.sel_platform = _FakePlatformVar(self)

        # ── Seat Slots ────────────────────────────────────────────────────────
        ctk.CTkFrame(f, height=1, fg_color="#1e293b"
                     ).grid(row=1, column=0, padx=16, pady=(0, 6), sticky="ew")

        slot_header = ctk.CTkFrame(f, fg_color="transparent")
        slot_header.grid(row=2, column=0, padx=16, pady=(0, 4), sticky="ew")
        slot_header.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(slot_header, text="⚙️  Config Slots (per-tab)",
                     font=("Arial", 11, "bold"), text_color="#94a3b8"
                     ).grid(row=0, column=0, sticky="w")

        slot_btn_frame = ctk.CTkFrame(slot_header, fg_color="transparent")
        slot_btn_frame.grid(row=0, column=1, sticky="e")

        ctk.CTkButton(slot_btn_frame, text="＋", width=28, height=24,
                      fg_color="#14532d", hover_color="#166534", text_color="#86efac",
                      font=("Arial", 12, "bold"), corner_radius=6,
                      command=self._add_slot
                      ).grid(row=0, column=0, padx=(0, 4))

        ctk.CTkLabel(slot_header,
                     text="Bấm ＋ sẽ tự Lưu cấu hình hiện tại rồi nhân bản thành slot mới",
                     font=("Arial", 9), text_color="#475569"
                     ).grid(row=1, column=0, columnspan=2, sticky="w", pady=(2, 0))

        # Scrollable list slots
        self._slots_list_frame = ctk.CTkFrame(f, fg_color="transparent")
        self._slots_list_frame.grid(row=3, column=0, padx=16, pady=(0, 4), sticky="ew")
        self._slots_list_frame.grid_columnconfigure(0, weight=1)
        self._slot_rows = []  # list of (name_var, slot_dict, row_frame)

        ctk.CTkFrame(f, height=1, fg_color="#1e293b"
                     ).grid(row=4, column=0, padx=16, pady=(4, 6), sticky="ew")
        self.lbl_mode = ctk.CTkLabel(f, text="Kiểu chọn ghế", font=("Arial", 11), text_color=C_MUTED)
        self.lbl_mode.grid(row=5, column=0, padx=16, pady=(0,0), sticky="w")
        self.sel_mode = ctk.CTkOptionMenu(
            f, values=[MODE_LABEL_ZONE, MODE_LABEL_MAP],
            command=self._on_mode_change, font=("Arial", 12)
        )
        self.sel_mode.grid(row=6, column=0, padx=16, pady=(2,8), sticky="ew")

        ctk.CTkFrame(f, height=1, fg_color=C_BORDER
                     ).grid(row=7, column=0, padx=16, pady=4, sticky="ew")

        # Dynamic area
        self.dynamic_frame = ctk.CTkFrame(f, fg_color="transparent")
        self.dynamic_frame.grid(row=8, column=0, padx=0, pady=0, sticky="ew")
        self.dynamic_frame.grid_columnconfigure(0, weight=1)

        # Số lượng + bật bot
        self.lbl_qty = ctk.CTkLabel(f, text="Số lượng vé", font=("Arial", 11), text_color=C_MUTED)
        self.lbl_qty.grid(row=9, column=0, padx=16, pady=(8,0), sticky="w")
        self.inp_qty = ctk.CTkEntry(f, placeholder_text="VD: 2", font=("Arial", 12))
        self.inp_qty.grid(row=10, column=0, padx=16, pady=(2,10), sticky="ew")

        # Allow partial purchase — mua thiếu vẫn OK
        self.var_allow_partial = ctk.BooleanVar(value=False)
        self.chk_allow_partial = ctk.CTkCheckBox(
            f, text="Mua thiếu vẫn OK (vé hết → mua được bấy nhiêu)",
            variable=self.var_allow_partial,
            font=("Arial", 11), text_color="#94a3b8",
        )
        self.chk_allow_partial.grid(row=11, column=0, padx=16, pady=(0,4), sticky="w")

        # Require adjacent — ghế liền nhau
        self.var_require_adjacent = ctk.BooleanVar(value=True)
        self.chk_require_adjacent = ctk.CTkCheckBox(
            f, text="Bắt buộc ghế liền nhau (bỏ tick → mua ghế rời cũng OK)",
            variable=self.var_require_adjacent,
            font=("Arial", 11), text_color="#94a3b8",
        )
        self.chk_require_adjacent.grid(row=12, column=0, padx=16, pady=(0,8), sticky="w")


    def _format_slot_summary(self, auto_seat):
        """Text tóm tắt cấu hình ghế đã set trong 1 slot — dùng cho preview 👁."""
        lines = []
        for platform, pk in _PLATFORM_KEY_MAP.items():
            seat_cfg = (auto_seat or {}).get(pk) or {}
            mode = seat_cfg.get("seat_mode", "seat_zone")
            is_zone_mode = (platform == "Ctiket") or (mode == "seat_zone")
            mode_label = MODE_LABEL_ZONE if is_zone_mode else MODE_LABEL_MAP

            rows = []
            if is_zone_mode:
                for it in (seat_cfg.get("items") or []):
                    rows.append(f"    • {it.get('zone','?')} — SL{it.get('quantity',1)}")
            else:
                for it in (seat_cfg.get("seat_map_priorities") or []):
                    if isinstance(it, dict):
                        rows.append(f"    • {it.get('raw','?')} — SL{it.get('quantity',1)}")
                    else:
                        rows.append(f"    • {it}")
            if not rows:
                rows = ["    • (chưa cấu hình)"]

            lines.append(f"{platform} ({mode_label}):")
            lines.extend(rows)
        return "\n".join(lines)

    def _reload_slots_ui(self):
        """Đọc slots từ config và re-render danh sách."""
        cfg = load_config()
        slots = cfg.get("seat_slots", [])
        for _, _, rf in self._slot_rows:
            try: rf.destroy()
            except Exception: pass
        self._slot_rows = []
        for i, slot in enumerate(slots):
            self._render_slot_row(i, slot)
        # Ẩn frame nếu không có slot nào (tránh khoảng trống)
        if slots:
            self._slots_list_frame.grid()
        else:
            self._slots_list_frame.grid_remove()
        self._update_edit_banner()

    def _render_slot_row(self, idx, slot):
        """Vẽ 1 dòng slot: [tên] [👁 xem] [✏️ sửa] [📋 copy] [✕ xóa] + panel chi tiết."""
        rf = ctk.CTkFrame(self._slots_list_frame, fg_color="#111827",
                          corner_radius=6)
        rf.grid(row=idx, column=0, pady=(0, 3), sticky="ew")
        rf.grid_columnconfigure(0, weight=1)

        is_editing = (self._editing_slot_idx == idx)
        if is_editing:
            rf.configure(border_width=1, border_color="#facc15")

        name_var = ctk.StringVar(value=slot.get("name", f"Slot {idx+1}"))

        name_entry = ctk.CTkEntry(rf, textvariable=name_var, font=("Arial", 11),
                                   fg_color="#1e293b", border_color="#334155",
                                   height=28)
        name_entry.grid(row=0, column=0, padx=(6,4), pady=4, sticky="ew")

        def _save_name(event=None, i=idx, nv=name_var):
            cfg = load_config()
            slots = cfg.get("seat_slots", [])
            if i < len(slots):
                slots[i]["name"] = nv.get().strip() or f"Slot {i+1}"
                cfg["seat_slots"] = slots
                save_config(cfg)

        name_entry.bind("<FocusOut>", _save_name)
        name_entry.bind("<Return>", _save_name)

        # Panel chi tiết — ẩn mặc định, hiện khi bấm nút 👁
        detail_lbl = ctk.CTkLabel(
            rf, text=self._format_slot_summary(slot.get("auto_seat", {})),
            font=("Consolas", 10), text_color="#94a3b8", justify="left",
            anchor="w", wraplength=340,
        )
        detail_lbl.grid(row=1, column=0, columnspan=5, padx=(6,6), pady=(0,6), sticky="ew")
        detail_lbl.grid_remove()

        def _toggle_detail(lbl=detail_lbl, i=idx):
            if lbl.winfo_ismapped():
                lbl.grid_remove()
                return
            cfg = load_config()
            slots = cfg.get("seat_slots", [])
            if i < len(slots):
                lbl.configure(text=self._format_slot_summary(slots[i].get("auto_seat", {})))
            lbl.grid()

        ctk.CTkButton(rf, text="👁", width=28, height=28, font=("Arial", 11),
                      fg_color="#312e81", hover_color="#3730a3", text_color="#c7d2fe",
                      corner_radius=6,
                      command=_toggle_detail
                      ).grid(row=0, column=1, padx=(0, 2), pady=4)

        edit_fg = "#78350f" if is_editing else "#3f2d0a"
        ctk.CTkButton(rf, text="✏️", width=28, height=28, font=("Arial", 11),
                      fg_color=edit_fg, hover_color="#92400e", text_color="#fcd34d",
                      corner_radius=6,
                      command=lambda i=idx: self._start_edit_slot(i)
                      ).grid(row=0, column=2, padx=(0, 2), pady=4)

        ctk.CTkButton(rf, text="📋", width=28, height=28, font=("Arial", 11),
                      fg_color="#1e3a5f", hover_color="#1e40af", text_color="#93c5fd",
                      corner_radius=6,
                      command=lambda i=idx: self._copy_slot(i)
                      ).grid(row=0, column=3, padx=(0, 2), pady=4)

        ctk.CTkButton(rf, text="✕", width=28, height=28, font=("Arial", 11),
                      fg_color="#7f1d1d", hover_color="#991b1b", text_color="#fca5a5",
                      corner_radius=6,
                      command=lambda i=idx: self._remove_slot(i)
                      ).grid(row=0, column=4, padx=(0, 6), pady=4)

        self._slot_rows.append((name_var, slot, rf))

    def _add_slot(self):
        """Thêm slot mới — clone từ config hiện tại.

        Tự động gọi _save_config() (y hệt bấm nút "Lưu") trước khi clone,
        đảm bảo slot mới luôn khớp với những gì đang hiển thị trên UI —
        tránh trường hợp gõ xong quên Lưu rồi bấm "+" bị clone nhầm cấu
        hình cũ. Nếu đang ở chế độ sửa 1 slot khác thì thoát ra trước
        (để không nhân bản nhầm dữ liệu slot đang sửa thành config chung).
        """
        import copy
        if self._editing_slot_idx is not None:
            self.add_log("ℹ️ Thoát chế độ sửa slot trước khi thêm slot mới.", "yellow")
            self._stop_edit_slot()
        self._save_config()
        cfg = load_config()
        slots = cfg.get("seat_slots", [])
        new_slot = {
            "name": f"Slot {len(slots) + 1}",
            "auto_seat": copy.deepcopy(cfg["auto_seat"]),
        }
        slots.append(new_slot)
        cfg["seat_slots"] = slots
        save_config(cfg)
        self._reload_slots_ui()
        self.add_log(f"✅ Đã tự lưu cấu hình hiện tại + thêm {new_slot['name']}", "green")

    def _copy_slot(self, idx):
        """Nhân bản 1 slot."""
        import copy
        cfg = load_config()
        slots = cfg.get("seat_slots", [])
        if idx >= len(slots):
            return
        src = slots[idx]
        new_slot = {
            "name": f"{src.get('name', f'Slot {idx+1}')} (copy)",
            "auto_seat": copy.deepcopy(src["auto_seat"]),
        }
        slots.append(new_slot)
        cfg["seat_slots"] = slots
        save_config(cfg)
        self._reload_slots_ui()
        self.add_log(f"📋 Đã nhân bản {src.get('name', f'Slot {idx+1}')}", "green")

    def _remove_slot(self, idx):
        """Xóa slot theo index — có hỏi xác nhận trước (trước đây xóa thẳng)."""
        cfg = load_config()
        slots = cfg.get("seat_slots", [])
        if idx >= len(slots):
            return
        name = slots[idx].get("name", f"Slot {idx+1}")

        confirm = messagebox.askyesno(
            "Xác nhận xóa slot",
            f"Xóa \"{name}\"?\n\nKhông thể hoàn tác. Cấu hình ghế đã set trong slot này "
            f"sẽ mất — nếu chưa chắc, bấm 👁 xem lại trước khi xóa.",
            icon="warning",
        )
        if not confirm:
            return

        slots.pop(idx)
        cfg["seat_slots"] = slots
        save_config(cfg)

        # Nếu đang sửa đúng slot vừa xóa → thoát chế độ sửa
        if self._editing_slot_idx == idx:
            self._editing_slot_idx = None
            self._editing_slot_auto_seat = None
            self._load_seat_config_for(self._platform_value)
        elif self._editing_slot_idx is not None and self._editing_slot_idx > idx:
            # Các slot sau bị dịch chỉ số lên 1 do vừa xóa 1 slot phía trước
            self._editing_slot_idx -= 1

        self._reload_slots_ui()
        self.add_log(f"🗑 Đã xóa {name}", "yellow")

    # ── Sửa slot tại chỗ (edit-in-place) ────────────────────────────────────────

    def _start_edit_slot(self, idx):
        """Nạp cấu hình của 1 slot lên UI 'Chọn ghế' để sửa trực tiếp.
        Bấm 'Lưu' lúc này sẽ ghi ĐÈ vào đúng slot đó — KHÔNG đụng config chung."""
        import copy
        cfg = load_config()
        slots = cfg.get("seat_slots", [])
        if idx >= len(slots):
            return
        self._editing_slot_idx = idx
        self._editing_slot_auto_seat = copy.deepcopy(slots[idx].get("auto_seat", {}))
        self._switch_tab("seat")
        self._load_seat_config_for(self._platform_value)
        self._update_edit_banner()
        self._reload_slots_ui()
        self.add_log(
            f"✏️ Đang sửa \"{slots[idx].get('name', f'Slot {idx+1}')}\" — "
            f"bấm 'Lưu' để ghi lại vào slot này (không ảnh hưởng config chung).",
            "yellow")

    def _stop_edit_slot(self):
        """Thoát chế độ sửa slot, quay về sửa config chung."""
        self._editing_slot_idx = None
        self._editing_slot_auto_seat = None
        self._load_seat_config_for(self._platform_value)
        self._update_edit_banner()
        self._reload_slots_ui()

    def _update_edit_banner(self):
        """Hiện/ẩn banner vàng báo đang sửa slot nào (nằm trên đầu tab Chọn ghế)."""
        if not hasattr(self, "_edit_banner"):
            return
        if self._editing_slot_idx is not None:
            cfg = load_config()
            slots = cfg.get("seat_slots", [])
            name = (slots[self._editing_slot_idx].get("name", f"Slot {self._editing_slot_idx+1}")
                    if self._editing_slot_idx < len(slots) else "Slot")
            self._edit_banner_lbl.configure(
                text=f"✏️ Đang sửa \"{name}\" — Lưu sẽ ghi vào slot này, không đụng config chung.")
            self._edit_banner.grid()
        else:
            self._edit_banner.grid_remove()



    def _build_dynamic_zone(self):
        """UI chọn zone (1Zone/Ticketbox): mỗi dòng có Tên zone + Số lượng riêng.
        Lưu ý: đơn hàng vẫn chỉ mua từ 1 zone (zone đầu tiên còn đủ vé theo thứ tự
        ưu tiên) — SL riêng từng dòng chỉ để biết muốn mua bao nhiêu NẾU zone đó
        được chọn, không phải mua cộng dồn nhiều zone cùng lúc."""
        for w in self.dynamic_frame.winfo_children():
            w.destroy()
        self._zone_priority_rows = []

        ctk.CTkLabel(self.dynamic_frame, text="Ưu tiên khu vực",
                     font=("Arial", 11), text_color=C_MUTED
                     ).grid(row=0, column=0, padx=16, pady=(0,0), sticky="w")
        ctk.CTkLabel(self.dynamic_frame,
                     text="Bot thử theo thứ tự từ trên xuống — mỗi khu có số lượng riêng (đơn hàng chỉ mua từ 1 khu)",
                     font=("Arial", 10), text_color="#475569", wraplength=320
                     ).grid(row=1, column=0, padx=16, pady=(0,4), sticky="w")

        self.zone_rows_frame = ctk.CTkFrame(self.dynamic_frame, fg_color="transparent")
        self.zone_rows_frame.grid(row=2, column=0, padx=16, pady=0, sticky="ew")
        self.zone_rows_frame.grid_columnconfigure(0, weight=1)

        ctk.CTkButton(self.dynamic_frame, text="＋  Thêm ưu tiên",
                      fg_color=C_BORDER, hover_color="#1e293b",
                      text_color=C_MUTED, font=("Arial", 11),
                      command=self._add_zone_priority_row, height=30
                      ).grid(row=3, column=0, padx=16, pady=(6,4), sticky="w")

        self._add_zone_priority_row()

    def _add_zone_priority_row(self, val=None):
        row = ZoneQtyRow(self.zone_rows_frame, on_delete=self._refresh_zone_priority_rows)
        row.grid(row=len(self._zone_priority_rows), column=0, pady=(0,4), sticky="ew")
        if val:
            row.set_value(val)
        self._zone_priority_rows.append(row)

    def _refresh_zone_priority_rows(self):
        self._zone_priority_rows = [
            w for w in self.zone_rows_frame.winfo_children()
            if isinstance(w, ZoneQtyRow)
        ]
        for i, row in enumerate(self._zone_priority_rows):
            row.grid(row=i, column=0, pady=(0,4), sticky="ew")

    def _build_dynamic_map(self):
        for w in self.dynamic_frame.winfo_children():
            w.destroy()
        self._seat_map_rows = []

        ctk.CTkLabel(self.dynamic_frame, text="Ưu tiên ghế",
                     font=("Arial", 11), text_color=C_MUTED
                     ).grid(row=0, column=0, padx=16, pady=(0,2), sticky="w")
        ctk.CTkLabel(self.dynamic_frame,
                     text="Để trống = bất kỳ  |  Hàng: M hoặc A-D  |  Ghế: 18 hoặc 15-20 hoặc 18,20  |  mỗi dòng có SL riêng",
                     font=("Arial", 10), text_color="#475569", wraplength=320
                     ).grid(row=1, column=0, padx=16, pady=(0,4), sticky="w")

        self.seat_rows_frame = ctk.CTkFrame(self.dynamic_frame, fg_color="transparent")
        self.seat_rows_frame.grid(row=2, column=0, padx=16, pady=0, sticky="ew")
        self.seat_rows_frame.grid_columnconfigure(0, weight=1)

        ctk.CTkButton(self.dynamic_frame, text="＋  Thêm ưu tiên",
                      fg_color=C_BORDER, hover_color="#1e293b",
                      text_color=C_MUTED, font=("Arial", 11),
                      command=self._add_seat_map_row, height=30
                      ).grid(row=3, column=0, padx=16, pady=(6,4), sticky="w")

        # Thêm 1 row mặc định
        self._add_seat_map_row()

    def _build_dynamic_ctiket(self):
        """UI chọn zone Ctiket: mỗi dòng có Tên zone + Số lượng riêng."""
        for w in self.dynamic_frame.winfo_children():
            w.destroy()
        self._ctiket_zone_rows = []

        ctk.CTkLabel(self.dynamic_frame, text="Ưu tiên khu vực",
                     font=("Arial", 11), text_color=C_MUTED
                     ).grid(row=0, column=0, padx=16, pady=(0,0), sticky="w")
        ctk.CTkLabel(self.dynamic_frame,
                     text="Bot thử theo thứ tự từ trên xuống — mỗi khu có số lượng riêng",
                     font=("Arial", 10), text_color="#475569", wraplength=320
                     ).grid(row=1, column=0, padx=16, pady=(0,4), sticky="w")

        self.ctiket_rows_frame = ctk.CTkFrame(self.dynamic_frame, fg_color="transparent")
        self.ctiket_rows_frame.grid(row=2, column=0, padx=16, pady=0, sticky="ew")
        self.ctiket_rows_frame.grid_columnconfigure(0, weight=1)

        ctk.CTkButton(self.dynamic_frame, text="＋  Thêm ưu tiên",
                      fg_color=C_BORDER, hover_color="#1e293b",
                      text_color=C_MUTED, font=("Arial", 11),
                      command=self._add_ctiket_zone_row, height=30
                      ).grid(row=3, column=0, padx=16, pady=(6,4), sticky="w")

        self._add_ctiket_zone_row()

    def _add_ctiket_zone_row(self, val=None):
        row = ZoneQtyRow(self.ctiket_rows_frame, on_delete=self._refresh_ctiket_rows)
        row.grid(row=len(self._ctiket_zone_rows), column=0, pady=(0,4), sticky="ew")
        if val:
            row.set_value(val)
        self._ctiket_zone_rows.append(row)

    def _refresh_ctiket_rows(self):
        self._ctiket_zone_rows = [
            w for w in self.ctiket_rows_frame.winfo_children()
            if isinstance(w, ZoneQtyRow)
        ]
        for i, row in enumerate(self._ctiket_zone_rows):
            row.grid(row=i, column=0, pady=(0,4), sticky="ew")

    def _add_seat_map_row(self, val=None):
        row = SeatMapRow(self.seat_rows_frame, on_delete=self._refresh_seat_rows)
        row.grid(row=len(self._seat_map_rows), column=0, pady=(0,4), sticky="ew")
        if val:
            row.set_value(val)
        self._seat_map_rows.append(row)

    def _refresh_seat_rows(self):
        self._seat_map_rows = [
            w for w in self.seat_rows_frame.winfo_children()
            if isinstance(w, SeatMapRow)
        ]

    def _on_platform_change(self, new_platform=None):
        # new_platform có thể là string (do OptionMenu command truyền), hoặc None (gọi nội bộ)
        prev_platform = getattr(self, "_prev_platform", None)

        # Lưu config của platform trước đó (nếu đang có data + đã init xong UI)
        if prev_platform and prev_platform != self.sel_platform.get() and getattr(self, "_ui_ready", False):
            self._save_seat_config_for(prev_platform)

        self._prev_platform = self.sel_platform.get()

        platform = self.sel_platform.get()
        if platform == "Ctiket":
            # Ctiket chỉ có seat_zone (GA theo khu, không có seatmap ghế cụ thể)
            # → ẩn dropdown mode (ô số lượng chung được _update_qty_field_visibility xử lý)
            self.sel_mode.set(MODE_LABEL_ZONE)
            self.lbl_mode.grid_remove()
            self.sel_mode.grid_remove()
        else:
            self.lbl_mode.grid()
            self.sel_mode.grid()

        self._load_seat_config_for(platform)
        self._update_qty_field_visibility()

    def _apply_seat_ui_to_dict(self, seat_cfg, platform, mode):
        """Đọc toàn bộ UI hiện tại (ưu tiên, SL, 2 checkbox) và ghi vào seat_cfg (dict).
        Dùng chung cho cả 2 đường: lưu config chung VÀ lưu vào 1 slot đang sửa."""
        seat_cfg["seat_mode"]        = mode
        seat_cfg["allow_partial"]    = self.var_allow_partial.get()
        seat_cfg["require_adjacent"] = self.var_require_adjacent.get()

        if platform == "Ctiket":
            self._refresh_ctiket_rows()
            items = [r.get_value() for r in self._ctiket_zone_rows if r.get_value()]
            seat_cfg["items"] = items
            seat_cfg["zone_priority"] = [i["zone"] for i in items]
            seat_cfg["priority_targets"] = [i["zone"] for i in items]
            seat_cfg["quantity"] = sum(i["quantity"] for i in items) if items else 1
            seat_cfg["seat_map_priorities"] = []
        elif mode == "seat_zone":
            self._refresh_zone_priority_rows()
            items = [r.get_value() for r in self._zone_priority_rows if r.get_value()]
            seat_cfg["items"] = items
            seat_cfg["zone_priority"]    = [i["zone"] for i in items]
            seat_cfg["priority_targets"] = [i["zone"] for i in items]
            seat_cfg["quantity"]         = sum(i["quantity"] for i in items) if items else 1
            seat_cfg["seat_map_priorities"] = []
        else:
            self._refresh_seat_rows()
            priorities = [r.get_value() for r in self._seat_map_rows if r.get_value()]
            seat_cfg["seat_map_priorities"] = priorities
            seat_cfg["zone_priority"]        = priorities
            seat_cfg["priority_targets"]     = priorities
            seat_cfg["quantity"] = max([p["quantity"] for p in priorities], default=1)
            orphan_n = sum(1 for r in self._seat_map_rows if r.has_orphan_seat())
            if orphan_n:
                self.add_log(
                    f"⚠️ {orphan_n} dòng có 'Ghế số' nhưng thiếu 'Hàng' — "
                    f"(các) dòng này bị BỎ QUA khi lưu. Điền 'Hàng' để dòng có hiệu lực.",
                    "yellow")
        return seat_cfg

    def _save_seat_config_for(self, platform):
        """Lưu phần auto_seat[platform] hiện tại trên UI (chưa ghi file).
        Nếu đang ở chế độ sửa 1 slot (self._editing_slot_idx != None), ghi vào
        buffer của slot đó thay vì self._cfg["auto_seat"] (config chung)."""
        pk = _PLATFORM_KEY_MAP.get(platform, "1zone")
        mode = "seat_zone" if platform == "Ctiket" else _label_to_mode(self.sel_mode.get())

        if self._editing_slot_idx is not None:
            self._editing_slot_auto_seat.setdefault(pk, _default_seat_cfg())
            seat_cfg = self._editing_slot_auto_seat[pk]
        else:
            seat_cfg = self._cfg["auto_seat"].setdefault(pk, _default_seat_cfg())

        self._apply_seat_ui_to_dict(seat_cfg, platform, mode)

    def _load_seat_config_for(self, platform):
        """Đọc auto_seat[platform] rồi render lên UI — nếu đang sửa 1 slot
        (self._editing_slot_idx != None) thì đọc từ buffer của slot đó,
        ngược lại đọc từ self._cfg (config chung)."""
        pk = _PLATFORM_KEY_MAP.get(platform, "1zone")
        if self._editing_slot_idx is not None:
            as_ = (self._editing_slot_auto_seat or {}).get(pk) or _default_seat_cfg()
        else:
            as_ = self._cfg.get("auto_seat", {}).get(pk, _default_seat_cfg())

        mode = as_.get("seat_mode", "seat_zone")
        self.sel_mode.set(_mode_to_label(mode))

        if platform == "Ctiket":
            self._build_dynamic_ctiket()
            items = as_.get("items") or []
            for w in self.ctiket_rows_frame.winfo_children():
                w.destroy()
            self._ctiket_zone_rows = []
            if items:
                for item in items:
                    self._add_ctiket_zone_row(item)
            else:
                self._add_ctiket_zone_row()
        elif mode == "seat_zone":
            self._build_dynamic_zone()
            items = as_.get("items") or []
            if not items:
                # Migrate config cũ: zone_priority (list tên) + 1 quantity chung
                zones = as_.get("zone_priority") or as_.get("priority_targets") or []
                qty_old = int(as_.get("quantity", 1) or 1)
                items = [{"zone": z, "quantity": qty_old} for z in zones]
            for w in self.zone_rows_frame.winfo_children():
                w.destroy()
            self._zone_priority_rows = []
            if items:
                for item in items:
                    self._add_zone_priority_row(item)
            else:
                self._add_zone_priority_row()
        else:
            self._build_dynamic_map()
            priorities = as_.get("seat_map_priorities") or []
            if priorities and not isinstance(priorities[0], dict):
                # Migrate config cũ: list string + 1 quantity chung
                qty_old = int(as_.get("quantity", 1) or 1)
                priorities = [{"raw": p, "quantity": qty_old} for p in priorities]
            for w in self.seat_rows_frame.winfo_children():
                w.destroy()
            self._seat_map_rows = []
            if priorities:
                for p in priorities:
                    self._add_seat_map_row(p)
            else:
                self._add_seat_map_row()

        if platform != "Ctiket":
            _set(self.inp_qty, str(as_.get("quantity", 1)))
        self.var_allow_partial.set(bool(as_.get("allow_partial", False)))
        self.var_require_adjacent.set(bool(as_.get("require_adjacent", True)))

    def _style_platform_tabs(self):
        for p, btn in self._platform_buttons.items():
            if p == self._platform_value:
                btn.configure(fg_color="#1e3a5f", text_color="#93c5fd", hover_color="#274a73")
            else:
                btn.configure(fg_color="#1e293b", text_color="#64748b", hover_color="#273548")

    def _select_platform_tab(self, platform, _save_prev=True):
        prev_platform = self._platform_value
        if _save_prev and prev_platform != platform and getattr(self, "_ui_ready", False):
            self._save_seat_config_for(prev_platform)

        self._platform_value = platform
        self._prev_platform = platform
        self._style_platform_tabs()

        if platform == "Ctiket":
            self.lbl_mode.grid_remove()
            self.sel_mode.grid_remove()
        else:
            self.lbl_mode.grid()
            self.sel_mode.grid()

        self._load_seat_config_for(platform)
        self._update_qty_field_visibility()

    def _update_qty_field_visibility(self):
        """Ô 'Số lượng vé' chung giờ luôn ẩn — cả seat_zone lẫn seat_map (1Zone/
        Ticketbox/Ctiket) đều đã có SL riêng trên từng dòng ưu tiên."""
        self.lbl_qty.grid_remove()
        self.inp_qty.grid_remove()

    def _on_mode_change(self, _=None):
        mode = _label_to_mode(self.sel_mode.get())
        if mode == "seat_zone":
            self._build_dynamic_zone()
        else:
            self._build_dynamic_map()
        self._update_qty_field_visibility()

    # ── Tab Thông Tin ─────────────────────────────────────────────────────────

    def _build_tab_info(self):
        f = ctk.CTkFrame(self.tab_frame, fg_color="transparent")
        f.grid_columnconfigure(0, weight=1)
        self._tab_info_frame = f

        # ── 4 trường cố định ──────────────────────────────────────────────────
        fields = [
            ("Họ tên",        "inp_name",    "Nguyễn Văn A"),
            ("Số điện thoại", "inp_phone",   "09xxxxxxxx"),
            ("Email",         "inp_email",   "email@example.com"),
            ("Địa chỉ",       "inp_address", "Biên Hòa, Đồng Nai"),
        ]
        for i, (label, attr, placeholder) in enumerate(fields):
            ctk.CTkLabel(f, text=label, font=("Arial", 11), text_color=C_MUTED
                         ).grid(row=i*2, column=0, padx=16, pady=(14 if i==0 else 6, 0), sticky="w")
            inp = ctk.CTkEntry(f, placeholder_text=placeholder, font=("Arial", 12))
            inp.grid(row=i*2+1, column=0, padx=16, pady=(2,0), sticky="ew")
            setattr(self, attr, inp)

        # ── Separator + header custom fields ──────────────────────────────────
        ROW_SEP = len(fields) * 2
        ctk.CTkLabel(f, text="Trường tùy chỉnh", font=("Arial", 11, "bold"),
                     text_color=C_MUTED).grid(
            row=ROW_SEP, column=0, padx=16, pady=(14, 0), sticky="w")

        # Nút Scan Fields
        btn_scan = ctk.CTkButton(
            f, text="🔍 Scan Fields", width=110, height=26,
            font=("Arial", 11), fg_color=C_BORDER, text_color=C_TEXT,
            hover_color="#334155",
            command=self._scan_fields,
        )
        btn_scan.grid(row=ROW_SEP, column=0, padx=16, pady=(14, 0), sticky="e")
        self._btn_scan = btn_scan

        # Frame chứa các custom field rows (scrollable nếu nhiều)
        self._custom_frame = ctk.CTkFrame(f, fg_color="transparent")
        self._custom_frame.grid(row=ROW_SEP+1, column=0, padx=0, pady=(4,8), sticky="ew")
        self._custom_frame.grid_columnconfigure(0, weight=1)
        self._custom_rows = []  # list of (keyword_entry, value_entry, row_frame)

    def _add_custom_field_row(self, keyword="", value=""):
        """Thêm 1 row custom field vào _custom_frame."""
        idx = len(self._custom_rows)
        row_f = ctk.CTkFrame(self._custom_frame, fg_color="#1e293b", corner_radius=6)
        row_f.grid(row=idx, column=0, padx=16, pady=(0, 4), sticky="ew")
        row_f.grid_columnconfigure(0, weight=2)
        row_f.grid_columnconfigure(1, weight=3)

        kw_inp = ctk.CTkEntry(row_f, placeholder_text="keyword (vd: cmnd)", font=("Arial", 11),
                              width=110, fg_color="#0f172a")
        kw_inp.grid(row=0, column=0, padx=(8,4), pady=6, sticky="ew")
        if keyword:
            kw_inp.insert(0, keyword)

        val_inp = ctk.CTkEntry(row_f, placeholder_text="giá trị", font=("Arial", 11),
                               fg_color="#0f172a")
        val_inp.grid(row=0, column=1, padx=(0,4), pady=6, sticky="ew")
        if value:
            val_inp.insert(0, value)

        def _remove(rf=row_f, row_tuple=None):
            rf.destroy()
            self._custom_rows = [(k,v,f) for k,v,f in self._custom_rows if f != rf]
        btn_del = ctk.CTkButton(row_f, text="✕", width=26, height=26,
                                font=("Arial", 11), fg_color="#7f1d1d",
                                hover_color="#991b1b", command=_remove)
        btn_del.grid(row=0, column=2, padx=(0,6), pady=6)

        self._custom_rows.append((kw_inp, val_inp, row_f))

    def _scan_fields(self):
        """Bật pending flag → extension poll thấy → scan DOM → POST kết quả về."""
        global _scan_pending, _scan_result
        _scan_pending = True
        _scan_result  = None
        _scan_event.clear()
        self._btn_scan.configure(text="⏳ Đang scan...", state="disabled")
        self.add_log("🔍 Đang scan fields trên trang...", "blue")

        def _wait():
            got = _scan_event.wait(timeout=8)
            self.after(0, lambda: self._on_scan_result(_scan_result if got else None))

        threading.Thread(target=_wait, daemon=True).start()

    def _on_scan_result(self, fields):
        """Callback khi extension trả về list fields — hiện dialog chọn."""
        self._btn_scan.configure(text="🔍 Scan Fields", state="normal")
        if not fields:
            self.add_log("⚠️ Không tìm thấy form trên trang (hoặc timeout).", "yellow")
            return

        self.add_log(f"✅ Tìm thấy {len(fields)} field(s) trên trang.", "green")

        # Dialog chọn field
        dlg = ctk.CTkToplevel(self)
        dlg.title("Chọn field để thêm")
        dlg.geometry("420x380")
        dlg.resizable(False, False)
        dlg.grab_set()

        ctk.CTkLabel(dlg, text="Chọn field muốn tự động điền:",
                     font=("Arial", 12, "bold")).pack(padx=16, pady=(14,6), anchor="w")

        scroll = ctk.CTkScrollableFrame(dlg, height=220)
        scroll.pack(fill="both", expand=True, padx=12, pady=4)
        scroll.grid_columnconfigure(0, weight=1)

        selected = {}  # idx → BooleanVar
        for i, fld in enumerate(fields):
            label_txt = fld.get("label") or fld.get("placeholder") or fld.get("name") or f"field_{i}"
            hint = " | ".join(filter(None, [
                fld.get("label"), fld.get("placeholder"),
                f'name={fld["name"]}' if fld.get("name") else None,
                f'id={fld["id"]}' if fld.get("id") else None,
            ]))[:60]
            var = ctk.BooleanVar(value=False)
            selected[i] = (var, fld)
            cb = ctk.CTkCheckBox(scroll, text=hint or label_txt,
                                 variable=var, font=("Arial", 11))
            cb.grid(row=i, column=0, padx=8, pady=3, sticky="w")

        def _confirm():
            for i, (var, fld) in selected.items():
                if var.get():
                    # Keyword = label hoặc placeholder hoặc name, lowercase
                    kw = (fld.get("label") or fld.get("placeholder") or fld.get("name") or "").lower().strip()
                    self._add_custom_field_row(keyword=kw, value="")
            dlg.destroy()
            self.add_log("💡 Đã thêm field — nhập giá trị rồi bấm Lưu.", "blue")

        ctk.CTkButton(dlg, text="✅ Thêm field đã chọn", command=_confirm,
                      font=("Arial", 12), fg_color=C_ACCENT,
                      text_color="#0f172a").pack(pady=12)

    # ── Switch tab ────────────────────────────────────────────────────────────

    def _switch_tab(self, tab):
        self._tab_seat_frame.grid_forget()
        self._tab_info_frame.grid_forget()

        if tab == "seat":
            self._tab_seat_frame.grid(row=1, column=0, sticky="ew")
            self.btn_tab_seat.configure(fg_color=C_ACCENT, text_color="#0f172a")
            self.btn_tab_info.configure(fg_color=C_BORDER, text_color=C_MUTED)
            self._update_edit_banner()
        else:
            self._tab_info_frame.grid(row=1, column=0, sticky="ew")
            self.btn_tab_info.configure(fg_color=C_ACCENT, text_color="#0f172a")
            self.btn_tab_seat.configure(fg_color=C_BORDER, text_color=C_MUTED)
            self._edit_banner.grid_remove()

    # ── Config IO ─────────────────────────────────────────────────────────────

    def load_config_to_ui(self):
        cfg = self._cfg = load_config()
        _set(self.inp_name, cfg.get("name", ""))
        _set(self.inp_phone, cfg.get("phone", ""))
        _set(self.inp_email, cfg.get("email", ""))
        _set(self.inp_address, cfg.get("address", ""))

        # Load custom fields — xóa rows cũ rồi tạo lại
        for _, _, rf in self._custom_rows:
            try: rf.destroy()
            except Exception: pass
        self._custom_rows = []
        for fld in cfg.get("custom_fields", []):
            self._add_custom_field_row(fld.get("keyword", ""), fld.get("value", ""))

        platform = cfg.get("active_platform", "1Zone")
        self.sel_platform.set(platform)
        self._prev_platform = platform

        if platform == "Ctiket":
            self.lbl_mode.grid_remove()
            self.sel_mode.grid_remove()
        self._load_seat_config_for(platform)

        self._ui_ready = True  # từ giờ _on_platform_change mới được phép auto-save platform cũ
        self._reload_slots_ui()
        self._update_status()

    def _save_config(self):
        cfg = load_config()
        cfg["name"]    = self.inp_name.get().strip()
        cfg["phone"]   = self.inp_phone.get().strip()
        cfg["email"]   = self.inp_email.get().strip()
        cfg["address"] = self.inp_address.get().strip()

        # Save custom fields
        cfg["custom_fields"] = [
            {"keyword": kw.get().strip(), "value": val.get().strip()}
            for kw, val, _ in self._custom_rows
            if kw.get().strip()
        ]

        # Convert label → internal mode key
        platform = self.sel_platform.get()
        cfg["active_platform"] = platform
        pk = _PLATFORM_KEY_MAP.get(platform, "1zone")
        mode = "seat_zone" if platform == "Ctiket" else _label_to_mode(self.sel_mode.get())

        if self._editing_slot_idx is not None:
            # Đang sửa 1 slot → ghi vào ĐÚNG slot đó, KHÔNG đụng auto_seat chung
            slots = cfg.get("seat_slots", [])
            idx = self._editing_slot_idx
            if idx >= len(slots):
                self.add_log("⚠️ Slot đang sửa không còn tồn tại (có thể vừa bị xóa) — hủy lưu vào slot.", "yellow")
                self._editing_slot_idx = None
                self._editing_slot_auto_seat = None
                self._update_edit_banner()
            else:
                self._editing_slot_auto_seat.setdefault(pk, _default_seat_cfg())
                seat_cfg = self._editing_slot_auto_seat[pk]
                self._apply_seat_ui_to_dict(seat_cfg, platform, mode)
                slots[idx]["auto_seat"] = self._editing_slot_auto_seat
                cfg["seat_slots"] = slots
                save_config(cfg)
                self._cfg = cfg
                self._reload_slots_ui()
                self.add_log(
                    f"💾 Đã lưu vào \"{slots[idx].get('name', f'Slot {idx+1}')}\" "
                    f"(không ảnh hưởng config chung).", "green")
                return

        seat_cfg = cfg["auto_seat"].setdefault(pk, _default_seat_cfg())
        self._apply_seat_ui_to_dict(seat_cfg, platform, mode)

        save_config(cfg)
        self._cfg = cfg
        self.add_log(f"💾 Đã lưu config cho {platform}.", "green")

    def _update_status(self):
        self.lbl_status.configure(text="🟢  Sẵn sàng", text_color=C_OK)

    # ── Log ───────────────────────────────────────────────────────────────────

    def add_log(self, msg, color="white", tag_label=None):
        # CHỈ đẩy dữ liệu thô vào queue — không quyết định dedup ở đây.
        # (Trước đây add_log() tự so sánh + quyết định dedup ngay khi được gọi,
        # nhưng add_log() bị gọi từ nhiều lambda self.after(0, ...) xếp hàng bởi
        # NHIỀU HTTP request thread khác nhau lúc log dồn dập — thứ tự xử lý
        # không đảm bảo tuyệt đối tuần tự nên state dedup dễ bị đọc/ghi lệch.
        # Giờ quyết định dedup dời hết vào _flush_log_queue(), vốn đã chạy định
        # kỳ 100ms qua self.after() trên main thread — đảm bảo tuần tự thật sự.)
        tag = color if color in LOG_COLORS else "white"
        with self._log_queue_lock:
            self._log_queue.append({"kind": "raw", "msg": msg, "color": tag, "tag_label": tag_label})
        logger.info(msg)

    def add_log_separator(self, tag_label=None):
        """Đánh dấu ranh giới bắt đầu 1 phiên mới (VD bắt đầu săn ghế) — vẽ 1
        dòng ngăn cách mảnh thay vì log thường, dễ nhận ra lúc lướt log dài."""
        with self._log_queue_lock:
            self._log_queue.append({"kind": "sep", "tag_label": tag_label})
        logger.info(f"── phiên mới {f'[{tag_label}]' if tag_label else ''} ──")

    def _flush_log_queue(self):
        with self._log_queue_lock:
            pending, self._log_queue = self._log_queue, []
        if pending:
            self.log_box.configure(state="normal")
            for item in pending:
                kind = item["kind"]

                if kind == "raw":
                    msg, color, tag_label = item["msg"], item["color"], item["tag_label"]
                    dedup_key = f"tag:{tag_label}" if tag_label else "_notag_"
                    prev = self._log_dedup.get(dedup_key)

                    if prev and prev["msg"] == msg and prev["color"] == color and prev.get("mark"):
                        # Y hệt lần trước (cùng tab/slot, cùng nội dung, cùng màu)
                        # — không thêm dòng mới, chỉ update counter tại chỗ.
                        prev["count"] += 1
                        mark = prev["mark"]
                        try:
                            line_start = f"{mark} linestart"
                            line_end = f"{mark} lineend"
                            prefix = f"[{tag_label}] " if tag_label else ""
                            ts = datetime.now().strftime("%H:%M:%S")
                            new_line = f"[{ts}] {prefix}{msg} (x{prev['count']})"
                            self.log_box.delete(line_start, line_end)
                            self.log_box.insert(line_start, new_line)
                            self.log_box.tag_add(color, line_start, f"{mark} lineend")
                        except Exception:
                            pass  # dòng gốc có thể đã bị xoá (VD user bấm "Xoá log")
                        continue

                    # Nội dung mới (hoặc chưa từng thấy tag này) — thêm dòng mới
                    entry = {"msg": msg, "color": color, "count": 1, "mark": None}
                    self._log_dedup[dedup_key] = entry
                    ts = datetime.now().strftime("%H:%M:%S")
                    prefix = f"[{tag_label}] " if tag_label else ""
                    full = f"[{ts}] {prefix}{msg}\n"
                    start = self.log_box.index("end-1c")
                    self.log_box.insert("end", full)
                    self.log_box.tag_add(color, start, "end-1c")
                    # Mark cố định đầu dòng — dùng để tìm lại dòng này khi cần
                    # update counter "(xN)", kể cả sau khi có dòng khác (của tab
                    # khác) chen vào bên dưới.
                    mark = f"__svp_dedup_{self._dedup_mark_seq}"
                    self._dedup_mark_seq += 1
                    self.log_box.mark_set(mark, start)
                    self.log_box.mark_gravity(mark, "left")
                    entry["mark"] = mark

                elif kind == "sep":
                    label = item.get("tag_label")
                    title = f" {label} " if label else " Phiên săn mới "
                    line = "─" * 6 + title + "─" * 6 + "\n"
                    start = self.log_box.index("end-1c")
                    self.log_box.insert("end", line)
                    self.log_box.tag_add("gray", start, "end-1c")

            self.log_box.configure(state="disabled")
            self.log_box.see("end")
        self.after(100, self._flush_log_queue)

    def _run_all_tabs(self):
        """Báo hiệu background broadcast HUNT_NOW vào tất cả tab (mọi Chrome profile)."""
        global _hunt_all_version
        _hunt_all_version += 1
        self.add_log("🚀 Đã gửi lệnh Chạy tất cả tab!", "green")

    def _export_log(self):
        from tkinter import filedialog
        content = self.log_box.get("1.0", "end").strip()
        if not content:
            self.add_log("⚠️ Log đang trống, không có gì để xuất.", "yellow")
            return
        ts = datetime.now().strftime("%Y%m%d_%H%M%S")
        default_name = f"sanve_log_{ts}.txt"
        path = filedialog.asksaveasfilename(
            defaultextension=".txt",
            filetypes=[("Text file", "*.txt"), ("Log file", "*.log"), ("All files", "*.*")],
            initialfile=default_name,
            title="Xuất log"
        )
        if not path:
            return
        try:
            with open(path, "w", encoding="utf-8") as f:
                f.write(content)
            self.add_log(f"✅ Đã xuất log: {path}", "green")
        except Exception as e:
            self.add_log(f"❌ Xuất log lỗi: {e}", "red")

    def _clear_log(self):
        self.log_box.configure(state="normal")
        self.log_box.delete("1.0", "end")
        self.log_box.configure(state="disabled")
        with self._log_queue_lock:
            self._log_dedup = {}
            self._log_queue = []

    def _on_close(self):
        try:
            self._api_server.shutdown()
        except Exception:
            pass
        self.destroy()

# ── Helpers ───────────────────────────────────────────────────────────────────

def _set(widget, val):
    if isinstance(widget, ctk.CTkEntry):
        widget.delete(0, "end")
        widget.insert(0, val)
    elif isinstance(widget, ctk.CTkTextbox):
        widget.delete("1.0", "end")
        widget.insert("1.0", val)

# ── Entry ─────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = App()
    app.mainloop()