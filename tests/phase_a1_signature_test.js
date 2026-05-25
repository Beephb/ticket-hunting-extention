// Phase A1 — Test 1Zone x-signature có cover request body không.
//
// MỤC ĐÍCH:
//   Quyết định Tier E3 (mutate body) trong roadmap có khả thi không.
//
// CÁCH DÙNG:
//   1. Mở tab 1Zone booking page (cần đã login).
//   2. F12 → Console (chọn context "top").
//   3. Paste TOÀN BỘ snippet này, Enter.
//   4. Click "Tiếp tục" trên popup chọn vé ĐÚNG 1 LẦN.
//   5. Đọc kết luận trong console:
//        BODY_NOT_SIGNED  → Tier E3 khả thi
//        BODY_SIGNED      → Tier E3 KHÔNG khả thi (chỉ Tier P + E1/E2)
//        UNKNOWN          → cần test lại với mutation khác / event khác
//
// SIDE EFFECTS:
//   - Nếu signature KHÔNG cover body → request thành công → reserve vé thật → có
//     orderId. Vé sẽ tự expire sau ~15p nếu mày không thanh toán.
//   - Nếu signature CÓ cover body → server reject → request fail.
//   - Trong cả 2 trường hợp, Turnstile token bị consume → muốn test lại phải
//     refresh page để Turnstile re-challenge.
//
// PRECONDITION:
//   window.__SVP_HOOK__ phải tồn tại (extension SanVePro đã inject MAIN world).

(function() {
  if (!window.__SVP_HOOK__) {
    console.error("[A1] ❌ Network hook chưa install. Reload trang booking 1Zone.");
    return;
  }

  let captured = false;

  window.__SVP_HOOK__.setOnRequest((url, method, body, headers) => {
    if (!/order\/add-to-cart/.test(url)) return null;
    if (captured) {
      console.log("[A1] Bỏ qua request thứ 2+ (đã test 1 lần).");
      return null;
    }
    captured = true;

    console.log("%c[A1] ═══════ CAPTURED add-to-cart ═══════", "color:#38bdf8;font-weight:bold");
    console.log("[A1] URL:", url);
    console.log("[A1] Method:", method);
    console.log("[A1] Headers visible from hook:", headers ? Object.keys(headers) : "(none)");
    if (headers) {
      const sig = headers["x-signature"];
      const ts  = headers["x-timestamp"];
      const cap = headers["x-captcha-token"];
      console.log("[A1] x-signature      :", sig ? sig.slice(0, 16) + "..." + sig.slice(-8) : "(missing)");
      console.log("[A1] x-timestamp     :", ts || "(missing)");
      console.log("[A1] x-captcha-token  : len=" + (cap ? cap.length : 0));
    }
    console.log("[A1] Original body :", body);

    // Mutate: thêm 1 space cuối — preserve JSON validity, đổi byte content
    const mutated = body + " ";
    console.log("[A1] Mutated body  (+1 space at end):", mutated);
    console.log("[A1] Original len:", body.length, " Mutated len:", mutated.length);
    console.log("%c[A1] ═══════ Waiting response... ═══════", "color:#38bdf8");

    return mutated;
  });

  window.__SVP_HOOK__.setOnResponse((url, status, body, durationMs) => {
    if (!/order\/add-to-cart/.test(url)) return;
    if (!captured) return;

    console.log("%c[A1] ═══════ RESPONSE ═══════", "color:#38bdf8;font-weight:bold");
    console.log("[A1] Status   :", status);
    console.log("[A1] Duration :", Math.round(durationMs), "ms");
    console.log("[A1] Body (first 800 chars):", body.slice(0, 800));

    let conclusion = "UNKNOWN";
    let reason = "";

    if (status >= 200 && status < 300) {
      try {
        const parsed = JSON.parse(body);
        if (parsed.errorCode === 0 || parsed.data?._id || parsed.data?.orderId) {
          conclusion = "BODY_NOT_SIGNED";
          reason = "Server CHẤP NHẬN body đã mutate (status 200, có orderId).";
        } else {
          conclusion = "UNKNOWN";
          reason = "Status 200 nhưng errorCode=" + parsed.errorCode + ", message: " + (parsed.message || "");
        }
      } catch {
        conclusion = "UNKNOWN";
        reason = "Body không phải JSON.";
      }
    } else if (status === 401 || status === 403) {
      conclusion = "BODY_SIGNED";
      reason = "Status " + status + " — signature/auth invalid (rất có thể do mutate body).";
    } else if (status === 400) {
      try {
        const parsed = JSON.parse(body);
        const msg = String(parsed.message || "").toLowerCase();
        if (msg.includes("signature") || msg.includes("invalid") || msg.includes("verify") || msg.includes("ký")) {
          conclusion = "BODY_SIGNED";
          reason = "Status 400, message liên quan signature: " + parsed.message;
        } else {
          conclusion = "UNKNOWN";
          reason = "Status 400, message: " + parsed.message + " — không chắc do signature hay validation khác.";
        }
      } catch {
        conclusion = "UNKNOWN";
        reason = "Status 400, body không parse được.";
      }
    } else {
      conclusion = "UNKNOWN";
      reason = "Status " + status + " — không phân loại được.";
    }

    const color = conclusion === "BODY_NOT_SIGNED" ? "#22c55e" :
                  conclusion === "BODY_SIGNED"     ? "#ef4444" : "#facc15";

    console.log("%c[A1] ═══════ CONCLUSION: " + conclusion + " ═══════",
                "color:" + color + ";font-size:16px;font-weight:bold;background:#0f172a;padding:4px 8px");
    console.log("[A1] Reason:", reason);

    if (conclusion === "BODY_NOT_SIGNED") {
      console.log("%c[A1] → Tier E3 (mutate body) KHẢ THI.", "color:#22c55e");
      console.log("[A1]   Có thể nghiên cứu sửa body trước send để skip UI click.");
    } else if (conclusion === "BODY_SIGNED") {
      console.log("%c[A1] → Tier E3 KHÔNG KHẢ THI.", "color:#ef4444");
      console.log("[A1]   Production dùng Tier P (UI click). Fast path chỉ E1/E2 (frontend tự sign).");
    } else {
      console.log("%c[A1] → UNKNOWN. Test lại với mutation khác hoặc event khác.", "color:#facc15");
    }

    // Cleanup
    window.__SVP_HOOK__.setOnRequest(null);
    window.__SVP_HOOK__.setOnResponse(null);
    console.log("[A1] Hook detached. Click Tiếp tục sau sẽ chạy bình thường (không mutate).");
    console.log("[A1] Test xong. Copy toàn bộ log [A1] gửi cho dev để lưu memory.");
  });

  console.log("%c[A1] ✅ Hook installed. Bây giờ:", "color:#38bdf8;font-size:14px;font-weight:bold");
  console.log("[A1]   1. Vào trang booking (nếu chưa).");
  console.log("[A1]   2. Click zone → set số lượng vé → click 'Tiếp tục' ĐÚNG 1 LẦN.");
  console.log("[A1]   3. Đọc kết luận BODY_SIGNED / BODY_NOT_SIGNED / UNKNOWN trong console.");
  console.log("[A1] Mỗi snippet chỉ test 1 request. Muốn test lại: reload tab + paste snippet.");
})();
