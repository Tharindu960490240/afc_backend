const env = require("../config/env");
const AppError = require("../utils/AppError");
const { query, withTransaction } = require("../config/db");
const crypto = require("crypto");
const docs = require("./agreementDocument");
const agreementPdf = require("./agreementPdf");
const templates = require("./templateService");
const storage = require("./fileStorage");
const email = require("./emailService");
const repo = require("../repositories/agreementRepo");
const audit = require("../repositories/auditRepo");
const { ROLES } = require("../const");
const certificatePdf = require("./certificatePdf");

// Staff who work with agents may open any agreement; the CEO (and an administrator) countersign.
const STAFF_VIEW = [ROLES.ADMIN, ROLES.CEO, ROLES.DIRECTOR, ROLES.MARKETING, ROLES.COMPLIANCE, ROLES.COE_ADMIN];

const OPEN = ["sent", "submitted", "rejected"];
const NOT_FOUND = "Agreement not found.";

// today in the college's time zone, as YYYY-MM-DD
const today = () => new Date().toLocaleDateString("en-CA", { timeZone: env.timezone });
const fullName = (o, p = "") => `${o[`${p}first_name`] || ""} ${o[`${p}last_name`] || ""}`.trim();

// ---------- helpers ----------
// An agent can only see their own agreements (404 so ids cannot be probed).
async function loadFor(actor, id) {
  const agreement = await repo.findById(id);
  if (!agreement || (!STAFF_VIEW.includes(actor.role) && agreement.agent_id !== actor.id)) {
    throw new AppError(404, NOT_FOUND);
  }
  return agreement;
}

const activeAdmins = async () =>
  (await query(`SELECT id, first_name, email FROM users WHERE role='admin' AND status='active'`)).rows;

// The signer types their name; a drawn signature is optional.
const signatureFrom = (body, ctx, extra = {}) => ({
  name: body.signed_name,
  image: docs.parseSignatureImage(body.signature_image),
  ip: (ctx.ip || "").slice(0, 64) || null,
  ...extra,
});

