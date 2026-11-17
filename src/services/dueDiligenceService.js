// ===============================
// Due diligence and the approve / reject decision (COMS Block 1, Part 2: E1-4).
//   - referee verification by emailed form or by phone (same questions, same record)
//   - ABN, MARN and PRISMS-data checks, conflict-of-interest review
//   - director / CEO decision: blocked until one positive referee check and every item is recorded (BR-06, BR-08)
// ===============================
const AppError = require("../utils/AppError");
const env = require("../config/env");
const { withTransaction } = require("../config/db");
const { AGENT_PERMS } = require("../const");
const settings = require("./settingsService");
const { generateToken, hashToken } = require("../utils/tokens");
const { parseUpload } = require("../utils/upload");
const { changes } = require("../utils/diff");
const repo = require("../repositories/dueDiligenceRepo");
const agentRepo = require("../repositories/comsAgentRepo");
const userRepo = require("../repositories/userRepo");
const audit = require("../repositories/auditRepo");
const calendar = require("./calendarService");
const storage = require("./fileStorage");
const email = require("./emailService");
const { prismsMissing } = require("./prisms");

const ENTITY = "agent";
const BAD_LINK = "This link is not valid any more. Please contact the college.";

const allowed = (actor, perm) => AGENT_PERMS[perm].includes(actor.role);
const need = (actor, perm) => {
  if (!allowed(actor, perm)) throw new AppError(403, "You do not have permission to do that.");
};
const nameOf = (u) => `${u.first_name || ""} ${u.last_name || ""}`.trim();
const fieldError = (field, message) => new AppError(400, "Please check the highlighted fields.", { errors: { [field]: message } });

async function loadAgent(id, client, opts) {
  const a = await agentRepo.findById(id, client, opts);
  if (!a || a.deleted_at) throw new AppError(404, "Agent not found.");
  return a;
}
// due diligence belongs to agents still waiting for a decision
const IN_REVIEW = ["applied", "due_diligence"];
function mustBeInReview(a) {
  if (!IN_REVIEW.includes(a.status)) throw new AppError(409, "Due diligence can only be changed while the application is open.");
}

async function saveFile(client, file, kind, actorId) {
  const up = parseUpload(file);
  const saved = await storage.save(up.buffer, up.ext, "coms");
  const id = await repo.insertFile(client, { kind, name: up.name, ...saved, mime: up.mime, actorId });
  return { id, key: saved.key };
}

// ---------- answers to the reference questions ----------
function checkAnswers(raw, questions = settings.questions()) {
  const clean = {};
  const errors = {};
  for (const q of questions) {
    const v = raw[q.key];
    if (q.type === "yesno") {
      if (typeof v !== "boolean") { if (q.required) errors[q.key] = "Please choose Yes or No"; continue; }
      clean[q.key] = v;
      if (q.detail) {
        const d = String(raw[`${q.key}_detail`] || "").trim();
        if (v !== q.favourable && !d) errors[`${q.key}_detail`] = "Please give details";
        if (d) clean[`${q.key}_detail`] = d.slice(0, 2000);
      }
    } else {
      const t = typeof v === "string" ? v.trim() : "";
      if (!t && q.required) errors[q.key] = "Please answer this question";
      if (t) clean[q.key] = t.slice(0, 2000);
    }
  }
  if (Object.keys(errors).length) throw new AppError(400, "Please check the highlighted fields.", { errors });
  return clean;
}
// a good reference = every question that has a favourable answer got it
const outcomeFor = (answers, questions = settings.questions()) =>
  questions.filter((q) => q.favourable !== undefined && q.favourable !== null).every((q) => answers[q.key] === q.favourable) ? "positive" : "negative";

