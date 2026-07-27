// src/captcha/puzzle-solver.js
// =======================================================
// 🧩 FILE CHUYÊN TRÁCH XỬ LÝ CAPTCHA MẢNH GHÉP (TYPE A)
// =======================================================
// GHI CHÚ (2026-07-18): đã thử nhánh đọc tile_x trực tiếp từ response capt/gen
// (tưởng là toạ độ "thật 100%" do server cung cấp sẵn), nhưng calibration tay
// thực tế (3 mẫu xác nhận check=200) cho thấy tile_x KHÔNG tương quan với
// khoảng cách kéo tay thành công (thứ tự tile_x 14→34→20 không khớp thứ tự
// khoảng cách kéo tay thật 93→121→143px) — có thể sai hệ quy chiếu hoặc field
// không phải ý nghĩa như giả định ban đầu. Đã BỎ nhánh này, quay lại dùng
// OpenCV như bản gốc — calibration tay xác nhận công thức đúng 100%
// (144px gốc -> 125px thực tế, khớp chính xác với kéo tay thật thành công).

const PUZZLE_OFFSET = -19; // Offset hiệu chỉnh tay, tinh chỉnh qua các mẫu HAR thật trước đây; đã xác nhận đúng qua calibration tay (144px gốc -> 125px thực tế, khớp 100% với kéo tay thật)

/**
 * Hàm gọi API Python giải mã mảnh ghép với cơ chế tự động thử lại khi lỗi
 * @param {HTMLElement} primaryImg - Thẻ img nền để lấy kích thước hiển thị (clientWidth)
 * @param {Array} base64Images - Mảng chứa chuỗi base64 của ảnh nền và mảnh ghép
 * @returns {Promise<number>} - Khoảng cách pixel cần kéo, trả về 0 nếu lỗi hoàn toàn
 */
async function solvePuzzleType(primaryImg, base64Images) {
    const maxRetries = 3; // Số lần thử lại tối đa cho mỗi chu kỳ quét
    let attempt = 0;

    const payload = {
        type: "puzzle",
        bg: base64Images[0].src,
        slice: base64Images[1].src
    };

    while (attempt < maxRetries) {
        try {
            attempt++;
            console.log(`[Puzzle API] Đang gửi dữ liệu lên Server (Lần thử ${attempt}/${maxRetries})...`);

            // Gọi /solve QUA background service worker thay vì fetch() thẳng
            // từ content script — fetch() ở content script chạy dưới danh
            // nghĩa trang web (ticketbox.vn), bị Chrome Local Network Access
            // (LNA, từ Chrome 141/142) chặn/chờ popup xin quyền user, không
            // có cách nào server tự động cho phép. Background service worker
            // được host_permissions miễn trừ, không bị LNA chặn.
            const msgResult = await chrome.runtime.sendMessage({ type: "SOLVE_CAPTCHA", payload });

            if (!msgResult) {
                throw new Error("Không nhận được phản hồi từ background service worker (có thể SW vừa bị Chrome kill).");
            }
            if (!msgResult.ok) {
                throw new Error(msgResult.error || "Lỗi không rõ khi gọi /solve qua background");
            }

            const data = msgResult.data;

            // Kiểm tra tính hợp lệ của tọa độ X trả về
            if (!data.x || data.x <= 5) {
                throw new Error("Tọa độ X trả về từ server không hợp lệ hoặc quá nhỏ.");
            }

            // --- BẮT ĐẦU TÍNH TOÁN LỰC KÉO ---
            console.log("=== [DEBUG BOT] ===");
            console.log("📸 Thẻ ảnh truyền vào:", primaryImg.src.slice(0, 50) + "...");
            console.log("📐 Chiều rộng hiển thị (clientWidth):", primaryImg.clientWidth);
            console.log("📊 Tọa độ X gốc từ Python trả về:", data.x);

            const scaleFactor = primaryImg.clientWidth / primaryImg.naturalWidth;
            const rawBotDistance = Math.round(data.x * scaleFactor);
            const finalDragDistance = rawBotDistance + PUZZLE_OFFSET;

            console.log("🎯 Khoảng cách Bot sẽ kéo thực tế:", finalDragDistance);
            console.log("===================");

            console.log(`✅ [Puzzle API] Giải thành công tại lần thử thứ ${attempt}. Gốc: ${data.x}px -> Thực tế: ${finalDragDistance}px`);

            return finalDragDistance;

        } catch (err) {
            console.warn(`⚠️ [Puzzle API] Lần thử ${attempt} thất bại:`, err.message);

            if (attempt < maxRetries) {
                // Chờ 1 giây trước khi tiến hành thử lại lần tiếp theo
                await new Promise(resolve => setTimeout(resolve, 1000));
            }
        }
    }

    console.error("❌ [Puzzle API] Đã thử lại toàn bộ số lần quy định nhưng Server vẫn lỗi.");
    return 0; // Trả về 0 để báo hiệu cho content.js giải phóng trạng thái quét lại
}