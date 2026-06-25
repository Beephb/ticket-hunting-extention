// ── platforms/ctiket/auth.js ──────────────────────────────────────────────────
// Quản lý JWT auth của Ctiket (Ory Kratos qua Google OAuth).
// User chỉ cần login Google sẵn trên tab cticket.vn — không cần nhập tay credentials.
// Bot lấy JWT từ /sessions/whoami bằng cookie session hiện có (credentials: include).

const CTIKET_BASE = "https://cticket.vn";

// Cache JWT trong bộ nhớ module — JWT có exp ~7 ngày (theo capture), không cần refresh liên tục
let _ctiketJwtCache = null;
let _ctiketJwtFetchedAt = 0;
const JWT_CACHE_TTL_MS = 5 * 60 * 1000; // 5 phút — đủ cho 1 phiên hunt, vẫn an toàn nếu JWT bị revoke giữa chừng

async function ctiketFetchJson(url, method = "GET", payload = null, extraHeaders = {}) {
  const opts = {
    method,
    credentials: "include",
    headers: {
      "Accept": "application/json, text/plain, */*",
      ...(payload ? { "Content-Type": "application/json" } : {}),
      ...extraHeaders,
    },
    signal: AbortSignal.timeout(6000),
  };
  if (payload) opts.body = JSON.stringify(payload);
  const res = await fetch(url, opts);
  const text = await res.text();
  let data = null;
  try { data = JSON.parse(text); } catch {}
  return { status: res.status, data, ok: res.ok, raw: text };
}

// Lấy JWT mới từ whoami — KHÔNG dùng cache (dùng khi cần đảm bảo token fresh)
async function fetchFreshCtiketJwt() {
  const { ok, data, status } = await ctiketFetchJson(`${CTIKET_BASE}/sessions/whoami?tokenize_as=jwt`);
  if (!ok || !data?.tokenized) {
    throw new Error(`whoami thất bại (status=${status}) — user có thể chưa login Google trên tab này`);
  }
  _ctiketJwtCache = data.tokenized;
  _ctiketJwtFetchedAt = Date.now();
  return _ctiketJwtCache;
}

// Lấy JWT — dùng cache nếu còn fresh (TTL 5 phút), fetch mới nếu hết hạn/chưa có
async function getCtiketJwt() {
  const age = Date.now() - _ctiketJwtFetchedAt;
  if (_ctiketJwtCache && age < JWT_CACHE_TTL_MS) return _ctiketJwtCache;
  return fetchFreshCtiketJwt();
}

function clearCtiketJwtCache() {
  _ctiketJwtCache = null;
  _ctiketJwtFetchedAt = 0;
}