// ---------- the checklist (E1-4) ----------
function buildChecklist(a, dd, referees, checks, persons, docState) {
  const positive = checks.filter((c) => c.outcome === "positive").length;
  const failed = [];
  const item = (key, label, done, detail, { failedFlag } = {}) => {
    if (failedFlag) failed.push(label);
    return { key, label, done, detail: detail || null, failed: !!failedFlag };
  };
  const stat = (s) => (s === "verified" ? "Verified" : s === "not_applicable" ? "Not applicable" : s === "failed" ? "Failed" : null);
  const hasMarn = !!a.marn || persons.some((p) => p.marn);
  const items = [
    item("application", "Application complete (PRISMS fields)", prismsMissing(a, a.director_count).length === 0,
      prismsMissing(a, a.director_count).map((m) => m.label).join("; ") || null),
    // procedure step 1: the documents the agent sent are in and have been reviewed. Applies to applications made on the form.
    ...(a.application_submitted_at && docState ? [item("documents", "Application documents received and accepted", docState.complete,
      docState.required.map((r) => `${r.label}: ${r.status === "missing" ? "not received" : r.status === "needs_update" ? "needs an update" : r.status}`).join("; "))] : []),
    item("referees", "Referee checks: at least one positive", positive >= 1,
      `${positive} positive of ${referees.length} referee${referees.length === 1 ? "" : "s"}`),
    item("abn", "ABN / business registration checked", !!dd.abn_check_status && dd.abn_check_status !== "failed", stat(dd.abn_check_status),
      { failedFlag: dd.abn_check_status === "failed" }),
    item("marn", "MARN (migration agent registration) checked", !!dd.marn_check_status && dd.marn_check_status !== "failed",
      stat(dd.marn_check_status) || (hasMarn ? "A MARN is on the application" : null), { failedFlag: dd.marn_check_status === "failed" }),
    item("prisms", "Agent details checked for PRISMS", dd.prisms_check_status === "verified", stat(dd.prisms_check_status),
      { failedFlag: dd.prisms_check_status === "failed" }),
    item("coi", "Conflict-of-interest declaration reviewed",
      a.coi_declared !== null && a.coi_declared !== undefined && !!dd.coi_reviewed_at && (!a.coi_declared || !!String(a.coi_details || "").trim()),
      a.coi_declared === null || a.coi_declared === undefined ? "No declaration recorded yet"
        : a.coi_declared ? "A conflict was declared. Review it before deciding." : "No conflict declared"),
    item("ethics", "Code of ethics acknowledged", !!a.code_of_ethics_ack_at, null),
  ];
  const blockers = items.filter((i) => !i.done).map((i) => (i.failed ? `${i.label}: failed. Resolve it or reject the application.` : `${i.label} is not recorded yet.`));
  const warnings = [];
  if (!a.sms_contact_at) warnings.push("The agent's contact has not been created in the student management system yet (procedure step 2).");
  if (positive === 1) warnings.push("Only one positive referee check. Two are recommended.");
  if (checks.some((c) => c.outcome === "negative")) warnings.push("A referee gave a negative reference. Read it before deciding.");
  if (a.coi_declared) warnings.push("The applicant declared a conflict of interest.");
  return { items, blockers, warnings, positive };
}

