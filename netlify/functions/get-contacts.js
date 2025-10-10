// netlify/functions/get-contacts.js
// Reads a Google Sheet CSV from SHEET_CSV_URL and builds numbers[] / emails[]
// Column-name agnostic: for each row, it detects preference ("text" | "email" | "both"),
// finds an email cell (contains "@"), and a phone cell (>=10 digits).
// Includes an optional debug mode: pass {"debug":true} in the POST body to see per-row decisions.

const Papa = require("papaparse");

exports.handler = async (event) => {
  // CORS
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: cors(), body: "" };
  }
  if (event.httpMethod !== "POST") {
    return { statusCode: 405, body: "Method Not Allowed" };
  }

  let debug = false;
  try {
    if (event.body) {
      const body = JSON.parse(event.body);
      debug = !!body.debug;
    }
  } catch {}

  try {
    const csvUrl = process.env.SHEET_CSV_URL;
    if (!csvUrl) return json(500, { ok: false, error: "SHEET_CSV_URL not set" });

    const res = await fetch(csvUrl, { headers: { Accept: "text/csv" } });
    if (!res.ok) return json(500, { ok: false, error: `Failed to fetch CSV (${res.status})` });

    const csvText = await res.text();

    // Parse as array-of-arrays
    const parsed = Papa.parse(csvText, { dynamicTyping: false, skipEmptyLines: "greedy" });
    const rows = parsed?.data || [];
    if (!rows.length) return json(200, out({ numbers: [], emails: [] }, debug, { reason: "no rows" }));

    const numbers = new Set();
    const emails  = new Set();

    const diag = { header: rows[0], totalRows: rows.length - 1, samples: [] };

    // Process data rows (skip header)
    for (let r = 1; r < rows.length; r++) {
      const row = rows[r];
      if (!row || !row.length) continue;

      const pref  = findPreference(row); // "text" | "email" | "both" | null
      const email = findEmail(row);      // first cell with "@"
      const phone = findPhone(row);      // normalized phone or null

      if (debug && diag.samples.length < 6) {
        diag.samples.push({ r, pref, email, phone, raw: row });
      }

      if (!pref) continue;

      if ((pref === "text" || pref === "both") && phone) numbers.add(phone);
      if ((pref === "email" || pref === "both") && email) emails.add(email);
    }

    return json(200, out({ numbers: [...numbers], emails: [...emails] }, debug, diag));
  } catch (err) {
    return json(500, { ok: false, error: err.message || "Unexpected error" });
  }
};

// ---------- helpers ----------
function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
function json(code, obj) {
  return { statusCode: code, headers: { "Access-Control-Allow-Origin": "*" }, body: JSON.stringify(obj) };
}
function out(payload, debug, diag) {
  return debug ? { ok: true, ...payload, debug: diag } : { ok: true, ...payload };
}

// Preference finder: exact or startsWith matches, trimming unicode spaces/punct.
function findPreference(row) {
  for (const cell of row) {
    const v = norm(String(cell ?? ""));
    if (v === "text" || v.startsWith("text")) return "text";
    if (v === "email" || v.startsWith("email") || v === "e-mail" || v.startsWith("e-mail")) return "email";
    if (v === "both" || v.startsWith("both")) return "both";
    if (v === "sms" || v.startsWith("sms")) return "text"; // treat "SMS" as text
  }
  return null;
}

// Email finder: first cell containing "@"
function findEmail(row) {
  for (const cell of row) {
    const v = String(cell ?? "").trim();
    if (v.includes("@")) return v;
  }
  return null;
}

// Phone finder: first cell that looks like a number (>=10 digits).
// Normalize: 10 digits -> +1XXXXXXXXXX, 11 starting with 1 -> +XXXXXXXXXXX, else "+<digits>"
function findPhone(row) {
  for (const cell of row) {
    const raw = String(cell ?? "").trim();
    if (!raw) continue;

    if (/^\+\d{10,15}$/.test(raw)) return raw;

    const digits = raw.replace(/\D/g, "");
    if (digits.length >= 10) {
      if (digits.length === 10) return `+1${digits}`;
      if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
      return `+${digits}`;
    }
  }
  return null;
}

// normalize unicode/spacing/punct for matching
function norm(s) {
  return s
    .toLowerCase()
    .replace(/[\u00A0\u2000-\u200B]/g, " ")
    .replace(/\s+/g, " ")
    .replace(/[().,;:'"!?]/g, "")
    .trim();
}
