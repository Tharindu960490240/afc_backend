const { query } = require("../config/db");

// "expired" is worked out from the dates, so it is always correct without a nightly job.
const EFFECTIVE_STATUS = `CASE WHEN a.status = 'active' AND a.expires_at < CURRENT_DATE THEN 'expired' ELSE a.status END`;

const FROM = `
  FROM agreements a
  JOIN users u ON u.id = a.agent_id
  LEFT JOIN agent_profiles ap ON ap.user_id = a.agent_id`;

// Columns every screen needs (no long text and no images, so lists stay light).
const COLUMNS = `
  a.id, a.agent_id, a.title, a.note, a.status AS stored_status,
  ${EFFECTIVE_STATUS} AS status,
  a.validity_months, a.sent_at, a.submitted_at, a.reviewed_at, a.rejection_reason,
  a.effective_date, a.expires_at,
  CASE WHEN a.expires_at IS NULL THEN NULL ELSE (a.expires_at - CURRENT_DATE) END AS days_left,
  a.created_at,
  a.agent_sig_name, a.agent_signed_at, a.agent_signed_ip,
  a.admin_sig_name, a.admin_sig_position, a.admin_signed_at, a.admin_signed_ip,
  (a.body_snapshot IS NOT NULL) AS in_portal,
  (SELECT f.id FROM agreement_files f WHERE f.agreement_id = a.id AND f.kind = 'final' ORDER BY f.id DESC LIMIT 1) AS final_file_id,
  u.first_name AS agent_first_name, u.last_name AS agent_last_name, u.email AS agent_email,
  ap.agency_name`;

const SELECT = `SELECT ${COLUMNS} ${FROM}`;

const q = (client) => client || { query };

const create = async (client, a) =>
  (
    await client.query(
      `INSERT INTO agreements (agent_id, title, note, status, validity_months, sent_by, template_id, body_snapshot, body_sha256)
       VALUES ($1,$2,$3,'sent',$4,$5,$6,$7,$8) RETURNING id`,
      [a.agentId, a.title, a.note || null, a.validityMonths, a.sentBy, a.templateId, a.bodySnapshot, a.bodySha256],
    )
  ).rows[0].id;

const findById = async (id, client) =>
  (await q(client).query(`${SELECT} WHERE a.id = $1`, [id])).rows[0];

// Everything needed to draw the PDF: the wording and the signature images too.
const findForDocument = async (id, client) =>
  (
    await q(client).query(
      `SELECT ${COLUMNS}, a.body_snapshot, a.body_sha256, a.agent_sig_image, a.admin_sig_image
       ${FROM} WHERE a.id = $1`,
      [id],
    )
  ).rows[0];

// Locks the row so two people cannot act on the same agreement at once.
const lockById = async (client, id) =>
  (await client.query(`SELECT * FROM agreements WHERE id = $1 FOR UPDATE`, [id])).rows[0];

