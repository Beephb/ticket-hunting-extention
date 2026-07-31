# -*- mode: python ; coding: utf-8 -*-
# PyInstaller spec cho macOS - build .app bundle
# Chạy trên máy Mac (hoặc GitHub Actions macos-latest):
#   pyinstaller SanVePro_mac.spec --noconfirm --clean

from pathlib import Path
import customtkinter
from PyInstaller.utils.hooks import collect_all

CTK_PATH = Path(customtkinter.__file__).parent
cv2_datas, cv2_binaries, cv2_hiddenimports = collect_all('cv2')

block_cipher = None

a = Analysis(
    ['app/main.py'],
    pathex=[],
    binaries=cv2_binaries,
    datas=[
        (str(CTK_PATH), 'customtkinter'),
    ] + cv2_datas,
    hiddenimports=[
        'customtkinter',
        'tkinter',
        'email.utils',
        'http.client',
        'http.server',
        'cv2',
        'numpy',
    ] + cv2_hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[
        'matplotlib',
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
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='SanVePro',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=True,
    console=False,
    disable_windowed_traceback=False,
    argv_emulation=True,     # cần cho macOS GUI app
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=True,
    name='SanVePro',
)

app = BUNDLE(
    coll,
    name='SanVePro.app',
    icon=None,               # dùng default icon macOS
    bundle_identifier='vn.avaline.sanvepro',
    info_plist={
        'NSHighResolutionCapable': 'True',
        'LSMinimumSystemVersion': '10.13',
    },
)
