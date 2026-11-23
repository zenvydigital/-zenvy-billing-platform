'use strict';

/**
 * Shared helpers: errors, validation, dates, money, merge-updates, CSV parsing.
 *
 * Two rules from the artifact's verified bug fixes live here and are used by
 * every route:
 *   1. Partial updates MERGE with stored values — an omitted field is never
 *      blanked (applyMerge).
 *   2. Patients are stored by INITIALS ONLY — full names are rejected
 *      (initialsError), as is any date of birth.
 */

const ABA_CPTS = new Set(['97151', '97152', '97153', '97154', '97155', '97156', '97157', '97158']);

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** initials must be 1–10 chars, letters/dots/hyphens only, never a full name. */
function initialsError(value, label = 'Initials') {
  if (typeof value !== 'string' || !value.trim()) return `${label} are required — use initials only (e.g. A.B.).`;
  const v = value.trim();
  if (/\s/.test(v)) return `${label} must be initials only (e.g. A.B.) — never full names.`;
  if (v.length > 10) return `${label} must be 10 characters or fewer — use initials only (e.g. A.B.).`;
  if (!/^[A-Za-z][A-Za-z.\-']*$/.test(v)) {
    return `${label} may only contain letters, dots and hyphens (e.g. A.B.).`;
  }
  return null;
}

function isValidCpt(code) {
  return typeof code === 'string' && ABA_CPTS.has(code.trim());
}

function toMoney(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

function toInt(v, fallback = 0) {
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

/** Normalise a DATE / timestamp value to 'YYYY-MM-DD' (or null). */
function isoDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).slice(0, 10);
}

/** Whole days from today (UTC) until the given date. Negative = past. */
function daysUntil(dateStr) {
  if (!dateStr) return null;
  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const target = new Date(`${isoDate(dateStr)}T00:00:00Z`);
  return Math.round((target.getTime() - today.getTime()) / 86400000);
}

/** pg returns JSONB as an object; pg-mem may return a string — normalise. */
function asJson(v, fallback) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try {
      return JSON.parse(v);
    } catch {
      return fallback;
    }
  }
  return v;
}

/** Serialise a row for JSON: dates → YYYY-MM-DD, numerics → numbers. */
function cleanRow(row, moneyFields = [], dateFields = []) {
  if (!row) return row;
  const out = { ...row };
  for (const f of moneyFields) if (out[f] !== undefined && out[f] !== null) out[f] = Number(out[f]);
  for (const f of dateFields) if (out[f] !== undefined) out[f] = isoDate(out[f]);
  if (out.scrub_errors !== undefined) out.scrub_errors = asJson(out.scrub_errors, []);
  if (out.risk_factors !== undefined) out.risk_factors = asJson(out.risk_factors, []);
  if (out.items !== undefined) out.items = asJson(out.items, []);
  if (out.detail !== undefined) out.detail = asJson(out.detail, {});
  if (out.result !== undefined) out.result = asJson(out.result, {});
  if (out.created_at) out.created_at = new Date(out.created_at).toISOString();
  if (out.updated_at) out.updated_at = new Date(out.updated_at).toISOString();
  return out;
}

/**
 * Partial update that MERGES with the stored row: only fields present in
 * `body` (and whitelisted in `allowed`) are written; everything else keeps
 * its stored value. Returns the updated row. Never blanks omitted fields.
 */
async function applyMerge(q, table, row, allowed, body) {
  const sets = [];
  const params = [row.id];
  let i = 2;
  for (const f of allowed) {
    if (body[f] !== undefined) {
      sets.push(`${f} = $${i}`);
      params.push(body[f]);
      i += 1;
    }
  }
  if (sets.length === 0) return row;
  sets.push('updated_at = now()');
  const { rows } = await q(
    `UPDATE ${table} SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
    params
  );
  return rows[0];
}

/** Minimal CSV parser (handles quoted fields + commas inside quotes). */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  const pushField = () => { row.push(field); field = ''; };
  const pushRow = () => { pushField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 1; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\n') pushRow();
    else if (c === '\r') { /* skip */ }
    else field += c;
  }
  if (field !== '' || row.length > 0) pushRow();
  const nonEmpty = rows.filter((r) => r.some((c) => String(c).trim() !== ''));
  if (nonEmpty.length === 0) return [];
  const headers = nonEmpty[0].map((h) => String(h).trim());
  return nonEmpty.slice(1).map((r) => {
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = r[idx] !== undefined ? String(r[idx]).trim() : ''; });
    return obj;
  });
}

function toCsv(headers, rows) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(',')];
  for (const r of rows) lines.push(headers.map((h) => esc(r[h])).join(','));
  return lines.join('\n');
}

module.exports = {
  ABA_CPTS,
  ApiError,
  initialsError,
  isValidCpt,
  toMoney,
  toInt,
  isoDate,
  daysUntil,
  asJson,
  cleanRow,
  applyMerge,
  parseCsv,
  toCsv,
};
