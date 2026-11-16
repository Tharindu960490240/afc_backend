// Evidence files arrive as base64 inside a JSON body (no extra package, works on serverless hosting).
// Hosting limit: Vercel accepts request bodies up to 4.5 MB, so the default file limit is 3 MB. Raise
// EVIDENCE_MAX_MB only on a host with a larger body limit. Virus scanning is added in Part 6 (NF-08).
const AppError = require("./AppError");
const env = require("../config/env");

const TYPES = {
  pdf: "application/pdf",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  png: "image/png",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  eml: "message/rfc822",
  msg: "application/vnd.ms-outlook",
};
const MAGIC = {
  pdf: (b) => b.subarray(0, 4).toString("latin1") === "%PDF",
  png: (b) => b.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  jpg: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  docx: (b) => b[0] === 0x50 && b[1] === 0x4b,
  xlsx: (b) => b[0] === 0x50 && b[1] === 0x4b,
};
MAGIC.jpeg = MAGIC.jpg;

const fail = (message) => new AppError(400, message, { errors: { file: message } });

// file = { name, data }  (data is base64, with or without a data: prefix)
function parseUpload(file) {
  const ext = String(file.name).split(".").pop().toLowerCase();
  if (!TYPES[ext]) throw fail("This file type is not allowed. Use PDF, JPG, PNG, DOCX, XLSX, EML or MSG.");
  const b64 = String(file.data).replace(/^data:[^;]*;base64,/, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) throw fail("The file could not be read.");
  const buffer = Buffer.from(b64, "base64");
  if (!buffer.length) throw fail("The file is empty.");
  const max = env.evidenceMaxMb * 1024 * 1024;
  if (buffer.length > max) throw fail(`The file is too large. The limit is ${env.evidenceMaxMb} MB.`);
  if (MAGIC[ext] && !MAGIC[ext](buffer)) throw fail("The file does not match its type.");
  const name = String(file.name).replace(/[\\/\r\n\0]/g, "_").slice(-200);
  return { buffer, ext: ext === "jpeg" ? "jpg" : ext, mime: TYPES[ext], name };
}

module.exports = { parseUpload, TYPES };
