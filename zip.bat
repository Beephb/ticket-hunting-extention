@echo off
REM ── Đóng gói release ZIP để gửi cho khách ────────────────────────────────────
REM
REM Tiền điều kiện:
REM   - Đã chạy build.bat trước (cần có dist\SanVePro.exe)
REM
REM Output: release\SanVePro-v2.0.zip
REM Nội dung zip:
REM   - SanVePro.exe       (desktop app standalone)
REM   - extension\         (Chrome extension folder)

setlocal EnableDelayedExpansion

set VERSION=2.0.0
set ZIP_NAME=SanVePro-v%VERSION%.zip

echo.
echo ============================================================
echo   Đóng gói release: %ZIP_NAME%
echo ============================================================

REM ── Verify dist\SanVePro.exe exists ─────────────────────────────────────────
if not exist "dist\SanVePro.exe" (
    echo [X] Không tìm thấy dist\SanVePro.exe
    echo     Chạy build.bat trước!
    pause
    exit /b 1
)

REM ── Clean old release ────────────────────────────────────────────────────────
if exist "release" rmdir /s /q "release"
mkdir release

REM ── Copy files ───────────────────────────────────────────────────────────────
echo [...] Copy SanVePro.exe + extension\ vào staging...
copy "dist\SanVePro.exe" "release\" >nul
xcopy "extension" "release\extension\" /E /I /Y /Q >nul

REM ── Compress ─────────────────────────────────────────────────────────────────
echo [...] Compress thành ZIP...
powershell -Command "Compress-Archive -Path 'release\SanVePro.exe', 'release\extension' -DestinationPath 'release\%ZIP_NAME%' -Force -CompressionLevel Optimal"

if not exist "release\%ZIP_NAME%" (
    echo [X] Compress thất bại
    pause
    exit /b 1
)

REM ── Xoá staging, chỉ giữ zip ────────────────────────────────────────────────
del "release\SanVePro.exe"
rmdir /s /q "release\extension"

REM ── Copy file hướng dẫn .txt (KHÔNG đưa vào zip, để cạnh zip) ───────────────
if exist "HUONG_DAN_CAI_DAT.txt" (
    copy "HUONG_DAN_CAI_DAT.txt" "release\" >nul
    echo [OK] Da copy HUONG_DAN_CAI_DAT.txt vao release\
) else (
    echo [!] Khong tim thay HUONG_DAN_CAI_DAT.txt o root - skip
)

for %%A in ("release\%ZIP_NAME%") do set ZSIZE=%%~zA
set /a ZSIZEMB=!ZSIZE!/1048576

echo.
echo ============================================================
echo   ĐÓNG GÓI THÀNH CÔNG
echo ============================================================
echo.
echo   Folder release\ co 2 file:
echo     - %ZIP_NAME%      (!ZSIZEMB! MB - file chinh)
echo     - HUONG_DAN_CAI_DAT.txt   (gui kem cho khach doc)
echo.
echo   Gui CA 2 FILE cho khach.
echo.
pause