// ---------- reading ----------
async function get(actor, agentId) {
  if (!allowed(actor, "dueDiligence") && !allowed(actor, "decide") && !allowed(actor, "read")) throw new AppError(403, "You do not have permission to do that.");
  const a = await loadAgent(agentId);
  const [dd, referees, checks, persons, docState] = await Promise.all([
    repo.find(agentId), agentRepo.referees(agentId), repo.checksFor(agentId), agentRepo.persons(agentId),
    require("./agentDocumentService").checklistState(agentId),
  ]);
  const base = {
    questions: settings.questions(),
    referees: referees.map((r) => ({ ...r, checks: checks.filter((c) => c.referee_id === r.id) })),
    permissions: { record: allowed(actor, "dueDiligence"), decide: allowed(actor, "decide") },
  };
  if (!dd) return { ...base, opened: false, items: [], blockers: [], warnings: [], can_decide: false, status: a.status, decision: null };
  const list = buildChecklist(a, dd, referees, checks, persons, docState);
  const preparer = (dd.preparers || []).map(String).includes(String(actor.id));
  const decided = !!dd.decision;
  const sla = await require("./comsAgentService").slaFor(a);
  return {
    ...base,
    opened: true,
    status: a.status,
    items: list.items, blockers: list.blockers, warnings: list.warnings, positive_checks: list.positive,
    abn: { status: dd.abn_check_status, note: dd.abn_check_note, at: dd.abn_checked_at },
    marn: { status: dd.marn_check_status, note: dd.marn_check_note, at: dd.marn_checked_at },
    prisms: { status: dd.prisms_check_status, note: dd.prisms_check_note, at: dd.prisms_checked_at },
    declarations: {
      coi_declared: a.coi_declared, coi_details: a.coi_details, code_of_ethics_ack_at: a.code_of_ethics_ack_at,
      reviewed_at: dd.coi_reviewed_at, review_note: dd.coi_review_note, file: dd.coi_file,
    },
    prepared_by: dd.preparer_names,
    decision: decided ? { decision: dd.decision, reason: dd.decision_reason, at: dd.decided_at, by: `${dd.decided_first || ""} ${dd.decided_last || ""}`.trim() } : null,
    decision_state: sla?.decision || null,
    // the decision button: right role, file not prepared by this person (BR-06), still open
    can_decide: allowed(actor, "decide") && !preparer && a.status === "due_diligence",
    decide_blocked_reason: !allowed(actor, "decide") ? null : preparer ? "You prepared this file, so another approver must decide it." : null,
    can_reject: allowed(actor, "decide") && !preparer && IN_REVIEW.includes(a.status),
  };
}

// ---------- referees: staff can enter or correct them for an applicant ----------
async function addReferee(actor, agentId, body, ctx) {
  need(actor, "dueDiligence");
  const a = await loadAgent(agentId);
  mustBeInReview(a);
  const id = await withTransaction(async (client) => {
    const rid = await repo.insertReferee(client, agentId, body, actor.id);
    await audit.log({ actorId: actor.id, action: "agent.referee_added", entityType: ENTITY, entityId: agentId, after: { name: body.name, organisation: body.organisation }, ...ctx }, client);
    return rid;
  });
  return { id, referees: await agentRepo.referees(agentId) };
}
async function updateReferee(actor, agentId, refereeId, body, ctx) {
  need(actor, "dueDiligence");
  const a = await loadAgent(agentId);
  mustBeInReview(a);
  const before = await repo.findReferee(agentId, refereeId);
  if (!before) throw new AppError(404, "Referee not found.");
  await withTransaction(async (client) => {
    await repo.updateReferee(client, refereeId, body, actor.id);
    const after = await repo.findReferee(agentId, refereeId, client);
    const diff = changes(before, after, Object.keys(body));
    if (diff.changed) await audit.log({ actorId: actor.id, action: "agent.referee_updated", entityType: ENTITY, entityId: agentId, before: { referee: before.name, ...diff.before }, after: diff.after, ...ctx }, client);
  });
  return agentRepo.referees(agentId);
}
async function removeReferee(actor, agentId, refereeId, reason, ctx) {
  need(actor, "dueDiligence");
  const a = await loadAgent(agentId);
  mustBeInReview(a);
  const before = await repo.findReferee(agentId, refereeId);
  if (!before) throw new AppError(404, "Referee not found.");
  await withTransaction(async (client) => {
    await repo.softDeleteReferee(client, refereeId, reason, actor.id);
    await audit.log({ actorId: actor.id, action: "agent.referee_removed", entityType: ENTITY, entityId: agentId, before: { name: before.name, organisation: before.organisation }, metadata: { reason }, ...ctx }, client);
  });
  return agentRepo.referees(agentId);
}

