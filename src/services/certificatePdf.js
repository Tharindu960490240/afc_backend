// Certificate of appointment: one A4 page in the college's design, made when the college countersigns the
// agreement and sent to the agent when onboarding is finished.
const path = require("path");
const PDFDocument = require("pdfkit");
const college = require("../emails/college");
const doc = require("./agreementDocument");

const ASSETS = path.join(__dirname, "..", "emails", "assets");
const FONT = path.join(__dirname, "..", "assets", "fonts", "Anton-Regular.woff");
const LOGO = path.join(ASSETS, "afc-logo-full.png");
const MARK = path.join(ASSETS, "afc-mark.png");
const SIGNATURE = path.join(ASSETS, "signature-sohel-rana.png");
const NAVY = "#2b2f7e";
const RED = "#ed1c24";
const INK = "#111111";

const clean = (s) => String(s || "").replace(/\s+/g, " ").trim();

// a: agreement row from agreementRepo.findForDocument (after it is active)
function render(a) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({
      size: "A4", margin: 0, autoFirstPage: true,
      info: { Title: "Certificate of Appointment", Author: college.name, Subject: doc.reference(a.id) },
    });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    try {
      let bold = "Helvetica-Bold";
      try { pdf.registerFont("Anton", FONT); bold = "Anton"; } catch { /* falls back to Helvetica */ }
      const W = pdf.page.width;
      const H = pdf.page.height;
      const centre = (text, y, size, opts = {}) => {
        pdf.font(bold).fontSize(size).fillColor(opts.color || INK);
        pdf.text(text, 0, y, { width: W, align: "center", characterSpacing: opts.spacing || 0, lineGap: opts.lineGap || 0 });
      };

      // faded logo mark behind the text
      try { pdf.save().opacity(0.2); pdf.image(MARK, -63, 128, { width: 331 }); pdf.restore(); } catch { /* optional */ }

      // logo, top right
      try { pdf.image(LOGO, 383, 46, { width: 160 }); } catch { /* optional */ }

      centre("Certificate of Appointment", 160, 32, { spacing: 6.2 });
      centre("This is to confirm that", 258, 20);

      // the agency name, shrunk to fit one line
      const name = clean(a.agency_name || `${a.agent_first_name} ${a.agent_last_name}`).toUpperCase();
      let size = 46;
      pdf.font(bold);
      while (size > 16 && pdf.fontSize(size).widthOfString(name) > W - 110) size -= 1;
      centre(name, 362 + (46 - size) / 2, size);

      centre("has been appointed as an authorised", 498, 20);
      centre(`representative of ${college.name}.`, 525, 20);

      // signature block
      const signer = college.signer || {};
      try { pdf.image(SIGNATURE, 112, 618, { width: 100 }); } catch { /* optional */ }
      pdf.rect(70, 660, 89, 2.5).fill(NAVY);
      pdf.rect(159, 660, 89, 2.5).fill(RED);
      pdf.font(bold).fontSize(16.5).fillColor(INK).text(clean(signer.name) || "Authorised representative", 70, 670, { width: 178, align: "center", characterSpacing: 3 });
      pdf.font(bold).fontSize(19).fillColor(INK).text(clean(signer.position), 30, 692, { width: 258, align: "center" });

      // website and registration line
      pdf.font(bold).fontSize(20).fillColor(RED).text(college.websiteLabel, 0, 738, { width: W - 32, align: "right" });
      pdf.rect(0, 782, W, 3).fill(NAVY);
      pdf.rect(0, 820, W, 3).fill(NAVY);
      const parts = [["ABN:", college.abn], ["RTO Code:", college.rto], ["CRICOS Provider No.:", college.cricos]];
      pdf.font(bold).fontSize(19);
      const sp = 26;
      const widths = parts.map(([l, v]) => pdf.widthOfString(`${l} `) + pdf.widthOfString(v));
      let x = (W - (widths.reduce((s, w) => s + w, 0) + sp * (parts.length - 1))) / 2;
      parts.forEach(([l, v], i) => {
        pdf.fillColor(NAVY).text(`${l} `, x, 793, { lineBreak: false });
        pdf.fillColor(RED).text(v, x + pdf.widthOfString(`${l} `), 793, { lineBreak: false });
        x += widths[i] + sp;
      });
      pdf.end();
    } catch (err) {
      reject(err);
    }
  });
}
module.exports = { render };