const list = async ({ agentId, status, limit, offset }) => {
  const where = [];
  const values = [];
  if (agentId) { values.push(agentId); where.push(`a.agent_id = $${values.length}`); }
  if (status) { values.push(status); where.push(`${EFFECTIVE_STATUS} = $${values.length}`); }
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number((await query(`SELECT COUNT(*) FROM agreements a ${clause}`, values)).rows[0].count);
  const rows = (
    await query(
      `${SELECT} ${clause}
       ORDER BY (a.status = 'submitted') DESC, a.created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    )
  ).rows;
  return { rows, total };
};

const hasOpen = async (client, agentId) =>
  (await client.query(`SELECT 1 FROM agreements WHERE agent_id = $1 AND status IN ('sent','submitted','rejected')`, [agentId])).rowCount > 0;

const addFile = async (client, f) =>
  (
    await client.query(
      `INSERT INTO agreement_files (agreement_id, kind, original_name, storage_key, mime_type, size_bytes, sha256, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
      [f.agreementId, f.kind, f.originalName, f.key, f.mime, f.size, f.sha256, f.uploadedBy],
    )
  ).rows[0].id;

const listFiles = async (agreementId) =>
  (
    await query(
      `SELECT f.id, f.kind, f.original_name, f.mime_type, f.size_bytes, f.created_at,
              u.first_name AS uploaded_by_first_name, u.last_name AS uploaded_by_last_name
       FROM agreement_files f LEFT JOIN users u ON u.id = f.uploaded_by
       WHERE f.agreement_id = $1 ORDER BY f.created_at, f.id`,
      [agreementId],
    )
  ).rows;

const findFile = async (agreementId, fileId) =>
  (await query(`SELECT * FROM agreement_files WHERE id = $1 AND agreement_id = $2`, [fileId, agreementId])).rows[0];

const addEvent = (client, agreementId, actorId, type, note) =>
  client.query(`INSERT INTO agreement_events (agreement_id, actor_id, type, note) VALUES ($1,$2,$3,$4)`, [agreementId, actorId, type, note || null]);

const listEvents = async (agreementId) =>
  (
    await query(
      `SELECT e.id, e.type, e.note, e.created_at, u.first_name, u.last_name, u.role
       FROM agreement_events e LEFT JOIN users u ON u.id = e.actor_id
       WHERE e.agreement_id = $1 ORDER BY e.created_at, e.id`,
      [agreementId],
    )
  ).rows;

// The agent signed in the portal.
const markSigned = (client, id, sig) =>
  client.query(
    `UPDATE agreements SET status='submitted', submitted_at=now(), rejection_reason=NULL,
       agent_sig_name=$2, agent_sig_image=$3, agent_signed_at=now(), agent_signed_ip=$4,
       reminder_count=0, last_reminder_at=NULL, updated_at=now() WHERE id=$1`,
    [id, sig.name, sig.image, sig.ip],
  );

// Rejecting clears the agent's signature, so they read and sign again.
const markRejected = (client, id, adminId, reason) =>
  client.query(
    `UPDATE agreements SET status='rejected', reviewed_by=$2, reviewed_at=now(), rejection_reason=$3,
       agent_sig_name=NULL, agent_sig_image=NULL, agent_signed_at=NULL, agent_signed_ip=NULL,
       reminder_count=0, last_reminder_at=NULL, updated_at=now() WHERE id=$1`,
    [id, adminId, reason],
  );

// Activates the agreement and retires the agent's older active ones.
const markActive = async (client, id, agentId, adminId, effectiveDate, months, sig) => {
  await client.query(
    `UPDATE agreements SET status='superseded', updated_at=now()
     WHERE agent_id=$1 AND id<>$2 AND status='active'`,
    [agentId, id],
  );
  await client.query(
    `UPDATE agreements SET status='active', reviewed_by=$2, reviewed_at=now(), rejection_reason=NULL,
       validity_months=$4::int, effective_date=$3::date,
       expires_at=($3::date + make_interval(months => $4::int))::date,
       admin_sig_name=$5, admin_sig_position=$6, admin_sig_image=$7, admin_signed_at=now(), admin_signed_ip=$8,
       expiry_notice_days=NULL, updated_at=now()
     WHERE id=$1`,
    [id, adminId, effectiveDate, months, sig.name, sig.position, sig.image, sig.ip],
  );
};

const markCancelled = (client, id, adminId) =>
  client.query(`UPDATE agreements SET status='cancelled', reviewed_by=$2, reviewed_at=now(), updated_at=now() WHERE id=$1`, [id, adminId]);

// True when this agent has a countersigned agreement that is still in force.
const hasActiveAgreement = async (agentId) =>
  (await query(`SELECT 1 FROM agreements WHERE agent_id=$1 AND status='active' AND expires_at >= CURRENT_DATE`, [agentId])).rowCount > 0;

// ---------- agents overview (one row per agent) ----------
const agentsOverview = async ({ search, agreement, limit, offset }) => {
  const values = [];
  const where = [`u.role = 'agent'`, `u.status IN ('active','suspended')`];
  if (search) {
    values.push(`%${search.replace(/[%_\\]/g, "\\$&")}%`);
    const i = values.length;
    where.push(`(u.first_name ILIKE $${i} OR u.last_name ILIKE $${i} OR u.email ILIKE $${i} OR ap.agency_name ILIKE $${i})`);
  }
  if (agreement === "none") where.push(`cur.id IS NULL`);
  else if (agreement === "expiring") where.push(`cur.agreement_status = 'active' AND cur.days_left <= 60`);
  else if (agreement) { values.push(agreement); where.push(`cur.agreement_status = $${values.length}`); }

  const from = `
    FROM users u
    LEFT JOIN agent_profiles ap ON ap.user_id = u.id
    LEFT JOIN LATERAL (
      SELECT a.id, a.expires_at, (a.expires_at - CURRENT_DATE) AS days_left,
             ${EFFECTIVE_STATUS} AS agreement_status
      FROM agreements a
      WHERE a.agent_id = u.id AND a.status IN ('sent','submitted','rejected','active')
      ORDER BY (a.status IN ('sent','submitted','rejected')) DESC, a.created_at DESC
      LIMIT 1
    ) cur ON true
    WHERE ${where.join(" AND ")}`;

  const total = Number((await query(`SELECT COUNT(*) ${from}`, values)).rows[0].count);
  const rows = (
    await query(
      `SELECT u.id, u.first_name, u.last_name, u.email, u.status AS user_status, u.last_login_at,
              ap.agency_name, ap.country,
              cur.id AS agreement_id, cur.agreement_status, cur.expires_at, cur.days_left
       ${from} ORDER BY u.created_at DESC LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset],
    )
  ).rows;
  return { rows, total };
};

// ---------- reminder queries ----------
const dueAgentReminders = async (everyDays, maxReminders) =>
  (
    await query(
      `${SELECT}
       WHERE a.status IN ('sent','rejected') AND a.reminder_count < $2
         AND COALESCE(a.last_reminder_at, CASE WHEN a.status='rejected' THEN a.reviewed_at ELSE a.sent_at END)
             <= now() - ($1 || ' days')::interval`,
      [String(everyDays), maxReminders],
    )
  ).rows;

const dueReviewReminders = async (afterDays) =>
  (
    await query(
      `${SELECT}
       WHERE a.status = 'submitted'
         AND COALESCE(a.last_reminder_at, a.submitted_at) <= now() - ($1 || ' days')::interval`,
      [String(afterDays)],
    )
  ).rows;

const touchReminder = (id) =>
  query(`UPDATE agreements SET last_reminder_at = now(), reminder_count = reminder_count + 1 WHERE id = $1`, [id]);

// Active agreements that have reached a new warning point (60, 30, 7 days, then expired).
const dueExpiryNotices = async () =>
  (
    await query(
      `${SELECT}
       WHERE a.status = 'active' AND (a.expires_at - CURRENT_DATE) <= 60
         AND (a.expiry_notice_days IS NULL OR a.expiry_notice_days > (
              CASE WHEN a.expires_at < CURRENT_DATE THEN -1
                   WHEN (a.expires_at - CURRENT_DATE) <= 7  THEN 7
                   WHEN (a.expires_at - CURRENT_DATE) <= 30 THEN 30
                   ELSE 60 END))`,
    )
  ).rows;

const setExpiryNotice = (id, stage) => query(`UPDATE agreements SET expiry_notice_days = $2 WHERE id = $1`, [id, stage]);

module.exports = {
  create, findById, findForDocument, lockById, list, hasOpen, addFile, listFiles, findFile, addEvent, listEvents,
  markSigned, markRejected, markActive, markCancelled, hasActiveAgreement, agentsOverview,
  dueAgentReminders, dueReviewReminders, touchReminder, dueExpiryNotices, setExpiryNotice,
};
