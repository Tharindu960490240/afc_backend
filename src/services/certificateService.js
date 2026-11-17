// Certificate of appointment for an agent: look it up, download it, and email it when onboarding is finished.
const { Readable } = require("stream");
const { query } = require("../config/db");
const agentRepo = require("../repositories/comsAgentRepo");
const audit = require("../repositories/auditRepo");
const agreementRepo = require("../repositories/agreementRepo");
const certificatePdf = require("./certificatePdf");
const email = require("./emailService");
const AppError = require("../utils/AppError");
const { AGENT_PERMS } = require("../const");

// the agent's current agreement; the certificate is drawn from it each time, so it always shows the college's current design
async function latest(agentId) {
  return (await query(
    `SELECT ag.id AS agreement_id, ag.updated_at AS created_at
       FROM agreements ag
       JOIN agent_persons p ON p.portal_user_id = ag.agent_id
      WHERE p.agent_id = $1 AND p.deleted_at IS NULL AND ag.status = 'active' AND ag.effective_date IS NOT NULL
      ORDER BY ag.effective_date DESC, ag.created_at DESC LIMIT 1`, [agentId])).rows[0] || null;
}
const draw = async (f) => certificatePdf.render(await agreementRepo.findForDocument(f.agreement_id));

async function agentOf(id) {
  const a = await agentRepo.findById(id);
  if (!a || a.deleted_at) throw new AppError(404, "Agent not found.");
  return a;
}
const fileName = (a) => `${a.legal_name} - Certificate of Appointment.pdf`.replace(/[\\/:*?"<>|\r\n]/g, " ");

async function open(agentId, actorId, ctx, { agentSelf = false } = {}) {
  const a = await agentOf(agentId);
  if (agentSelf && a.status !== "active") throw new AppError(409, "Your certificate is available once your onboarding is complete.");
  const f = await latest(agentId);
  if (!f) throw new AppError(404, "There is no certificate of appointment for this agent yet.");
  const buffer = await draw(f);
  await audit.log({ actorId, action: "agent.certificate_downloaded", entityType: "agent", entityId: agentId, ...ctx });
  return { stream: Readable.from(buffer), name: fileName(a), mime: "application/pdf", size: buffer.length };
}

// for the agent's own portal: does one exist, and can it be downloaded yet
async function statusFor(agentId) {
  const a = await agentOf(agentId);
  const f = await latest(agentId);
  return { available: !!f && a.status === "active", exists: !!f, issued_at: f?.created_at || null, sent_at: a.certificate_sent_at || null };
}

// email it to the agent's main contact as an attachment
async function sendToAgent(agentId, actorId, ctx) {
  const a = await agentOf(agentId);
  const f = await latest(agentId);
  if (!f) throw new AppError(409, "There is no certificate of appointment to send yet.");
  const people = await agentRepo.persons(agentId);
  const to = people.find((p) => p.is_primary_contact && p.email) || people.find((p) => p.email);
  const address = to?.email || a.email;
  if (!address) throw new AppError(409, "This agent has no email address on file.");
  const buffer = await draw(f);
  await email.sendCertificate({ to: address, firstName: (to?.name || a.legal_name).split(" ")[0], agencyName: a.legal_name, filename: fileName(a), buffer });
  await query(`UPDATE agents SET certificate_sent_at = now() WHERE id = $1`, [agentId]);
  await audit.log({ actorId, action: "agent.certificate_sent", entityType: "agent", entityId: agentId, metadata: { to: address }, ...ctx });
  return { sent_to: address };
}

// called when onboarding finishes; never blocks or fails the activation
const onActivated = (agentId, actor, ctx) =>
  sendToAgent(agentId, actor?.id || null, ctx).catch((e) => console.error("certificate email failed:", e.message));

const canSee = (role) => AGENT_PERMS.read.includes(role);
module.exports = { latest, open, statusFor, sendToAgent, onActivated, canSee };
