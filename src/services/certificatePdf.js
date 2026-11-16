// Certificate of appointment (E1-5): one page, made when the college countersigns the agreement.
const path = require("path");
const PDFDocument = require("pdfkit");
const college = require("../emails/college");
const doc = require("./agreementDocument");

const LOGO = path.join(__dirname, "..", "emails", "assets", "afc-logo.png");
const NAVY = "#1f2a7a";
const GREY = "#6b7280";
const INK = "#1b1f2a";
const fmt = (d) => new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
const day = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

// a: agreement row from agreementRepo.findForDocument (after it is active)
function render(a) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margins: { top: 60, bottom: 60, left: 70, right: 70 }, info: { Title: "Certificate of Appointment", Author: college.name, Subject: doc.reference(a.id) } });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    try {
      const w = pdf.page.width - 140;
      pdf.rect(30, 30, pdf.page.width - 60, pdf.page.height - 60).lineWidth(1.5).strokeColor(NAVY).stroke();
      try { pdf.image(LOGO, (pdf.page.width - 150) / 2, 70, { height: 56 }); } catch { /* the logo is optional */ }
      pdf.font("Times-Bold").fontSize(30).fillColor(NAVY).text("Certificate of Appointment", 70, 170, { width: w, align: "center" });
      pdf.font("Helvetica").fontSize(11).fillColor(GREY).text("Education Agent", 70, 212, { width: w, align: "center" });
      pdf.moveTo(200, 240).lineTo(pdf.page.width - 200, 240).lineWidth(0.8).strokeColor(NAVY).stroke();
      pdf.font("Helvetica").fontSize(12).fillColor(INK).text("This is to certify that", 70, 275, { width: w, align: "center" });
      pdf.font("Times-Bold").fontSize(24).fillColor(INK).text(a.agency_name || `${a.agent_first_name} ${a.agent_last_name}`, 70, 305, { width: w, align: "center" });
      pdf.font("Helvetica").fontSize(12).fillColor(INK).text(
        `is appointed as a non-exclusive education agent of ${college.name} (CRICOS provider ${college.cricos}, RTO ${college.rto}) ` +
        `under the signed Education Agent Agreement, for the period`, 90, 360, { width: w - 40, align: "center", lineGap: 4 });
      pdf.font("Helvetica-Bold").fontSize(15).fillColor(NAVY).text(`${fmt(day(a.effective_date))}  to  ${fmt(day(a.expires_at))}`, 70, 430, { width: w, align: "center" });
      pdf.font("Helvetica").fontSize(10).fillColor(GREY).text("This appointment depends on the agent meeting the terms of the agreement and the National Code of Practice for Providers of Education and Training to Overseas Students.", 100, 470, { width: w - 60, align: "center", lineGap: 3 });
      pdf.moveTo(120, 640).lineTo(300, 640).lineWidth(0.6).strokeColor(GREY).stroke();
      pdf.font("Helvetica-Bold").fontSize(11).fillColor(INK).text(a.admin_sig_name || "Authorised representative", 120, 647, { width: 190 });
      pdf.font("Helvetica").fontSize(9.5).fillColor(GREY).text(`${a.admin_sig_position || "Authorised representative"}, ${college.name}`, 120, 662, { width: 190 });
      pdf.font("Helvetica").fontSize(9).fillColor(GREY)
        .text(`Reference ${doc.reference(a.id)}`, 340, 647, { width: 150, align: "right" })
        .text(`Issued ${fmt(new Date().toISOString().slice(0, 10))}`, 340, 660, { width: 150, align: "right" });
      pdf.end();
    } catch (err) {
      reject(err);
    }
  });
}
module.exports = { render };
