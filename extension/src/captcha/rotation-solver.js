// src/captcha/rotation-solver.js
// =======================================================
// 🔄 FILE CHUYÊN TRÁCH XỬ LÝ CAPTCHA XOAY TRÒN (TYPE B)
//     BẢN TỰ ĐỘNG CHẠY HOÀN TOÀN (ĐÃ GỠ CHẤM ĐỎ & CALIBRATION)
// =======================================================

const ROTATION_MAX_TRACK = 218; // Chiều dài tối đa hành trình kéo đã tối ưu theo thực tế

/**
 * Hàm gọi API server giải mã xoay tròn và kích hoạt kéo tự động qua CDP
 */
async function solveRotationType(base64Images, sliderButton) {
    const maxRetries = 3;
    let attempt = 0;

    const payload = {
        type: "rotation",
        images: base64Images.map(img => img.src)
    };

    while (attempt < maxRetries) {
        try {
            attempt++;
            console.log(`[Rotation API] Đang gửi dữ liệu lên Server (Lần thử ${attempt}/${maxRetries})...`);

            // Gọi /solve QUA background service worker thay vì fetch() thẳng
            // từ content script — xem ghi chú chi tiết trong puzzle-solver.js
            // (Chrome Local Network Access từ Chrome 141/142 chặn fetch từ
            // content script tới 127.0.0.1, host_permissions không miễn trừ
            // được cho content script).
            const msgResult = await chrome.runtime.sendMessage({ type: "SOLVE_CAPTCHA", payload });
            if (!msgResult) throw new Error("Không nhận được phản hồi từ background service worker.");
            if (!msgResult.ok) throw new Error(msgResult.error || "Lỗi không rõ khi gọi /solve qua background");
            const data = msgResult.data;
            let finalDragDistance = 0;

            if (data.distance_px) {
                finalDragDistance = data.distance_px;
            } else if (data.angle) {
                finalDragDistance = Math.round((data.angle / 360) * ROTATION_MAX_TRACK);
            } else {
                throw new Error("Không nhận được 'distance_px' hoặc 'angle' hợp lệ.");
            }

            console.log(`✅ [Rotation API] Server tính toán thành công: ${finalDragDistance}px`);

            // 🚀 KÍCH HOẠT KÉO TỰ ĐỘNG QUA CDP
            // Đo tọa độ thực tế của nút kéo trên màn hình để làm điểm xuất phát cho chuột phần cứng
            const rect = sliderButton.getBoundingClientRect();

            // Gửi thông điệp yêu cầu background.js (Service Worker) dùng Debugger Protocol để kéo
            chrome.runtime.sendMessage({
                action: "CDP_DRAG_SLIDER",
                distance: finalDragDistance,
                startX: rect.left + (rect.width / 2),
                startY: rect.top + (rect.height / 2)
            });

            return finalDragDistance;

        } catch (err) {
            console.warn(`⚠️ [Rotation API] Lần thử ${attempt} thất bại:`, err.message);
            if (attempt < maxRetries) {
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    console.error("❌ [Rotation API] Đã thử hết số lần quy định nhưng vẫn lỗi.");
    return 0;
}