// ===============================
// Business-day calendar (NF-07).
// A working day is not a weekend and not a public holiday in any configured jurisdiction
// (Tasmania and Victoria by default). Dates are plain "YYYY-MM-DD" strings in the college's local time.
// ===============================
const env = require("../config/env");
const AppError = require("../utils/AppError");
const holidayRepo = require("../repositories/holidayRepo");
const audit = require("../repositories/auditRepo");

const TTL_MS = 5 * 60 * 1000;
let cache = null; // { at, byDate: Set of dates, years: Set }

async function load() {
  if (cache && Date.now() - cache.at < TTL_MS) return cache;
  const byDate = new Set();
  const years = new Set();
  for (const h of await holidayRepo.all()) {
    if (!env.holidayJurisdictions.includes(h.jurisdiction)) continue;
    byDate.add(h.holiday_date);
    years.add(Number(h.holiday_date.slice(0, 4)));
  }
  cache = { at: Date.now(), byDate, years };
  return cache;
}
const clearCache = () => { cache = null; };

const toUtc = (s) => new Date(`${s}T00:00:00Z`);
const fmt = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = toUtc(s); d.setUTCDate(d.getUTCDate() + n); return fmt(d); };
const isWeekend = (s) => [0, 6].includes(toUtc(s).getUTCDay());

// today's date (or any timestamp) as the college sees it
const localDate = (when = new Date()) =>
  new Intl.DateTimeFormat("en-CA", { timeZone: env.timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(when));

async function isBusinessDay(s) {
  const { byDate } = await load();
  return !isWeekend(s) && !byDate.has(s);
}

// n working days after `start` (the start day itself is not counted). n = 0 returns start.
async function addBusinessDays(start, n) {
  const { byDate } = await load();
  let d = start;
  let left = n;
  while (left > 0) {
    d = addDays(d, 1);
    if (!isWeekend(d) && !byDate.has(d)) left -= 1;
  }
  return d;
}

// working days in (from, to]. Negative when `to` is before `from`.
async function businessDaysBetween(from, to) {
  if (from === to) return 0;
  const { byDate } = await load();
  const sign = from < to ? 1 : -1;
  const [a, b] = sign === 1 ? [from, to] : [to, from];
  let count = 0;
  for (let d = addDays(a, 1); d <= b; d = addDays(d, 1)) {
    if (!isWeekend(d) && !byDate.has(d)) count += 1;
  }
  return count * sign;
}

// ---------- admin screen ----------
async function list() {
  const rows = await holidayRepo.all();
  const { years } = await load();
  return { rows, coveredYears: [...years].sort(), jurisdictions: env.holidayJurisdictions };
}

async function add(actor, body, ctx) {
  try {
    const created = await holidayRepo.add(body);
    clearCache();
    await audit.log({ actorId: actor.id, action: "holiday.added", entityType: "holiday", entityId: created.id, after: created, ...ctx });
    return created;
  } catch (err) {
    if (err.code === "23505") throw new AppError(409, "That holiday is already in the calendar.");
    throw err;
  }
}

async function remove(actor, id, ctx) {
  const row = await holidayRepo.findById(id);
  if (!row) throw new AppError(404, "Holiday not found.");
  await holidayRepo.remove(id);
  clearCache();
  await audit.log({ actorId: actor.id, action: "holiday.removed", entityType: "holiday", entityId: id, before: row, ...ctx });
}

module.exports = { isBusinessDay, addBusinessDays, businessDaysBetween, localDate, addDays, list, add, remove, clearCache };