// ---------- referee verification ----------
const linkFor = (token) => `${env.frontendUrl}/reference/${token}`;
const expiry = () => new Date(Date.now() + settings.timers().referee_link_days * 24 * 3600 * 1000);

// E1-4: the officer sends the online form to a referee
async function sendReferenceRequest(actor, agentId, refereeId, ctx) {
  need(actor, "dueDiligence");
  const a = await loadAgent(agentId);
  mustBeInReview(a);
  const ref = await repo.findReferee(agentId, refereeId);
  if (!ref) throw new AppError(404, "Referee not found.");
  if (await repo.pendingEmailCheck(refereeId)) throw new AppError(409, "A request is already waiting for this referee. Send a reminder instead.");
  const token = generateToken();
  await withTransaction(async (client) => {
    await repo.open(client, agentId, actor.id); // makes sure the record exists
    await repo.addPreparer(client, agentId, actor.id);
    await repo.insertCheck(client, {
      agentId, refereeId, method: "email_form", tokenHash: hashToken(token), tokenExpires: expiry(), sentAt: new Date(), actorId: actor.id,
    });
    await audit.log({ actorId: actor.id, action: "agent.referee_requested", entityType: ENTITY, entityId: agentId, after: { referee: ref.name, organisation: ref.organisation, method: "email_form" }, ...ctx }, client);
  });
  email.sendReferenceRequest({ to: ref.email, refereeName: ref.name, agentName: a.legal_name, officerName: nameOf(actor), link: linkFor(token) });
  return get(actor, agentId);
}

async function sendReminder(actor, agentId, checkId, ctx) {
  need(actor, "dueDiligence");
  const a = await loadAgent(agentId);
  mustBeInReview(a);
  const c = await repo.findCheck(agentId, checkId);
  if (!c || c.method !== "email_form" || c.outcome !== "pending" || c.response_at) throw new AppError(409, "This request is not waiting for an answer.");
  const ref = await repo.findReferee(agentId, c.referee_id);
  const token = generateToken();
  await repo.setReminder(checkId, hashToken(token), expiry());
  await audit.log({ actorId: actor.id, action: "agent.reference_reminded", entityType: ENTITY, entityId: agentId, metadata: { referee: ref.name }, ...ctx });
  email.sendReferenceRequest({ to: ref.email, refereeName: ref.name, agentName: a.legal_name, officerName: nameOf(actor), link: linkFor(token), reminder: true });
  return get(actor, agentId);
}

// phone verification: the officer fills in the same questions
async function recordPhoneCheck(actor, agentId, refereeId, body, ctx) {
  need(actor, "dueDiligence");
  const a = await loadAgent(agentId);
  mustBeInReview(a);
  const ref = await repo.findReferee(agentId, refereeId);
  if (!ref) throw new AppError(404, "Referee not found.");
  if (body.call_date > calendar.localDate()) throw fieldError("call_date", "The call date cannot be in the future");
  const asked = settings.questions();
  const answers = checkAnswers(body.answers, asked);
  const outcome = body.outcome || outcomeFor(answers, asked);
  let fileKey = null;
  try {
    await withTransaction(async (client) => {
      await repo.open(client, agentId, actor.id);
      await repo.addPreparer(client, agentId, actor.id);
      let fileId = null;
      if (body.file) { const f = await saveFile(client, body.file, "referee", actor.id); fileId = f.id; fileKey = f.key; }
      await repo.insertCheck(client, {
        agentId, refereeId, method: "phone", callDate: body.call_date, spokeTo: body.spoke_to, responseAt: new Date(),
        answers, questions: asked, outcome, outcomeBy: actor.id, summary: body.summary, fileId, actorId: actor.id, sentAt: null,
      });
      await audit.log({ actorId: actor.id, action: "agent.reference_phone_recorded", entityType: ENTITY, entityId: agentId, after: { referee: ref.name, call_date: body.call_date, outcome }, ...ctx }, client);
    });
  } catch (err) {
    if (fileKey) await storage.remove(fileKey);
    throw err;
  }
  return get(actor, agentId);
}

