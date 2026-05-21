# main.py — Săn Vé Pro v2.0
# Desktop App: Tab Chọn Vé (chính) + Tab Thông Tin + Log panel

import json
import os
import threading
import logging
from http.server import HTTPServer, BaseHTTPRequestHandler
from datetime import datetime
import customtkinter as ctk

# ── Logging ───────────────────────────────────────────────────────────────────

LOG_FILE = "hunt.log"

def _setup_logging():
    handler = logging.FileHandler(LOG_FILE, mode="w", encoding="utf-8")
    handler.setFormatter(logging.Formatter("%(asctime)s %(message)s"))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)

_setup_logging()
logger = logging.getLogger(__name__)

CONFIG_FILE = "config.json"
API_PORT = 9279

DEFAULT_CONFIG = {
    "name": "", "phone": "", "email": "", "address": "",
    "auto_seat": {
        "platform": "1Zone",
        "seat_mode": "seat_zone",
        "zone_priority": [],
        "seat_map_priorities": [],  # [{zone, row, seat_range}]
        "quantity": 1,
        "require_adjacent": True,
        "allow_split_seats": False,
        "enabled": False,
    }
}

# ── Config helpers ────────────────────────────────────────────────────────────

def load_config():
    try:
        with open(CONFIG_FILE, "r", encoding="utf-8") as f:
            cfg = json.load(f)
        for k, v in DEFAULT_CONFIG.items():
            if k not in cfg:
                cfg[k] = v
        for k, v in DEFAULT_CONFIG["auto_seat"].items():
            if k not in cfg.get("auto_seat", {}):
                cfg.setdefault("auto_seat", {})[k] = v
        return cfg
    except Exception:
        return dict(DEFAULT_CONFIG)

