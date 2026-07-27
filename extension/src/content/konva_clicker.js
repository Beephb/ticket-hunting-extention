// src/content/konva_clicker.js
// Click zone Konva — dùng background executeScript để chạy trong page context
// Lý do: CSP của 1Zone block <script> injection, nhưng chrome.scripting.executeScript
//        với world:"MAIN" chạy được trong page context thật mà không bị CSP chặn

// ── Chạy code trong page context qua background ──────────────────────────────

function runInPage(fn, args = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(
      { type: "RUN_IN_PAGE", fn: fn.toString(), args },
      (res) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
          return;
        }
        if (res?.error) reject(new Error(res.error));
        else resolve(res?.result);
      }
    );
  });
}

// ── Chờ Konva load trong page context ────────────────────────────────────────

async function waitForKonva(timeoutMs = 15000) {
  svpLog("⏳ Chờ Konva load (page context)...", "blue");
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const result = await runInPage(function() {
        const stage = window.Konva?.stages?.[0];
        if (!stage) return { ready: false, reason: "no_stage" };
        const paths = Array.from(stage.find ? stage.find("Path") : []);
        return { ready: paths.length > 0, pathCount: paths.length };
      });
      if (result?.ready) {
        svpLog(`✅ Konva ready: ${result.pathCount} Path nodes (${Date.now() - start}ms)`, "green");
        return true;
      }
    } catch (e) {
      svpLog(`⚠️ Konva check: ${e.message}`, "yellow");
    }
    await sleep(300);
  }
  svpLog("❌ Timeout chờ Konva", "red");
  return false;
}

// ── Lấy tọa độ click từ page context ─────────────────────────────────────────

async function konvaGetZonePointsFromPage(idField, idValue) {
  return runInPage(function(args) {
    const idField = args.idField;
    const idValue = args.idValue;
    function safe(v) { return v === undefined || v === null ? "" : String(v); }

    const stage = window.Konva?.stages?.[0];
    if (!stage) return [{ x: -1, y: -1, mode: "NO_KONVA_STAGE" }];

    const paths = Array.from(stage.find ? stage.find("Path") : []);
    const target = paths.find(p =>
      safe(p.attrs?.[idField]) === safe(idValue) && !p.attrs?.disabled
    );

    if (!target) {
      const dbg = JSON.stringify(
        paths.slice(0, 8).map(p => ({
          text: p.attrs?.text,
          zoneId: p.attrs?.zoneId,
          sectionId: p.attrs?.sectionId,
          disabled: p.attrs?.disabled,
        }))
      ).slice(0, 800);
      return [{ x: -1, y: -1, mode: "NO_ZONE_PATH", debug: dbg }];
    }

    let r = null;
    try {
      r = target.getClientRect({ skipShadow: true, skipStroke: false });
      if (!r || !isFinite(r.x) || r.width < 1 || r.height < 1) r = null;
    } catch(e) {}
    if (!r) { try { r = target.getClientRect(); } catch(e) {} }
    if (!r || !isFinite(r.x) || r.width < 1 || r.height < 1) {
      return [{ x: -1, y: -1, mode: "ZONE_PATH_NO_RECT",
        debug: JSON.stringify(target.attrs || {}).slice(0, 400) }];
    }

    const attrs = target.attrs || {};
    const container = stage.container?.() ||
      document.querySelector(".konvajs-content") ||
      document.querySelector("canvas");
    const box = container?.getBoundingClientRect?.() ||
      { left: 0, top: 0, width: 0, height: 0 };
    const stageW = Number(stage.width?.() || stage.attrs?.width || box.width || 1);
    const stageH = Number(stage.height?.() || stage.attrs?.height || box.height || 1);
    const sx = box.width && stageW ? box.width / stageW : 1;
    const sy = box.height && stageH ? box.height / stageH : 1;

    const debug = JSON.stringify({
      text: attrs.text,
      [idField]: attrs[idField],
      disabled: attrs.disabled,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) },
      box: { left: Math.round(box.left||0), top: Math.round(box.top||0), w: Math.round(box.width||0), h: Math.round(box.height||0) },
      stage: { w: Math.round(stageW), h: Math.round(stageH) },
    });

    const out = [];
    const seen = new Set();
    const rels = [
      [0.50, 0.50, "center"],
      [0.50, 0.42, "upper-center"],
      [0.50, 0.58, "lower-center"],
      [0.35, 0.50, "left-center"],
      [0.65, 0.50, "right-center"],
      [0.25, 0.50, "left-safe"],
      [0.75, 0.50, "right-safe"],
    ];

    function add(x, y, mode) {
      if (!isFinite(x) || !isFinite(y)) return;
      const key = Math.round(x) + ":" + Math.round(y);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ x, y, mode, debug });
    }

    // SCALED — công thức đã xác nhận đúng
    for (const [rx, ry, m] of rels) {
      add(
        box.left + (r.x + r.width * rx) * sx,
        box.top  + (r.y + r.height * ry) * sy,
        "SCALED_" + m
      );
    }
    // DIRECT fallback
    for (const [rx, ry, m] of rels) {
      add(r.x + r.width * rx, r.y + r.height * ry, "DIRECT_" + m);
    }

    return out;
  }, { idField, idValue });
}

// ── Click zone và chờ dialog mở ──────────────────────────────────────────────

async function konvaClickZone(idField, idValue, zoneName, dialogChecker, maxPoints = 10) {
  let points;
  try {
    points = await konvaGetZonePointsFromPage(idField, idValue);
  } catch (e) {
    svpLog(`❌ Konva get points lỗi: ${e.message}`, "red");
    return false;
  }

  if (!points?.length || points[0].x < 0) {
    svpLog(
      `⚠️ Konva không tìm thấy Path: ${zoneName} | ${points?.[0]?.mode} | ${(points?.[0]?.debug || "").slice(0, 300)}`,
      "yellow"
    );
    return false;
  }

  svpLog(
    `🔎 Konva zone: ${zoneName} | candidates=${points.length} | ${(points[0]?.debug || "").slice(0, 300)}`,
    "blue"
  );

  const offsets = [[0, 0], [5, 0], [-5, 0], [0, 5], [0, -5]];

  for (const pt of points.slice(0, maxPoints)) {
    if (svpShouldStop?.()) { svpLog("🛑 Dừng click zone (stop signal)", "yellow"); return false; }
    const bx = pt.x, by = pt.y;
    const hit = elemAt(bx, by);
    svpLog(`🎯 Thử click: mode=${pt.mode} point=(${bx.toFixed(1)},${by.toFixed(1)}) hit=${hit}`, "blue");

    for (const [dx, dy] of offsets) {
      if (svpShouldStop?.()) { svpLog("🛑 Dừng click zone (stop signal)", "yellow"); return false; }
      await realClick(bx + dx, by + dy);
      for (let i = 0; i < 8; i++) {
        if (svpShouldStop?.()) { svpLog("🛑 Dừng click zone (stop signal)", "yellow"); return false; }
        await sleep(100);
        if (dialogChecker()) {
          svpLog(`✅ Popup mở: ${zoneName} | point=(${(bx+dx).toFixed(1)},${(by+dy).toFixed(1)})`, "green");
          return true;
        }
      }
    }
  }

  svpLog(`⚠️ Đã click hết điểm nhưng popup không mở: ${zoneName}`, "yellow");
  return false;
}