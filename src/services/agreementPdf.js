// ===============================================================
// Builds the agreement PDF from the stored wording and signatures.
// Used for the downloadable copy at any stage and for the final signed file.
// ===============================================================
const path = require("path");
const PDFDocument = require("pdfkit");
const college = require("../emails/college");
const doc = require("./agreementDocument");

const LOGO = path.join(__dirname, "..", "emails", "assets", "afc-logo.png");
const NAVY = "#1f2a7a";
const GREY = "#6b7280";
const INK = "#1b1f2a";

// agreement: row from agreementRepo.findById plus the signature columns.
function render(agreement) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4",
      margins: { top: 60, bottom: 70, left: 58, right: 58 },
      bufferPages: true,
      info: {
        Title: agreement.title,
        Author: college.name,
        Subject: doc.reference(agreement.id),
      },
    });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);

    try {
      draw(pdf, agreement);
      stampFooters(pdf, agreement);
      pdf.end();
    } catch (err) {
      reject(err);
    }
  });
}

function draw(pdf, a) {
  const left = pdf.page.margins.left;
  const width = pdf.page.width - left - pdf.page.margins.right;
  const complete = a.stored_status === "active" && a.admin_signed_at && a.agent_signed_at;

  // header
  try { pdf.image(LOGO, left, 40, { height: 40 }); } catch { /* logo is optional */ }
  pdf.font("Helvetica").fontSize(8).fillColor(GREY)
    .text(`Reference ${doc.reference(a.id)}`, left, 46, { width, align: "right" })
    .text(complete ? "Fully signed" : a.agent_signed_at ? "Signed by the agent - awaiting the College" : "Not yet signed", left, 58, { width, align: "right" });
  pdf.moveTo(left, 92).lineTo(left + width, 92).lineWidth(1).strokeColor(NAVY).stroke();
  pdf.x = left;
  pdf.y = 108;

  // body
  for (const block of doc.blocksFor(a)) {
    if (block.type === "h1") {
      pdf.font("Times-Bold").fontSize(20).fillColor(NAVY).text(block.text, { width });
      pdf.moveDown(0.6);
    } else if (block.type === "h2") {
      ensureSpace(pdf, 70); // never leave a heading alone at the bottom of a page
      pdf.moveDown(0.5);
      pdf.font("Helvetica-Bold").fontSize(11).fillColor(NAVY).text(block.text, { width });
      pdf.moveDown(0.25);
    } else {
      pdf.font("Helvetica").fontSize(10).fillColor(INK).text(block.text, { width, lineGap: 2.5, align: "left" });
      pdf.moveDown(0.5);
    }
  }

  // details
  pdf.moveDown(0.8);
  ensureSpace(pdf, 120);
  pdf.font("Helvetica-Bold").fontSize(11).fillColor(NAVY).text("Agreement details", left, pdf.y);
  pdf.moveDown(0.4);
  const rows = [
    ["Agent", `${a.agent_first_name} ${a.agent_last_name}${a.agency_name ? `, ${a.agency_name}` : ""}`],
    ["Start date", a.effective_date ? doc.longDate(a.effective_date) : "Set when the College countersigns"],
    ["End date", a.expires_at ? doc.longDate(a.expires_at) : "-"],
    ["Length", `${a.validity_months} months`],
  ];
  for (const [k, v] of rows) {
    const y = pdf.y;
    pdf.font("Helvetica").fontSize(9.5).fillColor(GREY).text(k, left, y, { width: 90 });
    pdf.font("Helvetica").fontSize(9.5).fillColor(INK).text(v, left + 95, y, { width: width - 95 });
    pdf.moveDown(0.2);
  }

  // signatures (kept together on one page)
  pdf.moveDown(1.2);
  ensureSpace(pdf, 190);
  pdf.font("Helvetica-Bold").fontSize(11).fillColor(NAVY).text("Signatures", left, pdf.y);
  pdf.moveDown(0.3);
  pdf.font("Helvetica").fontSize(8.5).fillColor(GREY).text(
    "Signed electronically through the AFC portal. The name, date, time and network address of each signer are recorded.",
    left, pdf.y, { width },
  );
  pdf.moveDown(0.8);

  const top = pdf.y;
  const colW = (width - 30) / 2;
  signatureBlock(pdf, left, top, colW, {
    heading: "For the Agent",
    name: a.agent_sig_name,
    image: a.agent_sig_image,
    line1: a.agency_name || "",
    signedAt: a.agent_signed_at,
    ip: a.agent_signed_ip,
  });
  signatureBlock(pdf, left + colW + 30, top, colW, {
    heading: `For ${college.name}`,
    name: a.admin_sig_name,
    image: a.admin_sig_image,
    line1: a.admin_sig_position || "",
    signedAt: a.admin_signed_at,
    ip: a.admin_signed_ip,
  });
}

