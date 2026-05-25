# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec for SanVePro v2.0
# Build: pyinstaller SanVePro.spec --noconfirm --clean

from pathlib import Path
import customtkinter

# ── Locate customtkinter assets (themes/fonts) ───────────────────────────────
CTK_PATH = Path(customtkinter.__file__).parent

block_cipher = None

a = Analysis(
    ['app/main.py'],
    pathex=[],
    binaries=[],
    datas=[
        # Bundle customtkinter assets (themes, fonts) — required at runtime
        (str(CTK_PATH), 'customtkinter'),
    ],
    hiddenimports=[
        'customtkinter',
        'tkinter',
        # Standard lib hidden imports (Python 3.11+ sometimes miss these)
        'email.utils',
        'http.client',
        'http.server',
    ],
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        # Loại module nặng không dùng (giảm size)
        'matplotlib',
        'numpy',
        'pandas',
        'scipy',
        'PIL.ImageQt',
        'PyQt5',
        'PyQt6',
        'PySide2',
        'PySide6',
        'IPython',
        'jupyter',
        'pytest',
        'pydoc',
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name='SanVePro',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=False,                      # windowed (no console)
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon='build_assets/icon.ico',
)
