// ===============================
// The agent folder (Processing Agent Application, step 1): the documents an agent sends,
// staff review of each one, filing names, and asking the agent for updates.
// ===============================
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { withTransaction } = require("../config/db");
const { AGENT_PERMS, DOC_KINDS, REQUIRED_DOC_KINDS } = require("../const");
const { parseUpload } = require("../utils/upload");
const repo = require("../repositories/agentDocRepo");
const agentRepo = require("../repositories/comsAgentRepo");
const ddRepo = require("../repositories/dueDiligenceRepo");
const audit = require("../repositories/auditRepo");
const storage = require("./fileStorage");
const email = require("./emailService");
const calendar = require("./calendarService");

const ENTITY = "agent";
const OPEN_FOR_DOCS = ["prospect", "applied", "due_diligence"];
const allowed = (actor, perm) => AGENT_PERMS[perm].includes(actor.role);
const need = (actor, perm) => { if (!allowed(actor, perm)) throw new AppError(403, "You do not have permission to do that."); };
const clean = (s) => String(s || "").replace(/[\\/:*?"<>|\r\n\0]/g, " ").replace(/\s+/g, " ").trim();

async function loadAgent(id, client) {
  const a = await agentRepo.findById(id, client);
  if (!a || a.deleted_at) throw new AppError(404, "Agent not found.");
  return a;
}

// One line per document kind that matters, so screens can show "received / accepted / missing".
function summary(docs) {
  const required = REQUIRED_DOC_KINDS.map((kind) => {
    const d = docs.filter((x) => x.kind === kind).pop();
    return { kind, label: DOC_KINDS[kind].label, status: d ? d.status : "missing" };
  });
  const complete = required.every((r) => r.status === "accepted");
  return { required, complete };
}

const named = (agent, docs) => docs.map((d) => ({ ...d, filing_name: filingName(agent, d) }));

async function list(actor, agentId) {
  need(actor, "read");
  const agent = await loadAgent(agentId);
  const docs = named(agent, await repo.list(agentId));
  return { documents: docs, kinds: DOC_KINDS, ...summary(docs) };
}

async function addDocument({ agent, actorId, byAgent, body, ctx }) {
  const up = parseUpload(body.file);
  const saved = await storage.save(up.buffer, up.ext, "coms");
  const id = await withTransaction(async (client) => {
    const fileId = await ddRepo.insertFile(client, { kind: "agent_document", name: up.name, ...saved, mime: up.mime, actorId });
    if (body.kind !== "other") await repo.supersede(client, agent.id, body.kind, actorId);
    const docId = await repo.insert(client, { agentId: agent.id, kind: body.kind, label: body.label, fileId, actorId, byAgent });
    await audit.log({
      actorId, action: "agent.document_added", entityType: ENTITY, entityId: agent.id,
      after: { kind: body.kind, name: up.name }, metadata: byAgent ? { by: "agent" } : undefined, ...ctx,
    }, client);
    return docId;
  }).catch(async (e) => { await storage.remove(saved.key); throw e; });
  return id;
}

async function upload(actor, agentId, body, ctx) {
  need(actor, "dueDiligence");
  const a = await loadAgent(agentId);
  await addDocument({ agent: a, actorId: actor.id, byAgent: false, body, ctx });
  return list(actor, agentId);
}

// the signed-in agent adds documents to their own application
async function agentFor(user) {
  const found = await agentRepo.findByPortalUser(user.id);
  if (!found) throw new AppError(404, "We could not find your application.");
  return loadAgent(found.id);
}
async function mine(user) {
  const a = await agentFor(user);
  const docs = named(a, await repo.list(a.id)).map(({ review_note, ...d }) => ({ ...d, review_note: d.status === "needs_update" ? review_note : null }));
  return { documents: docs, kinds: DOC_KINDS, open: OPEN_FOR_DOCS.includes(a.status), ...summary(docs) };
}
async function uploadMine(user, body, ctx) {
  const a = await agentFor(user);
  if (!OPEN_FOR_DOCS.includes(a.status)) throw new AppError(409, "Your application is no longer open for new documents. Please contact the college.");
  await addDocument({ agent: a, actorId: user.id, byAgent: true, body, ctx });
  return mine(user);
}
async function removeMine(user, docId, ctx) {
  const a = await agentFor(user);
  const d = await repo.find(a.id, docId);
  if (!d || !d.uploaded_by_agent) throw new AppError(404, "Document not found.");
  if (d.status === "accepted" || !OPEN_FOR_DOCS.includes(a.status)) throw new AppError(409, "This document can no longer be removed.");
  await withTransaction(async (client) => {
    await repo.softDelete(client, docId, "Removed by the agent", user.id);
    await audit.log({ actorId: user.id, action: "agent.document_removed", entityType: ENTITY, entityId: a.id, before: { kind: d.kind, name: d.original_name }, ...ctx }, client);
  });
  return mine(user);
}

// staff review: accept, or say what has to change
async function review(actor, agentId, docId, body, ctx) {
  need(actor, "dueDiligence");
  const d = await repo.find(agentId, docId);
  if (!d) throw new AppError(404, "Document not found.");
  await withTransaction(async (client) => {
    await repo.review(client, docId, body, actor.id);
    await audit.log({
      actorId: actor.id, action: "agent.document_reviewed", entityType: ENTITY, entityId: agentId,
      before: { document: d.original_name, status: d.status }, after: { status: body.status }, metadata: body.note ? { note: body.note } : undefined, ...ctx,
    }, client);
  });
  return list(actor, agentId);
}
async function remove(actor, agentId, docId, reason, ctx) {
  need(actor, "dueDiligence");
  const d = await repo.find(agentId, docId);
  if (!d) throw new AppError(404, "Document not found.");
  await withTransaction(async (client) => {
    await repo.softDelete(client, docId, reason, actor.id);
    await audit.log({ actorId: actor.id, action: "agent.document_removed", entityType: ENTITY, entityId: agentId, before: { kind: d.kind, name: d.original_name }, metadata: { reason }, ...ctx }, client);
  });
  return list(actor, agentId);
}

// Filing name: "<Agency> - <Document type> - <date>.<ext>" (step 1: appropriate naming of each document)
const filingName = (agent, d) => {
  const ext = String(d.original_name).split(".").pop().toLowerCase();
  const what = d.kind === "other" && d.label ? clean(d.label) : DOC_KINDS[d.kind].file;
  return `${clean(agent.legal_name)} - ${what} - ${calendar.localDate(d.created_at)}.${ext}`.slice(0, 200);
};
async function open(actor, agentId, docId, ctx) {
  need(actor, "read");
  const a = await loadAgent(agentId);
  const d = await repo.find(agentId, docId);
  if (!d || !(await storage.exists(d.storage_key))) throw new AppError(404, "File not found.");
  await audit.log({ actorId: actor.id, action: "coms.file_downloaded", entityType: "file", entityId: d.file_id, metadata: { kind: "agent_document", name: d.original_name }, ...ctx });
  return { stream: storage.createReadStream(d.storage_key), name: filingName(a, d), mime: d.mime_type, size: d.size_bytes };
}
async function openMine(user, docId, ctx) {
  const a = await agentFor(user);
  const d = await repo.find(a.id, docId);
  if (!d || !(await storage.exists(d.storage_key))) throw new AppError(404, "File not found.");
  await audit.log({ actorId: user.id, action: "coms.file_downloaded", entityType: "file", entityId: d.file_id, metadata: { kind: "agent_document", name: d.original_name }, ...ctx });
  return { stream: storage.createReadStream(d.storage_key), name: filingName(a, d), mime: d.mime_type, size: d.size_bytes };
}

// "If not, reply back to agent for the updated information/evidence/clarification."
async function requestInfo(actor, agentId, { message }, ctx) {
  need(actor, "dueDiligence");
  const a = await loadAgent(agentId);
  const people = await agentRepo.persons(agentId);
  const to = people.find((p) => p.is_primary_contact && p.email) || people.find((p) => p.email);
  const recipient = to ? { email: to.email, name: to.name } : { email: a.email, name: a.legal_name };
  const docs = (await repo.list(agentId)).filter((d) => d.status === "needs_update").map((d) => `${DOC_KINDS[d.kind].label}${d.review_note ? ` (${d.review_note})` : ""}`);
  await audit.log({ actorId: actor.id, action: "agent.information_requested", entityType: ENTITY, entityId: agentId, metadata: { to: recipient.email, message }, ...ctx });
  email.sendInfoRequest({
    to: recipient.email, firstName: recipient.name.split(" ")[0], agencyName: a.legal_name, message, documents: docs,
    link: `${env.frontendUrl}/agent/application`,
  });
  return { sent_to: recipient.email };
}

// BR-02: the required documents are in and checked (used by the due-diligence checklist)
async function checklistState(agentId, client) {
  const agent = await loadAgent(agentId, client);
  const docs = named(agent, await repo.list(agentId, client));
  return { docs, ...summary(docs) };
}

module.exports = { list, upload, mine, uploadMine, removeMine, review, remove, open, openMine, requestInfo, checklistState, filingName };
