// The completed Education Agent Application Form (AFC-EAAF V2.0), drawn from the agent record.
// Saved in the agent folder by staff (Processing Agent Application, step 1).
const PDFDocument = require("pdfkit");
const college = require("../emails/college");

const NAVY = "#1f2a7a";
const GREY = "#6b7280";
const INK = "#1b1f2a";
const yn = (v) => (v === true ? "Yes" : v === false ? "No" : "");
const date = (d) => (d ? new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "");

// a: agent row (comsAgentRepo.findById), persons, referees
function render({ agent: a, persons, referees, documents }) {
  return new Promise((resolve, reject) => {
    const pdf = new PDFDocument({ size: "A4", margins: { top: 56, bottom: 60, left: 56, right: 56 }, bufferPages: true,
      info: { Title: `Education Agent Application Form - ${a.legal_name}`, Author: college.name, Subject: "AFC-EAAF V2.0" } });
    const chunks = [];
    pdf.on("data", (c) => chunks.push(c));
    pdf.on("end", () => resolve(Buffer.concat(chunks)));
    pdf.on("error", reject);
    try {
      const x = a.application_extra || {};
      const w = pdf.page.width - 112;
      const ensure = (h) => { if (pdf.y + h > pdf.page.height - 70) pdf.addPage(); };
      const h1 = (t) => { ensure(40); pdf.moveDown(0.8); pdf.font("Helvetica-Bold").fontSize(12).fillColor(NAVY).text(t); pdf.moveDown(0.3); };
      const row = (label, value) => {
        const v = value === null || value === undefined || value === "" ? "-" : String(value);
        ensure(22);
        const y = pdf.y;
        pdf.font("Helvetica").fontSize(9.5).fillColor(GREY).text(label, 56, y, { width: 190 });
        const h1y = pdf.y;
        pdf.font("Helvetica").fontSize(10).fillColor(INK).text(v, 256, y, { width: w - 200 });
        pdf.y = Math.max(h1y, pdf.y) + 3;
      };
      const list = (label, items) => {
        if (!items || !items.length) return row(label, "None");
        items.forEach((t, i) => row(i === 0 ? label : "", t));
      };

      pdf.font("Helvetica-Bold").fontSize(18).fillColor(NAVY).text("Education Agent Application Form", { align: "left" });
      pdf.font("Helvetica").fontSize(9).fillColor(GREY).text(`AFC-EAAF V 2.0  |  ${college.name}  |  RTO ${college.rto}  CRICOS ${college.cricos}`);
      pdf.text(`Submitted ${date(a.application_submitted_at) || "(not yet submitted)"}`);

      h1("1. Company profile");
      row("a) Legal name", a.legal_name);
      row("b) Trading names", (a.trading_names || []).join(", "));
      row("c) ACN/ABN number", a.abn_acn);
      row("d) Registered for GST", yn(a.gst_registered));
      row("e) Address", a.principal_address);
      row("   Registered office", a.registered_office_address);
      row("   Postal address", a.postal_address);
      row("f) Contact number", a.phone);
      row("g) Contact email", a.email);
      row("   Website", a.website);
      row("   Agency MARN", a.marn);
      row("h) Chief Executive Officer / Owner", a.owner_name);
      row("i) Number of staff", a.staff_count);
      list("j) Key staff and consultants", persons.map((p) => `${p.name} (${p.role === "sub_agent" ? "sub-agent" : p.role})${p.marn ? `, MARN ${p.marn}` : ""} - ${p.email}`));
      row("k) Years in existence", a.years_in_business);
      list("l) Services provided", x.services);
      list("m) Offshore offices", (x.offshore_offices || []).map((o) => `${o.location}${o.details ? `: ${o.details}` : ""}`));
      list("n) Sub-contractors", (x.sub_contractors || []).map((o) => `${o.location}${o.details ? `: ${o.details}` : ""}`));
      list("o) Offshore partners", (x.offshore_partners || []).map((o) => `${o.location}${o.details ? `: ${o.details}` : ""}`));

      h1("2. Company registration details");
      list("Registrations", (x.registrations || []).map((r) => `${r.number} (${r.country})`));

      h1("3. Past and present experience recruiting students");
      list("a) Australian sectors (VET / University)", (x.recruited_australia || []).map((r) => `${r.sector}: ${r.students} students`));
      list("b) All other education sectors", (x.recruited_other || []).map((r) => `${r.sector}: ${r.students} students`));

      h1("4. Familiarity with the Australian education industry");
      row("a) Read and understood the ESOS Act 2000", yn(x.esos_read));
      if (x.esos_read === false) row("   Intends to familiarise", yn(x.esos_intend));
      row("b) Read and understood the National Code 2018", yn(x.national_code_read));
      if (x.national_code_read === false) row("   Intends to familiarise", yn(x.national_code_intend));

      h1("5. Personal experience");
      row("a) Education industry", x.experience_education);
      row("b) Other major business areas", x.experience_other);

      h1("6. Markets from which you recruit");
      list("a) Current areas", (x.markets || []).map((m) => `${m.area}${m.characteristics ? `: ${m.characteristics}` : ""}`));
      row("b) Potential areas", x.potential_markets);

      h1("7. Professional organisations");
      list("Memberships", x.memberships);

      h1("8. Services to be provided to Australian Federation College");
      row("Outline", x.services_to_afc);

      h1("9. Referee details");
      referees.forEach((r, i) => {
        row(`${String.fromCharCode(97 + i)}) Company name`, r.organisation);
        row("   Contact person", r.name);
        row("   Position", r.position);
        row("   Phone", r.phone);
        row("   Email", r.email);
      });

      h1("Conflict of interest");
      row("Declared", yn(a.coi_declared));
      if (a.coi_declared) row("Details", a.coi_details);

      h1("10 and 11. Privacy notice and declaration");
      row("Privacy notice agreed", a.privacy_agreed_at ? `Yes, ${date(a.privacy_agreed_at)}` : "");
      row("Information true and correct", a.information_confirmed_at ? "Yes" : "");
      row("Understands National Code Standard 4 and the Code of Ethics", a.code_of_ethics_ack_at ? "Yes" : "");
      row("Declared by (CEO / Owner)", a.declaration_name);
      row("Date", date(a.declaration_at));

      h1("Application checklist");
      const has = (k) => (documents || []).some((d) => d.kind === k);
      row("Business registration certificate", has("business_registration") ? "Attached" : "Not attached");
      row("Brief organisational profile", has("agency_profile") ? "Attached" : "Not attached");
      row("Certificate of registration with MARA", has("mara_certificate") ? "Attached" : "Not attached / not applicable");

      const range = pdf.bufferedPageRange();
      for (let i = range.start; i < range.start + range.count; i++) {
        pdf.switchToPage(i);
        pdf.font("Helvetica").fontSize(8).fillColor(GREY)
          .text(`AFC-EAAF V 2.0  |  ${a.legal_name}  |  Page ${i + 1} of ${range.count}`, 56, pdf.page.height - 40, { width: w, align: "center", lineBreak: false });
      }
      pdf.end();
    } catch (e) { reject(e); }
  });
}
module.exports = { render };