def save_config(cfg):
    with open(CONFIG_FILE, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

# ── Localhost API ─────────────────────────────────────────────────────────────

_app_ref = None

class _Handler(BaseHTTPRequestHandler):
    def log_message(self, fmt, *args): pass

    def _send_json(self, code, data):
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
            self._send_json(200, load_config())
        elif self.path == "/ping":
            self._send_json(200, {"ok": True})
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
    def __init__(self, parent, on_delete, **kwargs):
        super().__init__(parent, fg_color=C_PANEL2, corner_radius=8, **kwargs)
        self.on_delete = on_delete
        self.grid_columnconfigure((0,1,2), weight=1)

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

        # Nút xóa
        ctk.CTkButton(self, text="✕", width=28, height=28, fg_color="#374151",
                      hover_color="#4b5563", font=("Arial", 11),
                      command=self._delete
                      ).grid(row=0, column=3, rowspan=2, padx=(4,8), pady=4)

    def _delete(self):
        self.destroy()
        self.on_delete()

    def get_value(self):
        zone  = self.inp_zone.get().strip()
        row   = self.inp_row.get().strip().upper()
        seat  = self.inp_seat.get().strip()
        # Build priority string theo format seat_map
        if row and seat:
            s = f"{row}:{seat}"
            if zone:
                s = f"{zone}|{s}"
            return s
        elif zone and not row and not seat:
            return zone
        elif row and not seat:
            return row
        return ""

    def set_value(self, val):
        # Parse lại từ string
        val = str(val or "")
        if "|" in val:
            zone_part, rest = val.split("|", 1)
            self.inp_zone.insert(0, zone_part)
            val = rest
        if ":" in val:
            r, s = val.split(":", 1)
            self.inp_row.insert(0, r)
            self.inp_seat.insert(0, s)
        elif val:
            self.inp_zone.insert(0, val)

# ── Main App ──────────────────────────────────────────────────────────────────

class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        global _app_ref
        _app_ref = self

        self.title("Săn Vé Pro v2.0")
        self.geometry("960x660")
        self.configure(fg_color=C_BG)
        self.resizable(True, True)
        self._cfg = load_config()
        self._seat_map_rows = []
        self._build_ui()
        self.load_config_to_ui()
        self._api_server = start_api_server()
        self.add_log(f"✅ API sẵn sàng tại port {API_PORT}", "green")
        self.add_log("📌 Load extension vào Chrome, extension sẽ tự kết nối.", "blue")
        self.protocol("WM_DELETE_WINDOW", self._on_close)

    # ── Build UI ──────────────────────────────────────────────────────────────

    def _build_ui(self):
        self.grid_columnconfigure(0, weight=0, minsize=380)
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

        # Bottom buttons
        btn_frame = ctk.CTkFrame(left, fg_color="transparent")
        btn_frame.grid(row=2, column=0, padx=14, pady=(6,14), sticky="ew")
        btn_frame.grid_columnconfigure((0,1), weight=1)

        ctk.CTkButton(btn_frame, text="💾  Lưu config", command=self._save_config,
                      fg_color="#1d4ed8", hover_color="#1e40af", height=36
                      ).grid(row=0, column=0, padx=(0,4), sticky="ew")
        ctk.CTkButton(btn_frame, text="🗑  Xoá log", command=self._clear_log,
                      fg_color="#374151", hover_color="#4b5563", height=36
                      ).grid(row=0, column=1, padx=(4,0), sticky="ew")

        # Nút xuất log
        ctk.CTkButton(left, text="📤  Xuất log ra file .txt", command=self._export_log,
                      fg_color="#1e293b", hover_color="#334155", height=30,
                      font=("Arial", 11), text_color=C_MUTED
                      ).grid(row=3, column=0, padx=14, pady=(0,14), sticky="ew")

        # ── Right panel: Log ──
        right = ctk.CTkFrame(self, fg_color=C_PANEL, corner_radius=16)
        right.grid(row=0, column=1, padx=(6,14), pady=14, sticky="nsew")
        right.grid_rowconfigure(1, weight=1)
        right.grid_columnconfigure(0, weight=1)

        hdr = ctk.CTkFrame(right, fg_color="transparent")
        hdr.grid(row=0, column=0, padx=16, pady=(14,6), sticky="ew")
        hdr.grid_columnconfigure(0, weight=1)
        ctk.CTkLabel(hdr, text="📋  LOG", font=("Arial", 14, "bold"),
                     text_color=C_ACCENT).grid(row=0, column=0, sticky="w")
        self.lbl_status = ctk.CTkLabel(hdr, text="⏸  Chờ...",
                                        font=("Arial", 11), text_color=C_MUTED)
        self.lbl_status.grid(row=0, column=1, sticky="e")

        self.log_box = ctk.CTkTextbox(right, font=("Consolas", 11), state="disabled",
                                       fg_color=C_PANEL2, wrap="word")
        self.log_box.grid(row=1, column=0, padx=12, pady=(0,12), sticky="nsew")

        # Build tabs
        self._build_tab_seat()
        self._build_tab_info()
        self._switch_tab("seat")

    # ── Tab Chọn Vé ──────────────────────────────────────────────────────────

    def _build_tab_seat(self):
        f = ctk.CTkFrame(self.tab_frame, fg_color="transparent")
        f.grid_columnconfigure(0, weight=1)
        self._tab_seat_frame = f

        # Platform
        ctk.CTkLabel(f, text="Nền tảng", font=("Arial", 11), text_color=C_MUTED
                     ).grid(row=0, column=0, padx=16, pady=(14,0), sticky="w")
        self.sel_platform = ctk.CTkOptionMenu(
            f, values=["1Zone", "Ticketbox"],
            command=self._on_mode_change, font=("Arial", 12)
        )
        self.sel_platform.grid(row=1, column=0, padx=16, pady=(2,8), sticky="ew")

        # Mode
        ctk.CTkLabel(f, text="Kiểu chọn vé", font=("Arial", 11), text_color=C_MUTED
                     ).grid(row=2, column=0, padx=16, pady=(0,0), sticky="w")
        self.sel_mode = ctk.CTkOptionMenu(
            f, values=["seat_zone", "seat_map"],
            command=self._on_mode_change, font=("Arial", 12)
        )
        self.sel_mode.grid(row=3, column=0, padx=16, pady=(2,8), sticky="ew")

        ctk.CTkFrame(f, height=1, fg_color=C_BORDER
                     ).grid(row=4, column=0, padx=16, pady=4, sticky="ew")

        # Dynamic area
        self.dynamic_frame = ctk.CTkFrame(f, fg_color="transparent")
        self.dynamic_frame.grid(row=5, column=0, padx=0, pady=0, sticky="ew")
        self.dynamic_frame.grid_columnconfigure(0, weight=1)

        # Số lượng + bật bot
        ctk.CTkLabel(f, text="Số lượng vé", font=("Arial", 11), text_color=C_MUTED
                     ).grid(row=6, column=0, padx=16, pady=(8,0), sticky="w")
        self.inp_qty = ctk.CTkEntry(f, placeholder_text="VD: 2", font=("Arial", 12))
        self.inp_qty.grid(row=7, column=0, padx=16, pady=(2,10), sticky="ew")

        self.var_enabled = ctk.BooleanVar(value=False)
        self.chk_enabled = ctk.CTkCheckBox(
            f, text="Bật bot tự động", variable=self.var_enabled,
            font=("Arial", 12, "bold"), text_color=C_OK,
            command=self._on_toggle_bot
        )
        self.chk_enabled.grid(row=8, column=0, padx=16, pady=(4,16), sticky="w")

    def _build_dynamic_zone(self):
        for w in self.dynamic_frame.winfo_children():
            w.destroy()

        ctk.CTkLabel(self.dynamic_frame, text="Ưu tiên khu vực (mỗi dòng 1 khu)",
                     font=("Arial", 11), text_color=C_MUTED
                     ).grid(row=0, column=0, padx=16, pady=(0,0), sticky="w")
        ctk.CTkLabel(self.dynamic_frame,
                     text="Bot thử theo thứ tự từ trên xuống",
                     font=("Arial", 10), text_color="#475569"
                     ).grid(row=1, column=0, padx=16, pady=(0,2), sticky="w")
        self.txt_priority = ctk.CTkTextbox(self.dynamic_frame, height=100,
                                            font=("Arial", 12))
        self.txt_priority.grid(row=2, column=0, padx=16, pady=(0,4), sticky="ew")

    def _build_dynamic_map(self):
        for w in self.dynamic_frame.winfo_children():
            w.destroy()
        self._seat_map_rows = []

        ctk.CTkLabel(self.dynamic_frame, text="Ưu tiên ghế",
                     font=("Arial", 11), text_color=C_MUTED
                     ).grid(row=0, column=0, padx=16, pady=(0,2), sticky="w")
        ctk.CTkLabel(self.dynamic_frame,
                     text="Để trống = bất kỳ  |  Hàng: M hoặc A-D  |  Ghế: 18 hoặc 15-20 hoặc 18,20",
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

    def _on_mode_change(self, _=None):
        mode = self.sel_mode.get()
        if mode == "seat_zone":
            self._build_dynamic_zone()
        else:
            self._build_dynamic_map()

    # ── Tab Thông Tin ─────────────────────────────────────────────────────────

    def _build_tab_info(self):
        f = ctk.CTkFrame(self.tab_frame, fg_color="transparent")
        f.grid_columnconfigure(0, weight=1)
        self._tab_info_frame = f

        fields = [
            ("Họ tên", "inp_name", "Nguyễn Văn A"),
            ("Số điện thoại", "inp_phone", "09xxxxxxxx"),
            ("Email", "inp_email", "email@example.com"),
            ("Địa chỉ", "inp_address", "Biên Hòa, Đồng Nai"),
        ]
        for i, (label, attr, placeholder) in enumerate(fields):
            ctk.CTkLabel(f, text=label, font=("Arial", 11), text_color=C_MUTED
                         ).grid(row=i*2, column=0, padx=16, pady=(14 if i==0 else 6, 0), sticky="w")
            inp = ctk.CTkEntry(f, placeholder_text=placeholder, font=("Arial", 12))
            inp.grid(row=i*2+1, column=0, padx=16, pady=(2,0), sticky="ew")
            setattr(self, attr, inp)

    # ── Switch tab ────────────────────────────────────────────────────────────

    def _switch_tab(self, tab):
        self._tab_seat_frame.grid_forget()
        self._tab_info_frame.grid_forget()

        if tab == "seat":
            self._tab_seat_frame.grid(row=0, column=0, sticky="ew")
            self.btn_tab_seat.configure(fg_color=C_ACCENT, text_color="#0f172a")
            self.btn_tab_info.configure(fg_color=C_BORDER, text_color=C_MUTED)
        else:
            self._tab_info_frame.grid(row=0, column=0, sticky="ew")
            self.btn_tab_info.configure(fg_color=C_ACCENT, text_color="#0f172a")
            self.btn_tab_seat.configure(fg_color=C_BORDER, text_color=C_MUTED)

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
        self._on_mode_change()

        mode = as_.get("seat_mode", "seat_zone")
        if mode == "seat_zone":
            zones = as_.get("zone_priority") or as_.get("priority_targets") or []
            self.txt_priority.delete("1.0", "end")
            self.txt_priority.insert("1.0", "\n".join(zones))
        else:
            priorities = as_.get("seat_map_priorities") or []
            # Clear rows cũ
            for w in self.seat_rows_frame.winfo_children():
                w.destroy()
            self._seat_map_rows = []
            if priorities:
                for p in priorities:
                    self._add_seat_map_row(p)
            else:
                self._add_seat_map_row()

        _set(self.inp_qty, str(as_.get("quantity", 1)))
        self.var_enabled.set(bool(as_.get("enabled", False)))
        self._update_status()

    def _save_config(self):
        cfg = load_config()
        cfg["name"]    = self.inp_name.get().strip()
        cfg["phone"]   = self.inp_phone.get().strip()
        cfg["email"]   = self.inp_email.get().strip()
        cfg["address"] = self.inp_address.get().strip()

        mode = self.sel_mode.get()
        try:
            qty = int(self.inp_qty.get().strip())
        except Exception:
            qty = 1

        cfg["auto_seat"]["platform"]  = self.sel_platform.get()
        cfg["auto_seat"]["seat_mode"] = mode
        cfg["auto_seat"]["quantity"]  = qty
        cfg["auto_seat"]["enabled"]   = self.var_enabled.get()

        if mode == "seat_zone":
            zones = [z.strip() for z in self.txt_priority.get("1.0", "end").splitlines() if z.strip()]
            cfg["auto_seat"]["zone_priority"]    = zones
            cfg["auto_seat"]["priority_targets"] = zones
            cfg["auto_seat"]["seat_map_priorities"] = []
        else:
            self._refresh_seat_rows()
            priorities = [r.get_value() for r in self._seat_map_rows if r.get_value()]
            cfg["auto_seat"]["seat_map_priorities"] = priorities
            cfg["auto_seat"]["zone_priority"]        = priorities
            cfg["auto_seat"]["priority_targets"]     = priorities

        save_config(cfg)
        self._cfg = cfg
        self.add_log("💾 Đã lưu config.", "green")

    def _on_toggle_bot(self):
        self._save_config()
        self._update_status()

    def _update_status(self):
        if self.var_enabled.get():
            self.lbl_status.configure(text="🟢  Bot đang bật", text_color=C_OK)
        else:
            self.lbl_status.configure(text="⏸  Bot tắt", text_color=C_MUTED)

    # ── Log ───────────────────────────────────────────────────────────────────

    def add_log(self, msg, color="white"):
        ts  = datetime.now().strftime("%H:%M:%S")
        clr = LOG_COLORS.get(color, C_TEXT)
        full = f"[{ts}] {msg}\n"
        self.log_box.configure(state="normal")
        self.log_box.insert("end", full)
        self.log_box.tag_add(ts, f"end - {len(full)+1}c", "end - 1c")
        self.log_box.tag_config(ts, foreground=clr)
        self.log_box.configure(state="disabled")
        self.log_box.see("end")
        logger.info(msg)

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