// ---------- admin: send ----------
async function send(actor, body, ctx) {
  const agent = (
    await query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.status, ap.agency_name, ap.business_number, ap.country,
              g.trading_names[1] AS trading_name,
              COALESCE(g.principal_address, g.registered_office_address, g.postal_address) AS address,
              g.phone, CASE WHEN p.role = 'director' THEN 'Director' ELSE 'Authorised representative' END AS position
       FROM users u LEFT JOIN agent_profiles ap ON ap.user_id = u.id
       LEFT JOIN agent_persons p ON p.portal_user_id = u.id AND p.deleted_at IS NULL
       LEFT JOIN agents g ON g.id = p.agent_id
       WHERE u.id=$1 AND u.role='agent'`,
      [body.agent_id],
    )
  ).rows[0];
  if (!agent || agent.status !== "active") throw new AppError(404, "Agent not found.", { errors: { agent_id: "Choose an active agent" } });

  const template = await templates.getActive();
  const title = body.title || template.name;
  const months = body.validity_months || 12;
  const snapshot = docs.snapshotFor(template.body, agent, months);
  const sha = crypto.createHash("sha256").update(snapshot).digest("hex");

  try {
    const id = await withTransaction(async (client) => {
      if (await repo.hasOpen(client, agent.id)) {
        throw new AppError(409, "This agent already has an agreement in progress. Finish or cancel it first.");
      }
      const agreementId = await repo.create(client, {
        agentId: agent.id, title, note: body.note, validityMonths: months, sentBy: actor.id,
        templateId: template.id, bodySnapshot: snapshot, bodySha256: sha,
      });
      await repo.addEvent(client, agreementId, actor.id, "sent", body.note);
      await audit.log({ actorId: actor.id, action: "agreement.sent", entityType: "agreement", entityId: agreementId, metadata: { agentId: agent.id, templateVersion: template.version }, ...ctx }, client);
      return agreementId;
    });
    email.sendAgreementSent({ to: agent.email, firstName: agent.first_name, title, note: body.note, validityMonths: months });
    return repo.findById(id);
  } catch (err) {
    if (err.code === "23505") throw new AppError(409, "This agent already has an agreement in progress.");
    throw err;
  }
}

// ---------- agent: sign in the portal ----------
async function sign(actor, id, body, ctx) {
  const current = await loadFor(actor, id);
  if (actor.role !== ROLES.AGENT) throw new AppError(403, "Only the agent can sign here.");
  if (!current.in_portal) throw new AppError(409, "This agreement was created before online signing. Please ask the college to send it again.");
  if (!["sent", "rejected"].includes(current.stored_status)) {
    throw new AppError(409, "This agreement is not waiting for your signature.");
  }
  const sig = signatureFrom(body, ctx);

  await withTransaction(async (client) => {
    const row = await repo.lockById(client, id);
    if (!row || !["sent", "rejected"].includes(row.status)) throw new AppError(409, "This agreement is not waiting for your signature.");
    await repo.markSigned(client, id, sig);
    await repo.addEvent(client, id, actor.id, "submitted", `Signed in the portal as "${sig.name}"`);
    await audit.log({ actorId: actor.id, action: "agreement.signed_by_agent", entityType: "agreement", entityId: id, ...ctx }, client);
  });

  const agentName = fullName(current, "agent_");
  for (const admin of await activeAdmins()) {
    email.sendAgreementSubmitted({ to: admin.email, firstName: admin.first_name, agentName, agencyName: current.agency_name, id });
  }
  return repo.findById(id);
}

// ---------- admin: review ----------
async function reject(actor, id, reason, ctx) {
  const current = await loadFor(actor, id);
  await withTransaction(async (client) => {
    const row = await repo.lockById(client, id);
    if (!row || row.status !== "submitted") throw new AppError(409, "Only a signed agreement can be sent back.");
    await repo.markRejected(client, id, actor.id, reason);
    await repo.addEvent(client, id, actor.id, "rejected", reason);
    await audit.log({ actorId: actor.id, action: "agreement.rejected", entityType: "agreement", entityId: id, ...ctx }, client);
  });
  email.sendAgreementRejected({ to: current.agent_email, firstName: current.agent_first_name, title: current.title, reason });
  return repo.findById(id);
}

// The college countersigns. This also builds and stores the final signed PDF.
async function approve(actor, id, body, ctx) {
  const current = await loadFor(actor, id);
  if (current.stored_status !== "submitted") throw new AppError(409, "Only an agreement signed by the agent can be countersigned.");

  const effective = body.effective_date || today();
  const diffDays = (new Date(`${effective}T00:00:00Z`) - new Date(`${today()}T00:00:00Z`)) / 86400000;
  if (diffDays < -30 || diffDays > 365) {
    throw new AppError(400, "The start date must be within 30 days before or 1 year after today.", { errors: { effective_date: "Out of range" } });
  }
  const months = body.validity_months || current.validity_months;
  const sig = signatureFrom(body, ctx, { position: body.position || "Authorised representative" });

  let storedKey = null;
  let certKey = null;
  let finalPdf = null;
  let certPdf = null;
  try {
    await withTransaction(async (client) => {
      const row = await repo.lockById(client, id);
      if (!row || row.status !== "submitted") throw new AppError(409, "Only an agreement signed by the agent can be countersigned.");
      await repo.markActive(client, id, current.agent_id, actor.id, effective, months, sig);

      // draw the finished document from what is now in the database
      const full = await repo.findForDocument(id, client);
      const pdf = await agreementPdf.render(full);
      finalPdf = pdf;
      const saved = await storage.save(pdf, "pdf");
      storedKey = saved.key;
      await repo.addFile(client, {
        agreementId: id, kind: "final", ...saved, mime: "application/pdf", uploadedBy: actor.id,
        originalName: `${docs.reference(id)} ${current.title} - signed.pdf`.replace(/[\\/\r\n]/g, "_"),
      });

      // certificate of appointment (E1-5), stored next to the signed agreement
      const cert = await certificatePdf.render(await repo.findForDocument(id, client));
      certPdf = cert;
      const certSaved = await storage.save(cert, "pdf");
      certKey = certSaved.key;
      await repo.addFile(client, {
        agreementId: id, kind: "certificate", ...certSaved, mime: "application/pdf", uploadedBy: actor.id,
        originalName: `${docs.reference(id)} Certificate of appointment.pdf`,
      });

      await repo.addEvent(client, id, actor.id, "approved", `Countersigned. Valid from ${effective} for ${months} months`);
      await audit.log({ actorId: actor.id, action: "agreement.approved", entityType: "agreement", entityId: id, ...ctx }, client);
    });
  } catch (err) {
    if (storedKey) await storage.remove(storedKey); // do not leave an orphan file behind
    if (certKey) await storage.remove(certKey);
    throw err;
  }
  const done = await repo.findById(id);
  // E1-6: the agent moves to Onboarding and the PRISMS, ASQAnet, website and induction tasks are created
  await require("./taskService").onAgreementCountersigned(id, actor, ctx)
    .catch((e) => console.error("onboarding tasks failed:", e.message));
  // the signed agreement and the Certificate of Appointment go to the agent now, and a copy to the countersigning staff member
  const ref = docs.reference(id);
  const safe = (n) => n.replace(/[\\/\r\n]/g, "_");
  const files = [
    { filename: safe(`${ref} ${current.title} - signed.pdf`), content: finalPdf },
    { filename: safe(`${current.agency_name || fullName(current, "agent_")} - Certificate of Appointment.pdf`), content: certPdf },
  ];
  email.sendAgreementApproved({ to: current.agent_email, firstName: current.agent_first_name, title: current.title, expiresAt: done.expires_at, files });
  await query(
    `UPDATE agents SET certificate_sent_at = now() WHERE id = (SELECT agent_id FROM agent_persons WHERE portal_user_id = $1 AND deleted_at IS NULL LIMIT 1)`,
    [current.agent_id]).catch(() => {});
  const staff = (await query(`SELECT first_name, email FROM users WHERE id = $1`, [actor.id])).rows[0];
  if (staff) email.sendSignedCopyToStaff({ to: staff.email, firstName: staff.first_name, agentName: fullName(current, "agent_"), title: current.title, files: [files[0]] });
  return done;
}

async function cancel(actor, id, reason, ctx) {
  const current = await loadFor(actor, id);
  await withTransaction(async (client) => {
    const row = await repo.lockById(client, id);
    if (!row || !["sent", "submitted", "rejected", "active"].includes(row.status)) {
      throw new AppError(409, "This agreement can no longer be cancelled.");
    }
    await repo.markCancelled(client, id, actor.id);
    await repo.addEvent(client, id, actor.id, "cancelled", reason);
    await audit.log({ actorId: actor.id, action: "agreement.cancelled", entityType: "agreement", entityId: id, ...ctx }, client);
  });
  email.sendAgreementCancelled({ to: current.agent_email, firstName: current.agent_first_name, title: current.title, reason });
  return repo.findById(id);
}

// ---------- reading ----------
async function list(actor, { status, agent_id: agentId, page, limit }) {
  const { rows, total } = await repo.list({
    agentId: STAFF_VIEW.includes(actor.role) ? agentId : actor.id,
    status, limit, offset: (page - 1) * limit,
  });
  return { rows, total, page, limit };
}

async function get(actor, id) {
  await loadFor(actor, id);
  const [full, files, events] = await Promise.all([repo.findForDocument(id), repo.listFiles(id), repo.listEvents(id)]);
  const { body_snapshot: _body, agent_sig_image: _a, admin_sig_image: _b, ...agreement } = full;
  return {
    ...agreement,
    reference: docs.reference(id),
    // the wording as the agent sees it, ready to show on screen
    document: full.body_snapshot ? docs.blocksFor(full) : [],
    files, events,
  };
}

// The agreement as a PDF: the stored final file once it is signed by both, otherwise
// a fresh copy showing whoever has signed so far.
async function openPdf(actor, id, ctx) {
  const agreement = await loadFor(actor, id);
  if (agreement.final_file_id) return openFile(actor, id, agreement.final_file_id, ctx);
  const full = await repo.findForDocument(id);
  if (!full.body_snapshot) throw new AppError(404, "This agreement has no online document.");
  const buffer = await agreementPdf.render(full);
  await audit.log({ actorId: actor.id, action: "agreement.pdf_viewed", entityType: "agreement", entityId: id, ...ctx });
  return { buffer, name: `${docs.reference(id)} ${agreement.title}.pdf`.replace(/[\\/\r\n]/g, "_"), mime: "application/pdf", size: buffer.length };
}

async function openFile(actor, id, fileId, ctx) {
  await loadFor(actor, id);
  const file = await repo.findFile(id, fileId);
  if (!file || !(await storage.exists(file.storage_key))) throw new AppError(404, "File not found.");
  await audit.log({ actorId: actor.id, action: "agreement.file_downloaded", entityType: "agreement", entityId: id, metadata: { fileId, kind: file.kind }, ...ctx });
  return { stream: storage.createReadStream(file.storage_key), name: file.original_name, mime: file.mime_type, size: file.size_bytes };
}

const agentsOverview = ({ page, limit, search, agreement }) =>
  repo.agentsOverview({ search, agreement, limit, offset: (page - 1) * limit }).then((r) => ({ ...r, page, limit }));

module.exports = { send, sign, reject, approve, cancel, list, get, openFile, openPdf, agentsOverview, OPEN };
