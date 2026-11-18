// ===============================
// Online induction (Phase 3, requirements document).
//   - six required modules, completed in order in the agent portal
//   - the policies and procedures (PP) are acknowledged once the modules are done: agent, server timestamp, IP and PP version are
//     stored in a record that cannot be edited or deleted (the ASQA audit evidence)
//   - staff confirm the induction (a second check, not self-reporting). Only then is the induction gate open
//   - the gate is enforced here, at the API level, for student applications (Phase 5): assertUnlocked()
//   - marketing materials are hidden until staff approve them; approval notifies every active agent
// ===============================
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { withTransaction } = require("../config/db");
const { ROLES, INDUCTION_PERMS, MATERIAL_CATEGORIES } = require("../const");
const repo = require("../repositories/onlineInductionRepo");
const agentRepo = require("../repositories/comsAgentRepo");
const ddRepo = require("../repositories/dueDiligenceRepo");
const taskRepo = require("../repositories/taskRepo");
const audit = require("../repositories/auditRepo");
const email = require("./emailService");
const storage = require("./fileStorage");
const { parseUpload } = require("../utils/upload");

const ELIGIBLE = ["approved", "onboarding", "active", "under_review"];
const fieldError = (field, message) => new AppError(400, "Please check the highlighted fields.", { errors: { [field]: message } });
const can = (actor, perm) => INDUCTION_PERMS[perm].includes(actor.role);
const need = (actor, perm) => {
  if (!can(actor, perm)) throw new AppError(403, "You do not have permission to do that.");
};

async function agentFor(user) {
  const found = await agentRepo.findByPortalUser(user.id);
  const a = found && (await agentRepo.findById(found.id));
  if (!a || a.deleted_at) throw new AppError(404, "We could not find your application.");
  return a;
}

// where the agent is up to, for the agent and for staff
async function statusFor(agentId, agent) {
  const a = agent || (await agentRepo.findById(agentId));
  const [modules, done, pp, acks] = await Promise.all([repo.modules(), repo.completions(agentId), repo.currentPp(), repo.acknowledgements(agentId)]);
  const byModule = new Map(done.map((c) => [c.module_id, c]));
  const completed = modules.filter((m) => byModule.has(m.id)).length;
  const allModules = modules.length > 0 && completed === modules.length;
  const acknowledged = acks.length > 0;
  const confirmed = !!a?.induction_recorded_at;
  const stage = !allModules ? (completed === 0 ? "not_started" : "in_progress")
    : !acknowledged ? "awaiting_policy" : !confirmed ? "awaiting_staff" : "complete";
  return {
    stage, unlocked: stage === "complete", confirmed_by_staff: confirmed,
    modules_total: modules.length, modules_completed: completed,
    modules: modules.map((m, i) => ({
      id: m.id, position: m.position, title: m.title, version: m.version,
      completed_at: byModule.get(m.id)?.completed_at || null, completed_version: byModule.get(m.id)?.module_version || null, ip: byModule.get(m.id)?.ip || null,
      locked: !byModule.has(m.id) && i > completed,
    })),
    pp: pp ? { id: pp.id, version: pp.version, title: pp.title } : null,
    pp_acknowledged_at: acks[0]?.acknowledged_at || null,
    pp_acknowledged_version: acks[0]?.pp_version || null,
    pp_acknowledged_ip: acks[0]?.ip || null,
    pp_acknowledged_current: !!pp && acks.some((x) => x.pp_version_id === pp.id),
  };
}

// ---------- the agent's own view ----------
async function mine(user) {
  const a = await agentFor(user);
  if (!ELIGIBLE.includes(a.status)) return { eligible: false };
  const s = await statusFor(a.id, a);
  const modules = await repo.modules();
  const pp = await repo.currentPp();
  return {
    eligible: true, ...s,
    modules: s.modules.map((m) => ({ ...m, body: m.locked ? null : modules.find((x) => x.id === m.id).body })),
    pp: pp ? { id: pp.id, version: pp.version, title: pp.title, body: pp.body, document_url: pp.document_url } : null,
    can_acknowledge: s.modules_total > 0 && s.modules_completed === s.modules_total && !s.pp_acknowledged_at,
  };
}

async function completeModule(user, moduleId, ctx) {
  const a = await agentFor(user);
  if (!ELIGIBLE.includes(a.status)) throw new AppError(409, "Your induction opens once the college approves your application.");
  const m = await repo.moduleById(moduleId);
  if (!m || !m.active) throw new AppError(404, "Module not found.");
  const all = await repo.modules();
  const done = new Set((await repo.completions(a.id)).map((c) => c.module_id));
  if (done.has(m.id)) throw new AppError(409, "You have already completed this module.");
  if (all.some((x) => x.position < m.position && !done.has(x.id))) throw new AppError(409, "Please complete the earlier modules first.");
  await withTransaction(async (client) => {
    await repo.insertCompletion(client, { agentId: a.id, moduleId: m.id, version: m.version, userId: user.id, ip: ctx?.ip, userAgent: ctx?.userAgent });
    await audit.log({ actorId: user.id, action: "agent.induction_module_completed", entityType: "agent", entityId: a.id, metadata: { module: m.title, position: m.position, version: m.version }, ...ctx }, client);
  });
  if (done.size + 1 === all.length) await notifyFinished(a); // "on final module completion"
  return mine(user);
}