// staff confirm or change the outcome, or mark a referee who never answered
async function setOutcome(actor, agentId, checkId, { outcome, summary }, ctx) {
  need(actor, "dueDiligence");
  const a = await loadAgent(agentId);
  mustBeInReview(a);
  const c = await repo.findCheck(agentId, checkId);
  if (!c) throw new AppError(404, "Check not found.");
  const answered = !!c.response_at;
  if (!answered && outcome !== "no_response") throw new AppError(409, "This referee has not answered yet. You can only mark it as no response.");
  if (answered && outcome === "no_response") throw new AppError(409, "This referee has answered.");
  await withTransaction(async (client) => {
    await repo.addPreparer(client, agentId, actor.id);
    await repo.setOutcome(client, checkId, { outcome, summary }, actor.id);
    if (outcome === "no_response") await client.query(`UPDATE referee_checks SET token_hash = NULL WHERE id = $1`, [checkId]);
    await audit.log({ actorId: actor.id, action: "agent.reference_outcome_set", entityType: ENTITY, entityId: agentId, before: { outcome: c.outcome }, after: { outcome }, metadata: { summary }, ...ctx }, client);
  });
  return get(actor, agentId);
}

// ---------- the referee's own page (no sign-in) ----------
async function referenceForm(token) {
  const row = await repo.findByToken(hashToken(token));
  if (!row || !IN_REVIEW.includes(row.agent_status)) throw new AppError(404, BAD_LINK);
  if (row.response_at) return { submitted: true, agent_name: row.agent_name, referee_name: row.referee_name };
  if (new Date(row.token_expires_at) < new Date()) throw new AppError(410, BAD_LINK);
  return {
    submitted: false, agent_name: row.agent_name, referee_name: row.referee_name, organisation: row.organisation,
    questions: settings.questions().map(({ key, type, label, required, detail, favourable }) => ({ key, type, label, required, detail: !!detail, detail_when: detail ? !favourable : undefined })),
  };
}

async function submitReference(token, rawAnswers, ctx) {
  const hash = hashToken(token);
  const asked = settings.questions();
  const answers = checkAnswers(rawAnswers, asked);
  const outcome = outcomeFor(answers, asked);
  const row = await withTransaction(async (client) => {
    const r = await repo.findByToken(hash, client);
    if (!r || !IN_REVIEW.includes(r.agent_status)) throw new AppError(404, BAD_LINK);
    if (r.response_at) throw new AppError(409, "This form has already been submitted. Thank you.");
    if (new Date(r.token_expires_at) < new Date()) throw new AppError(410, BAD_LINK);
    await repo.saveResponse(client, r.id, answers, outcome, asked);
    await audit.log({ actorId: null, action: "agent.reference_received", entityType: ENTITY, entityId: r.agent_id, after: { referee: r.referee_name, organisation: r.organisation, outcome }, ip: ctx?.ip, userAgent: ctx?.userAgent }, client);
    return r;
  });
  // tell the officer who sent the request
  const check = await repo.findCheck(row.agent_id, row.id);
  const sender = check?.sent_by ? await userRepo.findById(check.sent_by) : null;
  if (sender && sender.status === "active") {
    email.sendReferenceReceived({
      to: sender.email, firstName: sender.first_name, agentName: row.agent_name, refereeName: row.referee_name, outcome,
      link: `${env.frontendUrl}/coms/agents/${row.agent_id}`,
    });
  }
  return { submitted: true };
}

