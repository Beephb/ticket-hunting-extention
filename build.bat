@echo off
REM ── Build SanVePro.exe with PyInstaller ──────────────────────────────────────
REM Output: dist\SanVePro.exe (~60-80 MB, single file)
REM
REM Usage:
REM   1. Mở PowerShell hoặc CMD
REM   2. cd vào folder chứa file này
REM   3. Chạy:  build.bat
REM   4. Sau khi xong: kết quả ở dist\SanVePro.exe
REM
REM Requirements (auto install nếu chưa có):
REM   - Python 3.10+
REM   - pip
REM   - pyinstaller
REM   - customtkinter

setlocal EnableDelayedExpansion

echo.
echo ============================================================
echo   SAN VE PRO v2.0 - Build Script
echo ============================================================
echo.

REM ── Check Python ─────────────────────────────────────────────────────────────
python --version >nul 2>&1
if errorlevel 1 (
    echo [X] Python khong tim thay. Cai Python 3.10+ tu python.org
    pause
    exit /b 1
)
for /f "tokens=2" %%i in ('python --version 2^>^&1') do set PYVER=%%i
echo [OK] Python !PYVER!

REM ── Install dependencies ─────────────────────────────────────────────────────
echo.
echo [...] Cai dependencies...
python -m pip install --quiet --upgrade pip
python -m pip install --quiet customtkinter pyinstaller
if errorlevel 1 (
    echo [X] Cai dependencies that bai
    pause
    exit /b 1
)
echo [OK] Dependencies san sang

REM ── Verify icon ──────────────────────────────────────────────────────────────
if not exist "build_assets\icon.ico" (
    echo [...] Tao icon.ico tu extension\icons\icon128.png...
    python -c "from PIL import Image; img = Image.open('extension/icons/icon128.png'); img.save('build_assets/icon.ico', format='ICO', sizes=[(16,16),(32,32),(48,48),(64,64),(128,128)])"
    if errorlevel 1 (
        echo [!] Tao icon that bai. Build se dung default icon.
    )
)

REM ── Clean old build ──────────────────────────────────────────────────────────
echo.
echo [...] Xoa build cu...
if exist "build" rmdir /s /q "build"
if exist "dist" rmdir /s /q "dist"

REM ── Build with PyInstaller ───────────────────────────────────────────────────
echo.
echo [...] Build .exe (mat 1-3 phut)...
pyinstaller SanVePro.spec --noconfirm --clean --log-level=WARN

if errorlevel 1 (
    echo.
    echo [X] BUILD THAT BAI! Check error tren.
    pause
    exit /b 1
)

REM ── Verify output ────────────────────────────────────────────────────────────
if not exist "dist\SanVePro.exe" (
    echo [X] Khong tim thay dist\SanVePro.exe. Build that bai.
    pause
    exit /b 1
)

for %%A in ("dist\SanVePro.exe") do set SIZE=%%~zA
set /a SIZEMB=!SIZE!/1048576

echo.
echo ============================================================
echo   BUILD THANH CONG!
echo ============================================================
echo.
echo   File:  dist\SanVePro.exe
echo   Size:  !SIZEMB! MB
echo.
echo   Test: dist\SanVePro.exe
echo   Distribute:
echo     1. ZIP dist\SanVePro.exe + extension\ folder
echo     2. Gui zip cho user
echo     3. User: extract + chay SanVePro.exe + Load extension vao Chrome
echo.
pause