async function acknowledgePolicy(user, { version_id }, ctx) {
  const a = await agentFor(user);
  if (!ELIGIBLE.includes(a.status)) throw new AppError(409, "Your induction opens once the college approves your application.");
  const s = await statusFor(a.id, a);
  if (s.modules_total === 0 || s.modules_completed < s.modules_total) throw new AppError(409, "Please complete all the induction modules first.");
  const pp = await repo.currentPp();
  if (!pp) throw new AppError(409, "There is no policy document to acknowledge yet. Please contact the college.");
  if (version_id !== pp.id) throw new AppError(409, "A newer version of the policies has been published. Please reload the page and read it.");
  if ((await repo.acknowledgements(a.id)).some((x) => x.pp_version_id === pp.id)) throw new AppError(409, "You have already acknowledged this version.");
  await withTransaction(async (client) => {
    await repo.insertAck(client, { agentId: a.id, userId: user.id, ppId: pp.id, version: pp.version, ip: ctx?.ip, userAgent: ctx?.userAgent });
    await audit.log({ actorId: user.id, action: "agent.pp_acknowledged", entityType: "agent", entityId: a.id, metadata: { pp_version: pp.version, ip: ctx?.ip || null }, ...ctx }, client);
  });
  return mine(user);
}

// tell the account manager (or marketing staff) that an agent finished the modules
async function notifyFinished(agent) {
  const manager = agent.account_manager_id ? await taskRepo.userById(agent.account_manager_id) : null;
  const to = manager?.status === "active" ? [manager] : await taskRepo.usersWithRoles([ROLES.MARKETING]);
  for (const u of to) email.sendOnlineInductionComplete({ to: u.email, firstName: u.first_name, agentName: agent.legal_name, link: `${env.frontendUrl}/coms/agents/${agent.id}` });
}

// ---------- the gate (enforced at the API, not only in the screens) ----------
const isUnlocked = async (agentId) => (await statusFor(agentId)).unlocked;
async function assertUnlocked(user) {
  const a = await agentFor(user);
  if (!(await isUnlocked(a.id))) throw new AppError(403, "Please complete your induction before you use this part of the portal. The college confirms it once you have finished the modules and acknowledged the policies.");
  return a;
}
// Express middleware for the agent routes that need the induction (student applications, Phase 5)
const requireInduction = (req, res, next) => assertUnlocked(req.user).then(() => next(), next);

// ---------- staff: content ----------
async function listModules(actor) {
  return (await repo.modules()).map((m) => ({ ...m, can_edit: can(actor, "manageModules") }));
}
async function updateModule(actor, id, { title, body }, ctx) {
  need(actor, "manageModules");
  const m = await repo.moduleById(id);
  if (!m) throw new AppError(404, "Module not found.");
  if (m.title === title && m.body === body) return m;
  await withTransaction(async (client) => {
    await repo.updateModule(client, id, { title, body, actorId: actor.id });
    await audit.log({ actorId: actor.id, action: "induction.module_updated", entityType: "induction_module", entityId: id, before: { title: m.title, version: m.version }, after: { title, version: m.version + 1 }, ...ctx }, client);
  });
  return repo.moduleById(id);
}
const listPolicies = async () => repo.ppVersions();
async function publishPolicy(actor, { version, title, body, document_url }, ctx) {
  need(actor, "publishPolicy");
  if ((await repo.ppVersions()).some((p) => p.version.toLowerCase() === version.toLowerCase())) throw fieldError("version", "This version already exists");
  const id = await withTransaction(async (client) => {
    const pid = await repo.insertPp(client, { version, title, body, documentUrl: document_url, actorId: actor.id });
    await audit.log({ actorId: actor.id, action: "induction.policy_published", entityType: "pp_version", entityId: pid, metadata: { version }, ...ctx }, client);
    return pid;
  });
  return (await repo.ppVersions()).find((p) => p.id === id);
}

// ---------- staff: marketing materials ----------
const materialView = (m) => ({
  id: m.id, title: m.title, description: m.description, category: m.category, category_label: MATERIAL_CATEGORIES[m.category], version: m.version, status: m.status,
  file_name: m.file_name, file_size: m.file_size, uploaded_by_name: m.uploaded_by_name, approved_by_name: m.approved_by_name, approved_at: m.approved_at, created_at: m.created_at, notified: m.notified,
});
const listMaterials = async () => (await repo.materials()).map(materialView);

