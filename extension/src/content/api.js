// src/content/api.js
// Fetch API từ browser context — dùng đúng cookie/session đang login

// ── 1Zone APIs ────────────────────────────────────────────────────────────────

const API_1ZONE = "https://prod.1zone.vn/ticketing/api";

async function api1zoneGetZones(eventId, calendarId) {
  const url = `${API_1ZONE}/v4/ticket-summary/get-summary-event/${eventId}/zones?calendarId=${encodeURIComponent(calendarId)}`;
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      "Accept": "application/json",
      "x-accept-language": "vi",
      "Accept-Language": "vi",
    },
  });
  if (!res.ok) throw new Error(`zones API ${res.status}`);
  return res.json();
}

async function api1zoneGetTickets(eventId, calendarId) {
  const url = `${API_1ZONE}/v4/event/${eventId}/tickets?calendarId=${encodeURIComponent(calendarId)}&type=group`;
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: {
      "Accept": "application/json",
      "x-accept-language": "vi",
    },
  });
  if (!res.ok) throw new Error(`tickets API ${res.status}`);
  return res.json();
}

// ── Ticketbox APIs ────────────────────────────────────────────────────────────

const API_TB = "https://api-v2.ticketbox.vn";

async function apiTbGetEvent(eventId) {
  const url = `${API_TB}/gin/api/v2/events/${eventId}`;
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`TB event API ${res.status}`);
  return res.json();
}

async function apiTbGetSeatmap(eventId, showingId, date) {
  let url = `${API_TB}/gin/api/v2/events/${eventId}/showings/${showingId}/seatmap`;
  if (date) url += `?date=${date}`;
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`TB seatmap API ${res.status}`);
  return res.json();
}

async function apiTbGetSections(eventId, showingId, date) {
  let url = `${API_TB}/gin/api/v2/events/${eventId}/showings/${showingId}/sections`;
  if (date) url += `?date=${date}`;
  const res = await fetch(url, {
    method: "GET",
    credentials: "include",
    headers: { "Accept": "application/json" },
  });
  if (!res.ok) throw new Error(`TB sections API ${res.status}`);
  return res.json();
}

// ── Extract IDs from current page ────────────────────────────────────────────

function extract1ZoneInfo() {
  const out = { url: location.href, eventId: "", calendarId: "", slug: "" };

  try {
    const m = location.pathname.match(/\/(?:events|booking)\/([^/?]+)/);
    if (m) out.slug = m[1];
  } catch {}

  try {
    out.calendarId = new URL(location.href).searchParams.get("calendarId") || "";
  } catch {}

  try {
    const d = window.__NEXT_DATA__?.props?.pageProps;
    const id = d?.event?.id || d?.eventId || d?.event?.eventId;
    if (id) out.eventId = String(id);
  } catch {}

  if (!out.eventId || !out.calendarId) {
    try {
      for (const e of performance.getEntriesByType("resource")) {
        const name = e.name;
        if (!out.eventId) {
          const m = name.match(/get-summary-event\/([A-Za-z0-9]+)/) ||
                    name.match(/\/event\/([A-Za-z0-9]+)\/tickets/) ||
                    name.match(/\/event\/([A-Za-z0-9]+)\/seatmap/) ||
                    name.match(/\/event\/([A-Za-z0-9]+)\//);
          if (m) out.eventId = m[1];
        }
        if (!out.calendarId) {
          const m = name.match(/[?&]calendarId=([A-Za-z0-9]+)/);
          if (m) out.calendarId = m[1];
        }
        if (out.eventId && out.calendarId) break;
      }
    } catch {}
  }

  return out;
}

function extractTicketboxInfo() {
  const out = { url: location.href, eventId: null, showingId: null, date: null };

  try {
    const m = location.pathname.match(/\/events\/(\d+)\/bookings\/(\d+)/);
    if (m) { out.eventId = parseInt(m[1]); out.showingId = parseInt(m[2]); }
  } catch {}

  if (!out.eventId) {
    try {
      const m = location.href.match(/-(\d{4,})(?:\?|$|\/)/);
      if (m) out.eventId = parseInt(m[1]);
    } catch {}
  }

  try {
    out.date = new URL(location.href).searchParams.get("date") || null;
  } catch {}

  if (!out.date) {
    try {
      for (const e of performance.getEntriesByType("resource")) {
        const m = e.name.match(/showings\/\d+\?date=(\d{4}-\d{2}-\d{2})/);
        if (m) { out.date = m[1]; break; }
      }
    } catch {}
  }

  return out;
}
