// src/captcha/content.js
// Guard chống double inject (pattern giống runner.js của SanVePro)
if (window.__SVP_CAPTCHA_INJECTED__) {
  console.log("[SVP Captcha] Already injected, skip");
} else {
window.__SVP_CAPTCHA_INJECTED__ = true;

console.log("[Extension Captcha] BẢN ĐA NHIỆM V8.2: Đã bóc tách 100% Core thành Module!");

// ── Khoá chống giải chồng lấn ──────────────────────────────────────────────
// Nếu vừa có 1 lần capt/check THÀNH CÔNG (có token) trong khoảng thời gian
// gần đây, không giải/kéo tiếp nữa — chờ Ticketbox tự đóng modal captcha.
// Lý do: DOM có thể còn hiện slider/ảnh base64 trong vài trăm ms sau khi đã
// verify xong (độ trễ animation/re-render), khiến vòng quét setInterval tưởng
// là captcha mới và giải/gửi check lần 2 cho session ĐÃ DÙNG RỒI -> bị từ chối
// (-1009), dù lần đầu đã đúng và thành công thật.
const RECENT_SUCCESS_GUARD_MS = 5000;

let isProcessing = false;
let currentImgSrc = "";

// --- Hàm chính xử lý quét và tự động phân loại ---
async function checkAndSolveCaptcha() {
    const sliderButton = document.querySelector('[class*="captcha-module_dragBlockInline"]') ||
        document.querySelector('[class*="captcha-module_dragBlock"]');

    const allImages = Array.from(document.querySelectorAll('img'));
    const base64Images = allImages.filter(img => img.src && img.src.includes('base64'));

    if (!sliderButton || base64Images.length === 0) {
        isProcessing = false;
        currentImgSrc = "";
        return;
    }

    // ── Guard: vừa xác minh captcha thành công gần đây thì bỏ qua, không giải
    // tiếp nữa — chờ Ticketbox tự đóng modal (tránh gửi check 2 lần cho cùng
    // session đã dùng rồi, dẫn tới -1009 dù lần đầu đã đúng).
    const lastCheck = window.__SVP_TB_CAPTURE__?.getLastCaptchaCheck?.();
    if (lastCheck && lastCheck.captchaToken && (Date.now() - lastCheck.ts) < RECENT_SUCCESS_GUARD_MS) {
        console.log(`✅ [Guard] Vừa xác minh captcha thành công ${Date.now() - lastCheck.ts}ms trước — bỏ qua, chờ trang tự đóng modal.`);
        return;
    }

    // Lấy ảnh nền làm dấu hiệu nhận biết captcha mới xuất hiện
    const primaryImg = base64Images[0];
    if (primaryImg && primaryImg.src !== currentImgSrc) {
        console.log("♻️ Phát hiện hành động Captcha mới! Đang phân tích loại...");
        currentImgSrc = primaryImg.src;
        isProcessing = false;
    }

    if (isProcessing) return;
    isProcessing = true;

    // 🎯 BƯỚC 1: TỰ ĐỘNG NHẬN DIỆN DẠNG CAPTCHA
    const isRotationType = !!document.querySelector('[class*="index-module_picture"]');
    let finalDragDistance = 0;
    let captchaType = "";

    try {
        // 🎯 BƯỚC 2: ĐIỀU PHỐI XỬ LÝ SANG CÁC FILE MODULE RIÊNG BIỆT
        if (isRotationType) {
            captchaType = "ROTATION";
            console.log("%c🔄 PHÁT HIỆN: Captcha Xoay Tròn (Type B)", "color: #3498db; font-weight: bold;");

            // 🔥 TRUYỀN THÊM sliderButton VÀO ĐỂ VẼ CHẤM ĐỎ VÀ ĐO ĐẠC
            finalDragDistance = await solveRotationType(base64Images, sliderButton);
        }
        else if (base64Images.length >= 2) {
            captchaType = "PUZZLE";
            console.log("%c🧩 PHÁT HIỆN: Captcha Mảnh Ghép (Type A)", "color: #e67e22; font-weight: bold;");

            finalDragDistance = await solvePuzzleType(primaryImg, base64Images);
        }
        else {
            isProcessing = false;
            return;
        }

        // 🎯 BƯỚC 3: KÍCH HOẠT PHẦN CỨNG ẢO
        if (finalDragDistance > 0) {
            console.log(`🤖 [${captchaType}] Lực kéo cuối cùng thực thi: ${finalDragDistance}px`);
            const rect = sliderButton.getBoundingClientRect();
            chrome.runtime.sendMessage({
                action: "drag_slider",
                startX: rect.left + (rect.width / 2),
                startY: rect.top + (rect.height / 2),
                distanceX: finalDragDistance
            });

            // Chờ hiệu ứng kéo của debugger chạy xong (khoảng 3.5 giây)
            setTimeout(() => { isProcessing = false; }, 3500);
        } else {
            isProcessing = false;
        }

    } catch (err) {
        console.error("❌ Lỗi hệ thống điều phối trong content.js:", err);
        isProcessing = false;
    }
}

// Quét liên tục mỗi giây để bắt kịp tốc độ xuất hiện của Captcha
setInterval(() => { checkAndSolveCaptcha().catch(() => { }); }, 1000);

} // end __SVP_CAPTCHA_INJECTED__ guard