async function createMaterial(actor, body, ctx) {
  need(actor, "manageMaterials");
  const up = parseUpload(body.file);
  let key = null;
  let id;
  try {
    const saved = await storage.save(up.buffer, up.ext, "coms");
    key = saved.key;
    id = await withTransaction(async (client) => {
      const fileId = await ddRepo.insertFile(client, { kind: "marketing_material", name: up.name, ...saved, mime: up.mime, actorId: actor.id });
      const mid = await repo.insertMaterial(client, { title: body.title, description: body.description, category: body.category || "brochure", version: body.version || "1.0", fileId, actorId: actor.id });
      await audit.log({ actorId: actor.id, action: "material.uploaded", entityType: "marketing_material", entityId: mid, metadata: { title: body.title, file: up.name }, ...ctx }, client);
      return mid;
    });
  } catch (err) {
    if (key) await storage.remove(key);
    throw err;
  }
  if (body.approve) return approveMaterial(actor, id, ctx);
  return materialView(await repo.material(id));
}

// approve: visible to agents from now on, and every active agent is told (the 24-hour duty). One email per agent, with the time recorded.
async function approveMaterial(actor, id, ctx) {
  need(actor, "manageMaterials");
  const m = await repo.material(id);
  if (!m) throw new AppError(404, "Material not found.");
  if (m.status === "approved") throw new AppError(409, "This material is already approved.");
  if (m.status === "retired") throw new AppError(409, "A retired material cannot be approved again. Upload a new version.");
  await withTransaction(async (client) => {
    await repo.setMaterialStatus(client, id, "approved", actor.id);
    await audit.log({ actorId: actor.id, action: "material.approved", entityType: "marketing_material", entityId: id, before: { status: m.status }, after: { status: "approved" }, metadata: { title: m.title }, ...ctx }, client);
  });
  let notified = 0;
  for (const r of await repo.noticeRecipients()) {
    if (!r.email) continue;
    email.sendMaterialUpdate({ to: r.email, firstName: r.first_name, title: m.title, version: m.version, category: MATERIAL_CATEGORIES[m.category], link: `${env.frontendUrl}/agent/induction` });
    await repo.insertDelivery(null, { materialId: id, agentId: r.id, to: r.email }).catch(() => null);
    notified++;
  }
  await audit.log({ actorId: actor.id, action: "material.agents_notified", entityType: "marketing_material", entityId: id, metadata: { agents: notified }, ...ctx });
  return materialView(await repo.material(id));
}

// Daily safety net for the 24-hour notice duty: any active agent who was not told about an approved material is told now.
// A notice still missing after 24 hours is written to the audit trail so it can be seen.
async function runMaterialNotices() {
  let sent = 0, late = 0;
  const lateMaterials = new Set();
  for (const r of await repo.undelivered()) {
    if (!r.email) continue;
    email.sendMaterialUpdate({ to: r.email, firstName: r.first_name, title: r.title, version: r.version, category: MATERIAL_CATEGORIES[r.category], link: `${env.frontendUrl}/agent/induction` });
    await repo.insertDelivery(null, { materialId: r.material_id, agentId: r.agent_id, to: r.email });
    sent++;
    if (Date.now() - new Date(r.approved_at).getTime() > 24 * 3600 * 1000) { late++; lateMaterials.add(r.material_id); }
  }
  for (const id of lateMaterials) {
    await audit.log({ actorId: null, action: "material.notice_late", entityType: "marketing_material", entityId: id, metadata: { note: "Agents were told more than 24 hours after approval (retry by the daily job)." } });
  }
  return { sent, late };
}

async function retireMaterial(actor, id, ctx) {
  need(actor, "manageMaterials");
  const m = await repo.material(id);
  if (!m) throw new AppError(404, "Material not found.");
  if (m.status === "retired") throw new AppError(409, "This material is already retired.");
  await withTransaction(async (client) => {
    await repo.setMaterialStatus(client, id, "retired", actor.id);
    await audit.log({ actorId: actor.id, action: "material.retired", entityType: "marketing_material", entityId: id, before: { status: m.status }, after: { status: "retired" }, ...ctx }, client);
  });
  return materialView(await repo.material(id));
}

async function openMaterial(actor, id, ctx, { agentOnly = false } = {}) {
  const m = await repo.material(id);
  if (!m || (agentOnly && m.status !== "approved") || !(await storage.exists(m.storage_key))) throw new AppError(404, "File not found.");
  await audit.log({ actorId: actor.id, action: "material.downloaded", entityType: "marketing_material", entityId: id, metadata: { title: m.title }, ...ctx });
  return { stream: storage.createReadStream(m.storage_key), name: m.file_name, mime: m.mime_type, size: m.file_size };
}

// the agent sees approved materials once the induction gate is open ("available after induction complete")
async function materialsForAgent(user) {
  const a = await agentFor(user);
  const s = await statusFor(a.id, a);
  if (!s.unlocked) return { unlocked: false, materials: [] };
  return { unlocked: true, materials: (await repo.materials({ status: "approved" })).map(materialView) };
}
async function openMaterialForAgent(user, id, ctx) {
  await assertUnlocked(user);
  return openMaterial(user, id, ctx, { agentOnly: true });
}

module.exports = {
  statusFor, mine, completeModule, acknowledgePolicy, isUnlocked, assertUnlocked, requireInduction,
  listModules, updateModule, listPolicies, publishPolicy,
  listMaterials, createMaterial, approveMaterial, retireMaterial, runMaterialNotices, openMaterial, materialsForAgent, openMaterialForAgent,
};
