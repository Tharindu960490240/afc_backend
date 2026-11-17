// The AFC Education Agent Application Form V2.0 adds required answers (GST, owner, staff, services, markets, ...).
// Older test payloads are completed with these defaults wherever they are missing.
const EXTRA = {
  gst_registered: false, owner_name: "Test Owner", staff_count: 5, years_in_business: 7,
  extra: {
    services: ["Student counselling", "Visa guidance"], offshore_offices: [], sub_contractors: [], offshore_partners: [],
    registrations: [{ number: "REG-1234", country: "India" }],
    recruited_australia: [{ sector: "VET", students: 12 }], recruited_other: [],
    esos_read: true, esos_intend: null, national_code_read: true, national_code_intend: null,
    experience_education: "Ten years placing students with Australian and UK providers.", experience_other: "",
    markets: [{ area: "Kerala, India", characteristics: "Strong demand for business and IT courses" }],
    potential_markets: "", memberships: [], services_to_afc: "Recruit and counsel students, check documents and refer enrolments.",
  },
  privacy_agreed: true, declaration_name: "Test Owner",
};
function v2(body) {
  if (!body || typeof body !== "object" || !Array.isArray(body.referees)) return body;
  return { ...EXTRA, ...body, referees: body.referees.map((r) => ({ position: "Director", ...r })) };
}
const needsV2 = (method, url) => method === "POST" && (/\/api\/auth\/register-agent$/.test(url) || /\/api\/agent-application$/.test(url));
module.exports = { EXTRA, v2, needsV2 };

// Before an approval, the required documents are put on file and accepted (the real flow does this through the screens).
async function acceptAllDocuments(pool) {
  const { rows } = await pool.query(
    `SELECT a.id FROM agents a WHERE a.application_submitted_at IS NOT NULL AND a.deleted_at IS NULL
       AND (SELECT count(*) FROM agent_documents d WHERE d.agent_id = a.id AND d.deleted_at IS NULL AND d.status = 'accepted'
              AND d.kind IN ('business_registration','agency_profile')) < 2`);
  for (const { id } of rows) {
    await pool.query("UPDATE agent_documents SET deleted_at = now() WHERE agent_id = $1 AND kind IN ('business_registration','agency_profile') AND deleted_at IS NULL", [id]);
    for (const kind of ["business_registration", "agency_profile"]) {
      const f = (await pool.query(
        `INSERT INTO coms_files (kind, original_name, storage_key, mime_type, size_bytes, sha256) VALUES ('agent_document',$1,$2,'application/pdf',10,$3) RETURNING id`,
        [`${kind}.pdf`, `test/${id}/${kind}`, "0".repeat(64)])).rows[0].id;
      await pool.query("INSERT INTO agent_documents (agent_id, kind, file_id, status) VALUES ($1,$2,$3,'accepted')", [id, kind, f]);
    }
  }
}
module.exports.acceptAllDocuments = acceptAllDocuments;
module.exports.needsDocs = (method, url) => method === "POST" && /(\/decision|\/approve)$/.test(url);
