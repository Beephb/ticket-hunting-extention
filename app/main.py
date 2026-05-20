# main.py — Săn Vé Pro v2.0
# Desktop App mới: giao diện gọn, chỉ làm Setup / Config / Log
# Backend: localhost HTTP API để Extension đọc config và gửi log về

import json
import os
import threading
import logging
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime
import customtkinter as ctk

# ── Logging ──────────────────────────────────────────────────────────────────
LOG_FILE = "hunt.log"

def _setup_logging():
    handler = logging.FileHandler(LOG_FILE, mode="w", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)

_setup_logging()
logger = logging.getLogger(__name__)

CONFIG_FILE = "config.json"
API_PORT = 9279   # port localhost Extension dùng để lấy config / gửi log

DEFAULT_CONFIG = {
    "name": "",
    "phone": "",
    "email": "",
    "address": "",
    "auto_seat": {
        "platform": "1Zone",
        "seat_mode": "seat_zone",
        "zone_priority": [],
        "quantity": 1,
        "seat_number_mode": "auto",
        "require_adjacent": False,
        "allow_split_seats": True,
        "enabled": False,
    }
}

# ── Config helpers ────────────────────────────────────────────────────────────

def load_config() -> dict:
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        # Merge defaults
        for k, v in DEFAULT_CONFIG.items():
            if k not in cfg:
                cfg[k] = v
        for k, v in DEFAULT_CONFIG["auto_seat"].items():
            if k not in cfg.get("auto_seat", {}):
                cfg.setdefault("auto_seat", {})[k] = v
        return cfg
    except Exception:
        return dict(DEFAULT_CONFIG)

def save_config(cfg: dict):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

# ── Localhost API Server ──────────────────────────────────────────────────────

_app_ref = None   # reference tới CTk App để gửi log vào UI

class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args):
        pass  # Tắt access log của HTTPServer

    def _send_json(self, code: int, data: dict):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def do_GET(self):
        if self.path == "/config":
            cfg = load_config()
            self._send_json(200, cfg)
        elif self.path == "/ping":
            self._send_json(200, {"ok": True, "port": API_PORT})
        else:
            self._send_json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        raw = self.rfile.read(length) if length > 0 else b"{}"
        try:
            data = json.loads(raw.decode("utf-8"))
        except Exception:
            data = {}

        if self.path == "/log":
            msg = str(data.get("msg", ""))
            color = str(data.get("color", "white"))
            level = str(data.get("level", "info")).lower()
            logger.info(f"[EXT] {msg}")
            if _app_ref:
                _app_ref.after(0, lambda m=msg, c=color: _app_ref.add_log(f"[EXT] {m}", c))
            self._send_json(200, {"ok": True})

        elif self.path == "/config":
            cfg = load_config()
            cfg.update({k: v for k, v in data.items() if k in DEFAULT_CONFIG})
            if "auto_seat" in data and isinstance(data["auto_seat"], dict):
                cfg["auto_seat"].update(data["auto_seat"])
            save_config(cfg)
            if _app_ref:
                _app_ref.after(0, _app_ref.load_config_to_ui)
            self._send_json(200, {"ok": True})

        else:
            self._send_json(404, {"error": "not found"})


def start_api_server():
    server = HTTPServer(("127.0.0.1", API_PORT), _Handler)
    t = threading.Thread(target=server.serve_forever, daemon=True)
    t.start()
    return server

# ── CTk App ──────────────────────────────────────────────────────────────────

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("dark-blue")

COLOR_BG      = "#0f172a"
COLOR_PANEL   = "#111827"
COLOR_ACCENT  = "#fbbf24"
COLOR_OK      = "#22c55e"
COLOR_ERR     = "#ef4444"
COLOR_MUTED   = "#94a3b8"
COLOR_TEXT    = "#e2e8f0"

LOG_COLORS = {
    "green":  COLOR_OK,
    "red":    COLOR_ERR,
    "yellow": "#facc15",
    "blue":   "#38bdf8",
    "white":  COLOR_TEXT,
    "gray":   COLOR_MUTED,
}

