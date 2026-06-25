// src/captcha/puzzle-solver.js
// =======================================================
// 🧩 FILE CHUYÊN TRÁCH XỬ LÝ CAPTCHA MẢNH GHÉP (TYPE A)
// =======================================================

const PUZZLE_OFFSET = -19; // Cấu hình tinh chỉnh khoảng cách riêng của mảnh ghép

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

            const response = await fetch('http://127.0.0.1:9279/solve', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            });

            if (!response.ok) {
                throw new Error(`Server phản hồi lỗi HTTP: ${response.status}`);
            }

            const data = await response.json();

            // Kiểm tra tính hợp lệ của tọa độ X trả về
            if (!data.x || data.x <= 5) {
                throw new Error("Tọa độ X trả về từ server không hợp lệ hoặc quá nhỏ.");
            }

            // --- BẮT ĐẦU TÍNH TOÁN LỰC KÉO ---
            const scaleFactor = primaryImg.clientWidth / primaryImg.naturalWidth;
            const rawBotDistance = Math.round(data.x * scaleFactor);
            const finalDragDistance = rawBotDistance + PUZZLE_OFFSET;

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
