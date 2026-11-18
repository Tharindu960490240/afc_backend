const { query } = require("../config/db");
const q = (client) => client || { query };

// ---------- communications ----------
const COMM_COLS = `c.id, c.agent_id, c.type, c.direction, c.occurred_at, c.subject, c.summary, c.source, c.created_at, c.edited_at,
  c.staff_id, trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS staff_name`;
const comms = async (agentId, { forAgent = false } = {}) =>
  (await query(
    `SELECT ${COMM_COLS} FROM agent_communications c LEFT JOIN users u ON u.id = c.staff_id
      WHERE c.agent_id = $1 ORDER BY c.occurred_at DESC, c.created_at DESC LIMIT 500`, [agentId])).rows;
const commById = async (id) =>
  (await query(`SELECT ${COMM_COLS} FROM agent_communications c LEFT JOIN users u ON u.id = c.staff_id WHERE c.id = $1`, [id])).rows[0];
const insertComm = async (client, c) =>
  (await q(client).query(
    `INSERT INTO agent_communications (agent_id, type, direction, occurred_at, staff_id, subject, summary, source, external_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (external_id) DO NOTHING RETURNING id`,
    [c.agentId, c.type, c.direction || "outbound", c.occurredAt || new Date(), c.staffId || null, c.subject || null, c.summary, c.source || "staff", c.externalId || null])).rows[0]?.id;
const updateComm = (client, id, c, actorId) =>
  q(client).query(
    `UPDATE agent_communications SET type=$2, direction=$3, occurred_at=$4, subject=$5, summary=$6, edited_at=now(), edited_by=$7 WHERE id=$1`,
    [id, c.type, c.direction, c.occurredAt, c.subject || null, c.summary, actorId]);

// ---------- leads ----------
const leads = async (agentId) =>
  (await query(`SELECT * FROM agent_leads WHERE agent_id = $1 ORDER BY contact_date DESC, created_at DESC`, [agentId])).rows.map(fixLead);
const fixLead = (r) => ({ ...r, contact_date: r.contact_date instanceof Date ? r.contact_date.toISOString().slice(0, 10) : r.contact_date });
const leadById = async (id) => { const r = (await query(`SELECT * FROM agent_leads WHERE id = $1`, [id])).rows[0]; return r && fixLead(r); };
const insertLead = async (client, l) =>
  (await q(client).query(
    `INSERT INTO agent_leads (agent_id, student_name, country, course_interest, contact_date, outcome, notes, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
    [l.agentId, l.student_name, l.country, l.course_interest, l.contact_date, l.outcome || "pending", l.notes || null, l.actorId])).rows[0].id;
const updateLead = (client, id, l, actorId) =>
  q(client).query(
    `UPDATE agent_leads SET student_name=$2, country=$3, course_interest=$4, contact_date=$5, outcome=$6, notes=$7, updated_by=$8, updated_at=now() WHERE id=$1`,
    [id, l.student_name, l.country, l.course_interest, l.contact_date, l.outcome, l.notes || null, actorId]);
const leadCounts = async (agentId, from, to) =>
  (await query(
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE outcome = 'submitted')::int AS submitted FROM agent_leads
      WHERE agent_id = $1 AND contact_date BETWEEN $2::date AND $3::date`, [agentId, from, to])).rows[0];

// ---------- training ----------
const training = async (agentId) =>
  (await query(
    `SELECT t.id, t.title, t.kind, to_char(t.held_on,'YYYY-MM-DD') AS held_on, t.delivered_by, t.notes, t.created_at,
            trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS recorded_by
       FROM agent_training_records t LEFT JOIN users u ON u.id = t.created_by WHERE t.agent_id = $1 ORDER BY t.held_on DESC, t.created_at DESC`, [agentId])).rows;
