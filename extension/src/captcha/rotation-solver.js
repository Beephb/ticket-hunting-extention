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

            const response = await fetch('http://127.0.0.1:9279/solve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) throw new Error(`HTTP Error: ${response.status}`);

            const data = await response.json();
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
