// Online induction (Phase 3): modules, completions, policy versions, acknowledgements and marketing materials.
const { query } = require("../config/db");
const q = (client) => client || { query };

// ---------- modules ----------
const modules = async (client) =>
  (await q(client).query(`SELECT id, position, key, title, body, version, active, updated_at FROM induction_modules WHERE active ORDER BY position`)).rows;
const moduleById = async (id, client) =>
  (await q(client).query(`SELECT id, position, key, title, body, version, active FROM induction_modules WHERE id = $1`, [id])).rows[0];
const updateModule = (client, id, { title, body, actorId }) =>
  client.query(`UPDATE induction_modules SET title = $2, body = $3, version = version + 1, updated_by = $4, updated_at = now() WHERE id = $1 RETURNING version`, [id, title, body, actorId]);

// ---------- completions ----------
const completions = async (agentId, client) =>
  (await q(client).query(
    `SELECT c.id, c.module_id, c.module_version, c.completed_at, c.ip FROM induction_completions c WHERE c.agent_id = $1 ORDER BY c.completed_at`, [agentId])).rows;
const insertCompletion = (client, d) =>
  client.query(
    `INSERT INTO induction_completions (agent_id, module_id, module_version, user_id, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6)`,
    [d.agentId, d.moduleId, d.version, d.userId || null, d.ip || null, d.userAgent || null]);

// ---------- policies and procedures ----------
const currentPp = async (client) => (await q(client).query(`SELECT id, version, title, body, document_url, created_at FROM pp_versions WHERE is_current`)).rows[0];
const ppVersions = async () =>
  (await query(`SELECT id, version, title, body, document_url, is_current, created_at FROM pp_versions ORDER BY created_at DESC`)).rows;
const insertPp = async (client, d) => {
  await client.query(`UPDATE pp_versions SET is_current = false WHERE is_current`);
  return (await client.query(
    `INSERT INTO pp_versions (version, title, body, document_url, is_current, created_by) VALUES ($1,$2,$3,$4,true,$5) RETURNING id`,
    [d.version, d.title, d.body, d.documentUrl || null, d.actorId || null])).rows[0].id;
};
const acknowledgements = async (agentId, client) =>
  (await q(client).query(
    `SELECT a.id, a.pp_version_id, a.pp_version, a.acknowledged_at, a.ip FROM pp_acknowledgements a WHERE a.agent_id = $1 ORDER BY a.acknowledged_at DESC`, [agentId])).rows;
const insertAck = (client, d) =>
  client.query(
    `INSERT INTO pp_acknowledgements (agent_id, user_id, pp_version_id, pp_version, ip, user_agent) VALUES ($1,$2,$3,$4,$5,$6)`,
    [d.agentId, d.userId || null, d.ppId, d.version, d.ip || null, d.userAgent || null]);

// ---------- marketing materials ----------
const MAT = `m.id, m.title, m.description, m.category, m.version, m.status, m.created_at, m.approved_at, m.retired_at,
  f.original_name AS file_name, f.size_bytes AS file_size, f.storage_key, f.mime_type,
  trim(coalesce(u.first_name,'') || ' ' || coalesce(u.last_name,'')) AS uploaded_by_name,
  trim(coalesce(a.first_name,'') || ' ' || coalesce(a.last_name,'')) AS approved_by_name,
  (SELECT count(*) FROM marketing_material_deliveries d WHERE d.material_id = m.id)::int AS notified`;
const MAT_FROM = `FROM marketing_materials m JOIN coms_files f ON f.id = m.file_id LEFT JOIN users u ON u.id = m.uploaded_by LEFT JOIN users a ON a.id = m.approved_by`;
const materials = async ({ status } = {}) =>
  (await query(`SELECT ${MAT} ${MAT_FROM} ${status ? "WHERE m.status = $1" : ""} ORDER BY m.created_at DESC`, status ? [status] : [])).rows;
const material = async (id, client) => (await q(client).query(`SELECT ${MAT} ${MAT_FROM} WHERE m.id = $1`, [id])).rows[0];
const insertMaterial = async (client, d) =>
  (await client.query(
    `INSERT INTO marketing_materials (title, description, category, version, file_id, uploaded_by) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [d.title, d.description || null, d.category, d.version, d.fileId, d.actorId || null])).rows[0].id;
const setMaterialStatus = (client, id, status, actorId) =>
  client.query(
    `UPDATE marketing_materials SET status = $2::varchar, updated_at = now(),
       approved_by = CASE WHEN $2::text = 'approved' THEN $3::bigint ELSE approved_by END, approved_at = CASE WHEN $2::text = 'approved' THEN now() ELSE approved_at END,
       retired_at = CASE WHEN $2::text = 'retired' THEN now() ELSE retired_at END WHERE id = $1`, [id, status, actorId || null]);
const noticeRecipients = async () =>
  (await query(
    `SELECT a.id, a.legal_name, coalesce((SELECT p.email FROM agent_persons p WHERE p.agent_id = a.id AND p.deleted_at IS NULL AND p.email IS NOT NULL
                                          ORDER BY p.is_primary_contact DESC, p.created_at LIMIT 1), a.email) AS email,
            coalesce((SELECT split_part(p.name, ' ', 1) FROM agent_persons p WHERE p.agent_id = a.id AND p.deleted_at IS NULL ORDER BY p.is_primary_contact DESC, p.created_at LIMIT 1), a.legal_name) AS first_name
     FROM agents a WHERE a.status = 'active' AND a.deleted_at IS NULL`)).rows;
// approved in the last 3 days, and an agent who was already on the register at approval has no delivery row yet (the notice never went out)
const undelivered = async () =>
  (await query(
    `SELECT m.id AS material_id, m.title, m.version, m.category, m.approved_at, a.id AS agent_id,
            coalesce((SELECT p.email FROM agent_persons p WHERE p.agent_id = a.id AND p.deleted_at IS NULL AND p.email IS NOT NULL
                       ORDER BY p.is_primary_contact DESC, p.created_at LIMIT 1), a.email) AS email,
            coalesce((SELECT split_part(p.name, ' ', 1) FROM agent_persons p WHERE p.agent_id = a.id AND p.deleted_at IS NULL ORDER BY p.is_primary_contact DESC, p.created_at LIMIT 1), a.legal_name) AS first_name
       FROM marketing_materials m
       JOIN agents a ON a.status = 'active' AND a.deleted_at IS NULL AND a.created_at < m.approved_at
      WHERE m.status = 'approved' AND m.approved_at > now() - interval '3 days' AND m.approved_at < now() - interval '1 hour'
        AND NOT EXISTS (SELECT 1 FROM marketing_material_deliveries d WHERE d.material_id = m.id AND d.agent_id = a.id)`)).rows;
const insertDelivery = (client, d) =>
  q(client).query(`INSERT INTO marketing_material_deliveries (material_id, agent_id, sent_to) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [d.materialId, d.agentId, d.to]);

module.exports = {
  modules, moduleById, updateModule, completions, insertCompletion,
  currentPp, ppVersions, insertPp, acknowledgements, insertAck,
  materials, material, insertMaterial, setMaterialStatus, noticeRecipients, insertDelivery, undelivered,
};
