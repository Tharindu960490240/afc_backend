// A plain A4 letter in the college's style, used for the Letter of Offer and the Verification of Enrolment.
// The wording comes from the editable templates; this only sets it on the page.
const path = require("path");
const PDFDocument = require("pdfkit");
const college = require("../emails/college");

const LOGO = path.join(__dirname, "..", "emails", "assets", "afc-logo-full.png");
const NAVY = "#2b2f7e";

// text: paragraphs separated by blank lines; single line breaks are kept
function render({ title, text, ref, dateText }) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margins: { top: 60, bottom: 60, left: 64, right: 64 }, info: { Title: title, Author: college.name, Subject: ref } });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    try {
      try { pdf.image(LOGO, pdf.page.width - 64 - 150, 44, { width: 150 }); } catch { /* the logo is optional */ }
      pdf.font("Helvetica-Bold").fontSize(9).fillColor("#555555").text(`${college.name}  ·  CRICOS Provider 03846G  ·  RTO 45616`, 64, 50, { width: 300 });
      pdf.moveDown(4);
      pdf.font("Helvetica-Bold").fontSize(18).fillColor(NAVY).text(title, 64, 120);
      pdf.font("Helvetica").fontSize(9).fillColor("#555555").text(`Reference ${ref}  ·  ${dateText}`, { paragraphGap: 14 });
      pdf.moveTo(64, pdf.y).lineTo(pdf.page.width - 64, pdf.y).strokeColor("#d5d7ee").stroke();
      pdf.moveDown(1);
      pdf.font("Helvetica").fontSize(10.5).fillColor("#111111");
      String(text).split(/\n{2,}/).forEach((para) => { pdf.text(para.trim(), { lineGap: 3, paragraphGap: 10 }); });
    } catch (e) { reject(e); return; }
    pdf.end();
  });
}

module.exports = { render };