const insertTraining = async (client, t) =>
  (await q(client).query(
    `INSERT INTO agent_training_records (agent_id, title, kind, held_on, delivered_by, notes, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
    [t.agentId, t.title, t.kind, t.held_on, t.delivered_by || null, t.notes || null, t.actorId])).rows[0].id;

// ---------- monitoring reviews ----------
const REVIEW_COLS = `r.id, r.agent_id, r.agreement_id, to_char(r.period_start,'YYYY-MM-DD') AS period_start, to_char(r.period_end,'YYYY-MM-DD') AS period_end,
  r.applications_submitted, r.conversion_rate, r.student_performance, r.incidents_found, r.incidents_detail,
  r.unauthorised_advice_found, r.unauthorised_advice_detail, r.outcome, r.notes, r.task_id, r.completed_at,
  trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS completed_by_name`;
const reviews = async (agentId) =>
  (await query(`SELECT ${REVIEW_COLS} FROM agent_monitoring_reviews r LEFT JOIN users u ON u.id = r.completed_by WHERE r.agent_id = $1 ORDER BY r.period_end DESC, r.completed_at DESC`, [agentId])).rows
    .map((r) => ({ ...r, conversion_rate: r.conversion_rate == null ? null : Number(r.conversion_rate) }));
const reviewById = async (id) =>
  (await query(`SELECT ${REVIEW_COLS} FROM agent_monitoring_reviews r LEFT JOIN users u ON u.id = r.completed_by WHERE r.id = $1`, [id])).rows[0];
const insertReview = async (client, r) =>
  (await q(client).query(
    `INSERT INTO agent_monitoring_reviews (agent_id, agreement_id, period_start, period_end, applications_submitted, conversion_rate, student_performance,
       incidents_found, incidents_detail, unauthorised_advice_found, unauthorised_advice_detail, outcome, notes, task_id, completed_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) RETURNING id`,
    [r.agentId, r.agreementId || null, r.period_start, r.period_end, r.applications_submitted, r.conversion_rate ?? null, r.student_performance,
     !!r.incidents_found, r.incidents_detail || null, !!r.unauthorised_advice_found, r.unauthorised_advice_detail || null, r.outcome, r.notes || null, r.taskId || null, r.actorId])).rows[0].id;
const openMonitoringTask = async (client, agentId) =>
  (await q(client).query(
    `SELECT id, to_char(due_date,'YYYY-MM-DD') AS due_date, agreement_id FROM coms_tasks WHERE agent_id = $1 AND type = 'MONITORING' AND status = 'open' AND deleted_at IS NULL
      ORDER BY due_date LIMIT 1`, [agentId])).rows[0];
const currentAgreement = async (agentId) =>
  (await query(
    `SELECT ag.id, to_char(ag.effective_date,'YYYY-MM-DD') AS effective_date FROM agreements ag JOIN agent_persons p ON p.portal_user_id = ag.agent_id AND p.deleted_at IS NULL
      WHERE p.agent_id = $1 AND ag.status = 'active' AND ag.effective_date IS NOT NULL ORDER BY ag.effective_date DESC LIMIT 1`, [agentId])).rows[0];

// ---------- corrective actions ----------
const CA_COLS = `c.id, c.agent_id, c.review_id, c.issues, c.required_actions, to_char(c.due_date,'YYYY-MM-DD') AS due_date, c.notice_subject, c.notice_body, c.status,
  c.sent_at, c.sent_to, c.resolved_at, c.resolution_note, c.created_at,
  trim(coalesce(d.first_name,'') || ' ' || coalesce(d.last_name,'')) AS drafted_by_name, trim(coalesce(s.first_name,'') || ' ' || coalesce(s.last_name,'')) AS sent_by_name,
  (c.status = 'sent' AND c.due_date < CURRENT_DATE) AS overdue`;
const CA_FROM = `FROM agent_corrective_actions c LEFT JOIN users d ON d.id = c.drafted_by LEFT JOIN users s ON s.id = c.sent_by`;
const correctives = async (agentId) => (await query(`SELECT ${CA_COLS} ${CA_FROM} WHERE c.agent_id = $1 ORDER BY c.created_at DESC`, [agentId])).rows;
const correctiveById = async (id) => (await query(`SELECT ${CA_COLS} ${CA_FROM} WHERE c.id = $1`, [id])).rows[0];
const insertCorrective = async (client, c) =>
  (await q(client).query(
    `INSERT INTO agent_corrective_actions (agent_id, review_id, issues, required_actions, due_date, notice_subject, notice_body, drafted_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [c.agentId, c.reviewId || null, c.issues, c.required_actions, c.due_date, c.subject, c.body, c.actorId])).rows[0].id;
const updateCorrectiveDraft = (client, id, c) =>
  q(client).query(
    `UPDATE agent_corrective_actions SET issues=$2, required_actions=$3, due_date=$4, notice_subject=$5, notice_body=$6, updated_at=now() WHERE id=$1`,
    [id, c.issues, c.required_actions, c.due_date, c.subject, c.body]);
const markCorrectiveSent = (client, id, actorId, to) =>
  q(client).query(`UPDATE agent_corrective_actions SET status='sent', sent_by=$2, sent_at=now(), sent_to=$3, updated_at=now() WHERE id=$1`, [id, actorId, to]);
const resolveCorrective = (client, id, status, actorId, note) =>
  q(client).query(`UPDATE agent_corrective_actions SET status=$2::varchar, resolved_by=$3, resolved_at=now(), resolution_note=$4, updated_at=now() WHERE id=$1`, [id, status, actorId, note || null]);
const overdueCorrectives = async () =>
  (await query(
    `SELECT c.id, c.agent_id, to_char(c.due_date,'YYYY-MM-DD') AS due_date, a.legal_name, a.account_manager_id FROM agent_corrective_actions c JOIN agents a ON a.id = c.agent_id
      WHERE c.status = 'sent' AND c.due_date < CURRENT_DATE AND c.overdue_alerted_at IS NULL AND a.deleted_at IS NULL`)).rows;
const markCorrectiveAlerted = (id) => query(`UPDATE agent_corrective_actions SET overdue_alerted_at = now() WHERE id = $1`, [id]);

// ---------- broadcasts ----------
const BC_COLS = `b.id, b.kind, b.subject, b.body, b.status, b.approved_at, b.sent_at, b.recipients, b.created_at, b.updated_at,
  trim(coalesce(d.first_name,'') || ' ' || coalesce(d.last_name,'')) AS drafted_by_name, trim(coalesce(a.first_name,'') || ' ' || coalesce(a.last_name,'')) AS approved_by_name,
  (SELECT count(*)::int FROM marketing_broadcast_deliveries x WHERE x.broadcast_id = b.id) AS delivered`;
const BC_FROM = `FROM marketing_broadcasts b LEFT JOIN users d ON d.id = b.drafted_by LEFT JOIN users a ON a.id = b.approved_by`;
const broadcasts = async () => (await query(`SELECT ${BC_COLS} ${BC_FROM} ORDER BY b.created_at DESC LIMIT 200`)).rows;
const broadcastById = async (id) => (await query(`SELECT ${BC_COLS} ${BC_FROM} WHERE b.id = $1`, [id])).rows[0];
const broadcastDeliveries = async (id) =>
  (await query(`SELECT d.agent_id, a.legal_name, d.sent_to, d.sent_at FROM marketing_broadcast_deliveries d JOIN agents a ON a.id = d.agent_id WHERE d.broadcast_id = $1 ORDER BY a.legal_name`, [id])).rows;
const insertBroadcast = async (client, b) =>
  (await q(client).query(`INSERT INTO marketing_broadcasts (kind, subject, body, drafted_by) VALUES ($1,$2,$3,$4) RETURNING id`, [b.kind, b.subject, b.body, b.actorId])).rows[0].id;
const updateBroadcast = (client, id, b) =>
  q(client).query(`UPDATE marketing_broadcasts SET kind=$2, subject=$3, body=$4, updated_at=now() WHERE id=$1`, [id, b.kind, b.subject, b.body]);
const setBroadcastStatus = (client, id, status, actorId) =>
  q(client).query(
    `UPDATE marketing_broadcasts SET status=$2::varchar, updated_at=now(),
       approved_by = CASE WHEN $2::text = 'approved' THEN $3::bigint ELSE approved_by END, approved_at = CASE WHEN $2::text = 'approved' THEN now() ELSE approved_at END WHERE id=$1`,
    [id, status, actorId || null]);
const markBroadcastSent = (id, recipients) =>
  query(`UPDATE marketing_broadcasts SET status='sent', sent_at=now(), recipients=$2, updated_at=now() WHERE id=$1`, [id, recipients]);
const insertBroadcastDelivery = (b, a, to) =>
  query(`INSERT INTO marketing_broadcast_deliveries (broadcast_id, agent_id, sent_to) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [b, a, to]);
const stuckBroadcasts = async () =>
  (await query(`SELECT id, subject, body, approved_at, approved_by FROM marketing_broadcasts WHERE status = 'approved' AND approved_at < now() - interval '1 hour'`)).rows;
const deliveredAgents = async (id) => new Set((await query(`SELECT agent_id FROM marketing_broadcast_deliveries WHERE broadcast_id = $1`, [id])).rows.map((r) => r.agent_id));

// ---------- summary for the agent record ----------
const summary = async (agentId) => {
  const r = (await query(
    `SELECT (SELECT count(*)::int FROM agent_communications WHERE agent_id = $1) AS communications,
            (SELECT max(occurred_at) FROM agent_communications WHERE agent_id = $1 AND source <> 'system') AS last_contact,
            (SELECT count(*)::int FROM agent_leads WHERE agent_id = $1) AS leads,
            (SELECT count(*)::int FROM agent_leads WHERE agent_id = $1 AND outcome = 'pending') AS leads_pending,
            (SELECT count(*)::int FROM agent_monitoring_reviews WHERE agent_id = $1) AS reviews,
            (SELECT to_char(max(period_end),'YYYY-MM-DD') FROM agent_monitoring_reviews WHERE agent_id = $1) AS last_review,
            (SELECT count(*)::int FROM agent_corrective_actions WHERE agent_id = $1 AND status = 'sent') AS open_corrective,
            (SELECT count(*)::int FROM agent_corrective_actions WHERE agent_id = $1 AND status = 'sent' AND due_date < CURRENT_DATE) AS overdue_corrective,
            (SELECT to_char(min(due_date),'YYYY-MM-DD') FROM coms_tasks WHERE agent_id = $1 AND type = 'MONITORING' AND status = 'open' AND deleted_at IS NULL) AS monitoring_due`, [agentId])).rows[0];
  return r;
};

// ---------- lookups for the inbound email log ----------
const agentByEmail = async (email) =>
  (await query(
    `SELECT a.id FROM agents a WHERE a.deleted_at IS NULL AND (lower(a.email) = $1 OR EXISTS (SELECT 1 FROM agent_persons p WHERE p.agent_id = a.id AND p.deleted_at IS NULL AND lower(p.email) = $1))
      ORDER BY a.created_at LIMIT 1`, [email])).rows[0];
const staffByEmail = async (email) => (await query(`SELECT id FROM users WHERE lower(email) = $1 AND status = 'active' AND role <> 'agent' LIMIT 1`, [email])).rows[0];
const agentPrimary = async (agentId) =>
  (await query(
    `SELECT coalesce((SELECT p.email FROM agent_persons p WHERE p.agent_id = a.id AND p.deleted_at IS NULL AND p.email IS NOT NULL ORDER BY p.is_primary_contact DESC, p.created_at LIMIT 1), a.email) AS email,
            coalesce((SELECT split_part(p.name, ' ', 1) FROM agent_persons p WHERE p.agent_id = a.id AND p.deleted_at IS NULL ORDER BY p.is_primary_contact DESC, p.created_at LIMIT 1), a.legal_name) AS first_name,
            a.legal_name
       FROM agents a WHERE a.id = $1`, [agentId])).rows[0];

module.exports = {
  comms, commById, insertComm, updateComm,
  leads, leadById, insertLead, updateLead, leadCounts,
  training, insertTraining,
  reviews, reviewById, insertReview, openMonitoringTask, currentAgreement,
  correctives, correctiveById, insertCorrective, updateCorrectiveDraft, markCorrectiveSent, resolveCorrective, overdueCorrectives, markCorrectiveAlerted,
  broadcasts, broadcastById, broadcastDeliveries, insertBroadcast, updateBroadcast, setBroadcastStatus, markBroadcastSent, insertBroadcastDelivery, stuckBroadcasts, deliveredAgents,
  summary, agentByEmail, staffByEmail, agentPrimary,
};
