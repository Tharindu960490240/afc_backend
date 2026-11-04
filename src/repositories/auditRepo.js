const { query } = require("../config/db");

// Never throws: a failed audit write must not break the user's request.
// before / after hold the old and new values of a changed record (NF-04).
async function log(
  { actorId = null, action, entityType = null, entityId = null, ip = null, userAgent = null, metadata = {}, before = null, after = null },
  client,
) {
  try {
    await (client || { query }).query(
      `INSERT INTO audit_logs (actor_id, action, entity_type, entity_id, ip, user_agent, metadata, before, after)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [
        actorId, action, entityType, entityId == null ? null : String(entityId), ip, userAgent,
        JSON.stringify(metadata), before ? JSON.stringify(before) : null, after ? JSON.stringify(after) : null,
      ],
    );
  } catch (err) {
    console.error("audit log failed:", err.message);
  }
}

// For the Compliance viewer and the history on a record.
async function search({ entityType, entityId, actorId, action, from, to, limit, offset }) {
  const where = [];
  const v = [];
  const add = (sql, val) => { v.push(val); where.push(sql.replace("?", `$${v.length}`)); };
  if (entityType) add("a.entity_type = ?", entityType);
  if (entityId) add("a.entity_id = ?", String(entityId));
  if (actorId) add("a.actor_id = ?", actorId);
  if (action) add("a.action LIKE ?", `${action.replace(/[%_]/g, "")}%`);
  if (from) add("a.created_at >= ?", from);
  if (to) add("a.created_at < (?::date + 1)", to);
  const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
  const total = Number((await query(`SELECT COUNT(*) FROM audit_logs a ${clause}`, v)).rows[0].count);
  const rows = (
    await query(
      `SELECT a.id, a.action, a.entity_type, a.entity_id, a.created_at, a.ip, a.metadata, a.before, a.after,
              a.actor_id, u.first_name AS actor_first_name, u.last_name AS actor_last_name
       FROM audit_logs a LEFT JOIN users u ON u.id = a.actor_id
       ${clause} ORDER BY a.created_at DESC, a.id DESC LIMIT $${v.length + 1} OFFSET $${v.length + 2}`,
      [...v, limit, offset],
    )
  ).rows;
  return { rows, total };
}

module.exports = { log, search };