class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        global _app_ref
        _app_ref = self

        self.title("Săn Vé Pro v2.0")
        self.geometry("860x800")
        self.configure(fg_color=COLOR_BG)
        self.resizable(True, True)

        self._cfg = load_config()
        self._build_ui()
        self.load_config_to_ui()

        self._api_server = start_api_server()
        self.add_log(f"✅ Localhost API sẵn sàng tại port {API_PORT}", "green")
        self.add_log("📌 Load extension vào Chrome, extension sẽ tự kết nối.", "blue")

        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ── UI builder ────────────────────────────────────────────────────────────

    def _build_ui(self):
        self.grid_columnconfigure(0, weight=0, minsize=340)
        self.grid_columnconfigure(1, weight=1)
        self.grid_rowconfigure(0, weight=1)

        # ── Left panel ──
        left = ctk.CTkFrame(self, fg_color=COLOR_PANEL, corner_radius=16)
        left.grid(row=0, column=0, padx=(14, 6), pady=14, sticky="nsew")
        left.grid_columnconfigure(0, weight=1)

        ctk.CTkLabel(left, text="⚙️  CẤU HÌNH", font=("Arial", 15, "bold"),
                     text_color=COLOR_ACCENT).grid(row=0, column=0, pady=(16, 8), padx=18, sticky="w")

        # Thông tin cá nhân
        ctk.CTkLabel(left, text="Họ tên", font=("Arial", 11), text_color=COLOR_MUTED
                     ).grid(row=1, column=0, padx=18, sticky="w")
        self.inp_name = ctk.CTkEntry(left, placeholder_text="Nguyễn Văn A")
        self.inp_name.grid(row=2, column=0, padx=18, pady=(2, 6), sticky="ew")

        ctk.CTkLabel(left, text="Số điện thoại", font=("Arial", 11), text_color=COLOR_MUTED
                     ).grid(row=3, column=0, padx=18, sticky="w")
        self.inp_phone = ctk.CTkEntry(left, placeholder_text="09xxxxxxxx")
        self.inp_phone.grid(row=4, column=0, padx=18, pady=(2, 6), sticky="ew")

        ctk.CTkLabel(left, text="Email", font=("Arial", 11), text_color=COLOR_MUTED
                     ).grid(row=5, column=0, padx=18, sticky="w")
        self.inp_email = ctk.CTkEntry(left, placeholder_text="email@example.com")
        self.inp_email.grid(row=6, column=0, padx=18, pady=(2, 6), sticky="ew")

        ctk.CTkLabel(left, text="Địa chỉ", font=("Arial", 11), text_color=COLOR_MUTED
                     ).grid(row=7, column=0, padx=18, sticky="w")
        self.inp_address = ctk.CTkEntry(left, placeholder_text="Biên Hòa, Đồng Nai")
        self.inp_address.grid(row=8, column=0, padx=18, pady=(2, 10), sticky="ew")

        ctk.CTkFrame(left, height=1, fg_color="#1e293b").grid(
            row=9, column=0, padx=18, pady=4, sticky="ew")

        # Auto seat config
        ctk.CTkLabel(left, text="🪑  TỰ ĐỘNG CHỌN VÉ", font=("Arial", 13, "bold"),
                     text_color=COLOR_ACCENT).grid(row=10, column=0, pady=(8, 4), padx=18, sticky="w")

        ctk.CTkLabel(left, text="Nền tảng", font=("Arial", 11), text_color=COLOR_MUTED
                     ).grid(row=11, column=0, padx=18, sticky="w")
        self.sel_platform = ctk.CTkOptionMenu(left, values=["1Zone", "Ticketbox"],
                                              command=self._on_platform_change)
        self.sel_platform.grid(row=12, column=0, padx=18, pady=(2, 6), sticky="ew")

        ctk.CTkLabel(left, text="Kiểu chọn vé", font=("Arial", 11), text_color=COLOR_MUTED
                     ).grid(row=13, column=0, padx=18, sticky="w")
        self.sel_mode = ctk.CTkOptionMenu(left, values=["seat_zone", "seat_map"])
        self.sel_mode.grid(row=14, column=0, padx=18, pady=(2, 6), sticky="ew")

        ctk.CTkLabel(left, text="Ưu tiên zone/khu (mỗi dòng 1 zone)",
                     font=("Arial", 11), text_color=COLOR_MUTED
                     ).grid(row=15, column=0, padx=18, sticky="w")
        self.txt_priority = ctk.CTkTextbox(left, height=70, font=("Arial", 12))
        self.txt_priority.grid(row=16, column=0, padx=18, pady=(2, 6), sticky="ew")

        ctk.CTkLabel(left, text="Số lượng vé", font=("Arial", 11), text_color=COLOR_MUTED
                     ).grid(row=17, column=0, padx=18, sticky="w")
        self.inp_qty = ctk.CTkEntry(left, placeholder_text="1")
        self.inp_qty.grid(row=18, column=0, padx=18, pady=(2, 6), sticky="ew")

        # Bật/tắt bot
        self.var_enabled = ctk.BooleanVar(value=False)
        self.chk_enabled = ctk.CTkCheckBox(
            left, text="Bật bot tự động", variable=self.var_enabled,
            font=("Arial", 12, "bold"), text_color=COLOR_OK,
            command=self._on_toggle_bot
        )
        self.chk_enabled.grid(row=19, column=0, padx=18, pady=(10, 4), sticky="w")

        # Buttons
        btn_frame = ctk.CTkFrame(left, fg_color="transparent")
        btn_frame.grid(row=20, column=0, padx=18, pady=(6, 16), sticky="ew")
        btn_frame.grid_columnconfigure((0, 1), weight=1)

        ctk.CTkButton(btn_frame, text="💾 Lưu config", command=self._save_config,
                      fg_color="#1d4ed8", hover_color="#1e40af"
                      ).grid(row=0, column=0, padx=(0, 4), sticky="ew")
        ctk.CTkButton(btn_frame, text="🔄 Reset log", command=self._clear_log,
                      fg_color="#374151", hover_color="#4b5563"
                      ).grid(row=0, column=1, padx=(4, 0), sticky="ew")

        # ── Right panel: Log ──
        right = ctk.CTkFrame(self, fg_color=COLOR_PANEL, corner_radius=16)
        right.grid(row=0, column=1, padx=(6, 14), pady=14, sticky="nsew")
        right.grid_rowconfigure(1, weight=1)
        right.grid_columnconfigure(0, weight=1)

        hdr = ctk.CTkFrame(right, fg_color="transparent")
        hdr.grid(row=0, column=0, padx=18, pady=(14, 6), sticky="ew")
        hdr.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(hdr, text="📋  LOG", font=("Arial", 15, "bold"),
                     text_color=COLOR_ACCENT).grid(row=0, column=0, sticky="w")
        self.lbl_status = ctk.CTkLabel(hdr, text="⏸  Chờ...",
                                        font=("Arial", 11), text_color=COLOR_MUTED)
        self.lbl_status.grid(row=0, column=1, sticky="e")

        self.log_box = ctk.CTkTextbox(right, font=("Consolas", 11), state="disabled",
                                       fg_color="#0d1117", wrap="word")
        self.log_box.grid(row=1, column=0, padx=12, pady=(0, 12), sticky="nsew")

    # ── Config IO ─────────────────────────────────────────────────────────────

    def load_config_to_ui(self):
        cfg = self._cfg = load_config()
        _set(self.inp_name, cfg.get("name", ""))
        _set(self.inp_phone, cfg.get("phone", ""))
        _set(self.inp_email, cfg.get("email", ""))
        _set(self.inp_address, cfg.get("address", ""))

        as_ = cfg.get("auto_seat", {})
        self.sel_platform.set(as_.get("platform", "1Zone"))
        self.sel_mode.set(as_.get("seat_mode", "seat_zone"))
        self.txt_priority.delete("1.0", "end")
        zones = as_.get("zone_priority") or as_.get("priority_targets") or []
        self.txt_priority.insert("1.0", "\n".join(zones))
        _set(self.inp_qty, str(as_.get("quantity", 1)))
        self.var_enabled.set(bool(as_.get("enabled", False)))
        self._update_status_label()

    def _save_config(self):
        cfg = load_config()
        cfg["name"]    = self.inp_name.get().strip()
        cfg["phone"]   = self.inp_phone.get().strip()
        cfg["email"]   = self.inp_email.get().strip()
        cfg["address"] = self.inp_address.get().strip()

        zones = [z.strip() for z in self.txt_priority.get("1.0", "end").splitlines() if z.strip()]
        try:
            qty = int(self.inp_qty.get().strip())
        except Exception:
            qty = 1

        cfg["auto_seat"]["platform"]       = self.sel_platform.get()
        cfg["auto_seat"]["seat_mode"]      = self.sel_mode.get()
        cfg["auto_seat"]["zone_priority"]  = zones
        cfg["auto_seat"]["priority_targets"] = zones
        cfg["auto_seat"]["quantity"]       = qty
        cfg["auto_seat"]["enabled"]        = self.var_enabled.get()

        save_config(cfg)
        self._cfg = cfg
        self.add_log("💾 Đã lưu config.", "green")

    def _on_toggle_bot(self):
        self._save_config()
        self._update_status_label()

    def _on_platform_change(self, _val):
        pass  # có thể filter seat_mode sau

    def _update_status_label(self):
        if self.var_enabled.get():
            self.lbl_status.configure(text="🟢  Bot đang bật", text_color=COLOR_OK)
        else:
            self.lbl_status.configure(text="⏸  Bot tắt", text_color=COLOR_MUTED)

    # ── Log ──────────────────────────────────────────────────────────────────

    def add_log(self, msg: str, color: str = "white"):
        ts  = datetime.now().strftime("%H:%M:%S")
        clr = LOG_COLORS.get(color, COLOR_TEXT)
        full = f"[{ts}] {msg}\n"
        self.log_box.configure(state="normal")
        self.log_box.insert("end", full)
        self.log_box.tag_add(ts, f"end - {len(full)+1}c", "end - 1c")
        self.log_box.tag_config(ts, foreground=clr)
        self.log_box.configure(state="disabled")
        self.log_box.see("end")
        logger.info(msg)

    def _clear_log(self):
        self.log_box.configure(state="normal")
        self.log_box.delete("1.0", "end")
        self.log_box.configure(state="disabled")

    # ── Cleanup ───────────────────────────────────────────────────────────────

    def _on_close(self):
        try:
            self._api_server.shutdown()
        except Exception:
            pass
        self.destroy()


# ── Helpers ───────────────────────────────────────────────────────────────────

def _set(widget, val: str):
    if isinstance(widget, ctk.CTkEntry):
        widget.delete(0, "end")
        widget.insert(0, val)
    elif isinstance(widget, ctk.CTkTextbox):
        widget.delete("1.0", "end")
        widget.insert("1.0", val)


# ── Entry point ───────────────────────────────────────────────────────────────

if __name__ == "__main__":
    app = App()
    app.mainloop()
