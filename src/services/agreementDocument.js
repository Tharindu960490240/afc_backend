// ===============================================================
// Agreement wording: placeholders, simple formatting and signature images.
//
// Template format (plain text):
//   # Title              -> big heading
//   ## 1. Clause heading -> clause heading
//   anything else        -> paragraph (a blank line starts a new one)
// Placeholders look like {{agent_name}}.
// ===============================================================
const env = require("../config/env");
const AppError = require("../utils/AppError");
const college = require("../emails/college");

// What each placeholder means (shown to the admin in the template editor).
const PLACEHOLDERS = {
  college_name: "College name",
  college_cricos: "College CRICOS provider number",
  college_rto: "College RTO code",
  agent_name: "Agent's full name",
  agent_email: "Agent's email",
  agency_name: "Agency name",
  business_number: "Agency business number",
  country: "Agency country",
  validity_months: "Length of the agreement in months",
  effective_date: "Start date (set when the college countersigns)",
  expiry_date: "End date (start date plus the length)",
};
// These two are filled in later, when the college countersigns.
const LATE = new Set(["effective_date", "expiry_date"]);

const findPlaceholders = (text) => [...String(text).matchAll(/\{\{\s*([a-z_]+)\s*\}\}/g)].map((m) => m[1]);

function assertTemplate(body) {
  const unknown = [...new Set(findPlaceholders(body).filter((k) => !PLACEHOLDERS[k]))];
  if (unknown.length) {
    throw new AppError(400, `Unknown placeholder: ${unknown.map((k) => `{{${k}}}`).join(", ")}`, {
      errors: { body: "Unknown placeholder" },
    });
  }
}

const fill = (text, values) =>
  String(text).replace(/\{\{\s*([a-z_]+)\s*\}\}/g, (all, key) => (key in values ? values[key] : all));

const longDate = (d) =>
  new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });

// Fills in everything known when the agreement is sent. Dates stay open.
function snapshotFor(templateBody, agent, months) {
  return fill(templateBody, {
    college_name: college.name,
    college_cricos: college.cricos,
    college_rto: college.rto,
    agent_name: `${agent.first_name} ${agent.last_name}`.trim(),
    agent_email: agent.email,
    agency_name: agent.agency_name || "the Agent's agency",
    business_number: agent.business_number || "not provided",
    country: agent.country || "not provided",
    validity_months: String(months),
  });
}

// Turns the snapshot into display blocks, filling the dates that are known by now.
function blocksFor(agreement) {
  const known = agreement.effective_date && agreement.expires_at;
  const text = fill(agreement.body_snapshot || "", {
    effective_date: known ? longDate(agreement.effective_date) : "the date the College countersigns this Agreement",
    expiry_date: known ? longDate(agreement.expires_at) : `the day ${agreement.validity_months} months after that date`,
  });
  return parseBlocks(text);
}

function parseBlocks(text) {
  const blocks = [];
  for (const chunk of String(text).replace(/\r\n/g, "\n").split(/\n{2,}/)) {
    // a heading line may sit directly above its paragraph, so go line by line
    let paragraph = [];
    const flush = () => {
      if (paragraph.length) blocks.push({ type: "p", text: paragraph.join(" ") });
      paragraph = [];
    };
    for (const raw of chunk.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("## ")) { flush(); blocks.push({ type: "h2", text: line.slice(3).trim() }); }
      else if (line.startsWith("# ")) { flush(); blocks.push({ type: "h1", text: line.slice(2).trim() }); }
      else paragraph.push(line);
    }
    flush();
  }
  return blocks;
}

// Example values so the admin can preview a template before saving it.
function sampleSnapshot(templateBody) {
  return snapshotFor(
    templateBody,
    { first_name: "Sample", last_name: "Agent", email: "sample.agent@example.com", agency_name: "Sample Education Pty", business_number: "00 000 000 000", country: "Australia" },
    12,
  );
}

// ---------- signature images ----------
const MAX_SIGNATURE_BYTES = 150 * 1024;

// Accepts "data:image/png;base64,..." from the signature pad. Returns a Buffer or null.
function parseSignatureImage(dataUrl) {
  if (dataUrl === undefined || dataUrl === null || dataUrl === "") return null;
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  const bad = () => new AppError(400, "The drawn signature could not be read. Please draw it again or type your name only.", { errors: { signature_image: "Invalid signature" } });
  if (!m) throw bad();
  const buf = Buffer.from(m[1], "base64");
  const pngMagic = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (buf.length < 100 || buf.length > MAX_SIGNATURE_BYTES || !buf.subarray(0, 8).equals(pngMagic)) throw bad();
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (width < 20 || height < 10 || width > 2000 || height > 1000) throw bad();
  return buf;
}

const reference = (id) => `AGR-${String(id).padStart(5, "0")}`;
const stamp = (d) =>
  new Date(d).toLocaleString("en-AU", { dateStyle: "long", timeStyle: "short", timeZone: env.timezone });

module.exports = {
  PLACEHOLDERS, LATE, assertTemplate, snapshotFor, blocksFor, parseBlocks, sampleSnapshot,
  parseSignatureImage, reference, stamp, longDate,
};