// ---------- ABN / MARN / PRISMS checks and declarations ----------
async function recordCheck(actor, agentId, { key, status, note }, ctx) {
  need(actor, "dueDiligence");
  const a = await loadAgent(agentId);
  mustBeInReview(a);
  if (key === "prisms" && status === "not_applicable") throw fieldError("status", "The PRISMS data check always applies");
  if (key === "abn" && status === "verified" && /^australia$/i.test(a.country)) {
    const { validAbnOrAcn } = require("../utils/abn");
    if (!a.abn_acn || !validAbnOrAcn(a.abn_acn)) throw fieldError("status", "The ABN or ACN on the record is not valid. Correct it first.");
  }
  if (status === "failed" && !String(note || "").trim()) throw fieldError("note", "Please say what failed");
  if (key === "marn" && status === "not_applicable" && (a.marn || (await agentRepo.persons(agentId)).some((p) => p.marn))) {
    throw fieldError("status", "A MARN is on the application, so it needs to be checked");
  }
  const before = await repo.find(agentId);
  await withTransaction(async (client) => {
    await repo.open(client, agentId, actor.id);
    await repo.addPreparer(client, agentId, actor.id);
    await repo.setCheck(client, agentId, key, { status, note }, actor.id);
    await audit.log({
      actorId: actor.id, action: "agent.due_diligence_check", entityType: ENTITY, entityId: agentId,
      before: { [key]: before?.[`${key}_check_status`] || null }, after: { [key]: status }, metadata: { note: note || null }, ...ctx,
    }, client);
  });
  return get(actor, agentId);
}

// the applicant's declarations, entered or corrected by staff, and the college's review of them
async function recordDeclarations(actor, agentId, body, ctx) {
  need(actor, "dueDiligence");
  const a = await loadAgent(agentId);
  mustBeInReview(a);
  if (body.coi_declared && !String(body.coi_details || "").trim()) throw fieldError("coi_details", "Please describe the conflict");
  let fileKey = null;
  try {
    await withTransaction(async (client) => {
      await repo.open(client, agentId, actor.id);
      await repo.addPreparer(client, agentId, actor.id);
      await repo.setDeclarations(client, agentId, { coi_declared: body.coi_declared, coi_details: body.coi_details, ack: body.code_of_ethics_ack }, actor.id);
      let fileId = null;
      if (body.file) { const f = await saveFile(client, body.file, "declaration", actor.id); fileId = f.id; fileKey = f.key; }
      await repo.setCoiReview(client, agentId, { note: body.coi_review_note, fileId }, actor.id);
      await audit.log({
        actorId: actor.id, action: "agent.declarations_recorded", entityType: ENTITY, entityId: agentId,
        before: { coi_declared: a.coi_declared, code_of_ethics: !!a.code_of_ethics_ack_at },
        after: { coi_declared: body.coi_declared, code_of_ethics: !!(a.code_of_ethics_ack_at || body.code_of_ethics_ack) },
        metadata: { review_note: body.coi_review_note || null, file: body.file ? body.file.name : null }, ...ctx,
      }, client);
    });
  } catch (err) {
    if (fileKey) await storage.remove(fileKey);
    throw err;
  }
  return get(actor, agentId);
}

async function openFile(actor, fileId, ctx) {
  if (!allowed(actor, "read")) throw new AppError(403, "You do not have permission to do that.");
  const f = await repo.findFile(fileId);
  if (!f || !(await storage.exists(f.storage_key))) throw new AppError(404, "File not found.");
  await audit.log({ actorId: actor.id, action: "coms.file_downloaded", entityType: "file", entityId: fileId, metadata: { kind: f.kind, name: f.original_name }, ...ctx });
  return { stream: storage.createReadStream(f.storage_key), name: f.original_name, mime: f.mime_type, size: f.size_bytes };
}

// ---------- the decision ----------
async function rejectionDraft(actor, agentId, reason) {
  if (!allowed(actor, "decide")) throw new AppError(403, "You do not have permission to do that.");
  const a = await loadAgent(agentId);
  const people = await agentRepo.persons(agentId);
  const to = people.find((p) => p.is_primary_contact) || people[0];
  const first = to?.name?.split(" ")[0] || "there";
  return {
    to: to?.email || a.email,
    subject: "About your agent application",
    body: [
      `Thank you for applying to become an education agent for Australian Federation College on behalf of ${a.legal_name}.`,
      `After careful review, we are not able to approve the application at this time.${reason ? ` The reason is: ${String(reason).trim()}` : ""}`,
      "You are welcome to contact us if you would like to discuss this decision or to apply again in the future.",
      `Kind regards,\n${nameOf(actor)}\nAustralian Federation College`,
    ].join("\n\n"),
    first_name: first,
  };
}

