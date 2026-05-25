// src/utils/mask.js
// Mask token, email, phone trước khi log → tránh leak PII/token vào file log

const MASK_TOKEN_FIELDS = new Set([
  "authorization",
  "cookie",
  "x-captcha-token",
  "x-signature",
  "x-tb-access-token",
  "x-tb-captcha-token",
  "access_token",
  "captcha_token",
  "captchaToken",
  "accessToken",
  "refreshToken",
  "token",
  "jwt",
]);

const MASK_PII_FIELDS = new Set([
  "phone",
  "phoneNumber",
  "email",
  "emailAddress",
]);

function maskToken(s, headLen = 10, tailLen = 5) {
  if (s == null) return "";
  const str = String(s);
  if (str.length < headLen + tailLen + 3) return "***";
  return str.slice(0, headLen) + "..." + str.slice(-tailLen);
}

function maskEmail(e) {
  if (!e) return "";
  const s = String(e);
  const at = s.indexOf("@");
  if (at <= 0) return "***";
  const head = s.charAt(0);
  return `${head}***${s.slice(at)}`;
}

function maskPhone(p) {
  if (!p) return "";
  const s = String(p).replace(/\D/g, "");
  if (s.length < 7) return "***";
  return s.slice(0, 3) + "****" + s.slice(-3);
}

function _maskValueByField(field, value) {
  const key = String(field).toLowerCase();
  if (MASK_TOKEN_FIELDS.has(key)) {
    // Bearer xxx → giữ "Bearer " prefix, mask phần token
    const v = String(value || "");
    if (/^bearer\s+/i.test(v)) {
      return "Bearer " + maskToken(v.replace(/^bearer\s+/i, ""));
    }
    return maskToken(v);
  }
  if (key === "phone" || key === "phonenumber") return maskPhone(value);
  if (key === "email" || key === "emailaddress") return maskEmail(value);
  return value;
}

function maskPayload(obj, depth = 0) {
  if (depth > 6) return obj;
  if (obj == null) return obj;
  if (typeof obj === "string" || typeof obj === "number" || typeof obj === "boolean") return obj;
  if (Array.isArray(obj)) return obj.map(x => maskPayload(x, depth + 1));
  if (typeof obj !== "object") return obj;

  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const lk = k.toLowerCase();
    if (MASK_TOKEN_FIELDS.has(lk) || MASK_PII_FIELDS.has(lk)) {
      out[k] = _maskValueByField(k, v);
    } else if (v && typeof v === "object") {
      out[k] = maskPayload(v, depth + 1);
    } else {
      out[k] = v;
    }
  }
  return out;
}

// Expose globals (content script không dùng module)
window.SVP_MASK = { maskToken, maskEmail, maskPhone, maskPayload };
