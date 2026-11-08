// Shared CSV helpers (NF-13). Every export uses these so the formula-injection guard is in one place.
const csvCell = (v) => {
  let s = v == null ? "" : Array.isArray(v) ? v.join("; ") : typeof v === "object" && !(v instanceof Date) ? JSON.stringify(v) : v instanceof Date ? v.toISOString() : String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`; // stops spreadsheet formulas from running
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const toCsv = (header, rows) => [header, ...rows].map((r) => r.map(csvCell).join(",")).join("\r\n");

// Sends a CSV as a download. The byte-order mark lets Excel read UTF-8 correctly.
function sendCsv(res, name, csv) {
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="${name}-${new Intl.DateTimeFormat("en-CA", { timeZone: process.env.APP_TIMEZONE || "Australia/Melbourne" }).format(new Date())}.csv"`,
    "Cache-Control": "no-store",
  });
  res.send(String.fromCharCode(0xfeff) + csv);
}

module.exports = { csvCell, toCsv, sendCsv };