// E1-4 + BR-06 + BR-08
async function decide(actor, agentId, body, ctx) {
  need(actor, "decide");
  const approve = body.decision === "approve";
  const result = await withTransaction(async (client) => {
    const a = await loadAgent(agentId, client, { lock: true });
    if (!IN_REVIEW.includes(a.status)) throw new AppError(409, "This application has already been decided.");
    await repo.open(client, agentId, actor.id, false); // an early rejection still leaves a record
    const dd = await repo.find(agentId, client);
    // BR-06: whoever prepared the file cannot be the one who decides it
    if ((dd.preparers || []).map(String).includes(String(actor.id))) {
      throw new AppError(409, "You prepared this due diligence file, so another approver must make the decision (BR-06).");
    }
    if (approve) {
      const [referees, checks, persons] = await Promise.all([agentRepo.referees(agentId, client), repo.checksFor(agentId, client), agentRepo.persons(agentId, client)]);
      const docState = await require("./agentDocumentService").checklistState(agentId, client);
      const list = buildChecklist(a, dd, referees, checks, persons, docState);
      const blockers = [...(a.status === "due_diligence" ? [] : ["Due diligence has not been started. Move the application to due diligence first."]), ...list.blockers];
      if (blockers.length) throw new AppError(409, `This agent cannot be approved yet. ${blockers.join(" ")}`, { blockers });
    }
    const to = approve ? "approved" : "rejected";
    await agentRepo.setStatus(client, agentId, to, actor.id, { reason: body.reason });
    await agentRepo.addHistory(client, { agentId, from: a.status, to, reason: body.reason, actorId: actor.id });
    await repo.setDecision(client, agentId, { decision: to, reason: body.reason }, actor.id);
    await repo.decideUsers(client, agentId, approve, actor.id, body.reason);
    await audit.log({
      actorId: actor.id, action: approve ? "agent.approved" : "agent.rejected", entityType: ENTITY, entityId: agentId,
      before: { status: a.status }, after: { status: to }, metadata: { reason: body.reason }, ...ctx,
    }, client);
    const people = await agentRepo.persons(agentId, client);
    // the older Agents screen shows its history per login, so the decision is also noted on each portal user
    for (const p of people.filter((x) => x.portal_user_id)) {
      await audit.log({ actorId: actor.id, action: approve ? "agent.approved" : "agent.rejected", entityType: "user", entityId: p.portal_user_id, metadata: { reason: body.reason, agent: agentId }, ...ctx }, client);
    }
    return { from: a.status, people, agent: a };
  });

  const to = result.people.find((p) => p.portal_user_id) || result.people.find((p) => p.is_primary_contact) || result.people[0];
  if (to) {
    const first = to.name.split(" ")[0];
    if (approve) email.sendAgentApproved({ to: to.email, firstName: first, signInUrl: `${env.frontendUrl}/signin` });
    else if (body.send_email !== false) {
      if (body.email_body) email.sendAgentDecision({ to: to.email, firstName: first, subject: body.email_subject || "About your agent application", body: body.email_body });
      else email.sendAgentRejected({ to: to.email, firstName: first, reason: body.reason });
    }
  }
  return require("./comsAgentService").getDetail(actor, agentId);
}

module.exports = {
  get, addReferee, updateReferee, removeReferee, sendReferenceRequest, sendReminder, recordPhoneCheck, setOutcome,
  referenceForm, submitReference, recordCheck, recordDeclarations, openFile, rejectionDraft, decide,
  buildChecklist, checkAnswers, outcomeFor,
};
