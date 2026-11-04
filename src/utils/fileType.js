// Decides what a file really is from its first bytes (the name and the
// browser's content-type can be faked). Returns { ext, mime } or null.
const SIGNATURES = [
  { ext: "pdf", mime: "application/pdf", test: (b) => b.slice(0, 5).toString("latin1") === "%PDF-" },
  { ext: "png", mime: "image/png", test: (b) => b.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { ext: "jpg", mime: "image/jpeg", test: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  {
    ext: "docx",
    mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    // .docx is a zip file; also require the .docx name so other zips are not accepted
    test: (b, name) => b[0] === 0x50 && b[1] === 0x4b && b[2] === 0x03 && b[3] === 0x04 && /\.docx$/i.test(name || ""),
  },
];

const detectFileType = (buffer, originalName) => {
  if (!buffer || buffer.length < 8) return null;
  const hit = SIGNATURES.find((s) => s.test(buffer, originalName));
  return hit ? { ext: hit.ext, mime: hit.mime } : null;
};

module.exports = { detectFileType };