function signatureBlock(pdf, x, y, w, s) {
  pdf.font("Helvetica-Bold").fontSize(9.5).fillColor(INK).text(s.heading, x, y, { width: w });
  const boxTop = y + 18;
  const boxH = 56;
  if (s.name) {
    if (s.image) {
      try { pdf.image(s.image, x, boxTop, { fit: [w, boxH], align: "left", valign: "bottom" }); }
      catch { pdf.font("Times-Italic").fontSize(22).fillColor(INK).text(s.name, x, boxTop + 18, { width: w, lineBreak: false }); }
    } else {
      pdf.font("Times-Italic").fontSize(22).fillColor(INK).text(s.name, x, boxTop + 18, { width: w, lineBreak: false });
    }
  } else {
    pdf.font("Helvetica-Oblique").fontSize(9.5).fillColor(GREY).text("Awaiting signature", x, boxTop + 24, { width: w });
  }
  pdf.moveTo(x, boxTop + boxH + 4).lineTo(x + w, boxTop + boxH + 4).lineWidth(0.7).strokeColor("#9ca3af").stroke();
  pdf.font("Helvetica").fontSize(9.5).fillColor(INK).text(s.name || " ", x, boxTop + boxH + 9, { width: w });
  if (s.line1) pdf.font("Helvetica").fontSize(8.5).fillColor(GREY).text(s.line1, x, pdf.y, { width: w });
  if (s.signedAt) {
    pdf.font("Helvetica").fontSize(8.5).fillColor(GREY)
      .text(`Signed ${doc.stamp(s.signedAt)}`, x, pdf.y + 2, { width: w })
      .text(s.ip ? `Network address ${s.ip}` : "", x, pdf.y, { width: w });
  }
}

function ensureSpace(pdf, needed) {
  if (pdf.y > pdf.page.height - pdf.page.margins.bottom - needed) {
    pdf.addPage();
    pdf.y = pdf.page.margins.top;
  }
}

function stampFooters(pdf, a) {
  const range = pdf.bufferedPageRange();
  const fingerprint = a.body_sha256 ? a.body_sha256.slice(0, 12) : "-";
  for (let i = range.start; i < range.start + range.count; i++) {
    pdf.switchToPage(i);
    const left = pdf.page.margins.left;
    const width = pdf.page.width - left - pdf.page.margins.right;
    const y = pdf.page.height - 48;
    pdf.moveTo(left, y - 6).lineTo(left + width, y - 6).lineWidth(0.5).strokeColor("#d1d5db").stroke();
    // lineBreak:false and a zero bottom margin stop the footer from adding blank pages
    const savedBottom = pdf.page.margins.bottom;
    pdf.page.margins.bottom = 0;
    pdf.font("Helvetica").fontSize(7.5).fillColor(GREY)
      .text(`${college.name} - CRICOS ${college.cricos} - RTO ${college.rto}`, left, y, { width: width * 0.7, lineBreak: false })
      .text(`Page ${i + 1} of ${range.count}`, left, y, { width, align: "right", lineBreak: false })
      .text(`${doc.reference(a.id)} - document fingerprint ${fingerprint}`, left, y + 11, { width, lineBreak: false });
    pdf.page.margins.bottom = savedBottom;
  }
}

module.exports = { render };
