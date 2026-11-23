const { query } = require("../config/db");

const COLS = `c.id, c.code, c.name, c.specialisation, c.course_type, c.cricos_code, c.duration_weeks, c.tuition_fee::float8 AS tuition_fee,
  c.entry_requirements, c.sort_order, c.active,
  COALESCE((SELECT array_agg(o.campus_id ORDER BY o.campus_id) FROM course_offerings o WHERE o.course_id = c.id), '{}') AS campus_ids`;

const campuses = async () => (await query(`SELECT id, name, active FROM campuses ORDER BY sort_order, id`)).rows;
const list = async ({ activeOnly }) =>
  (await query(`SELECT ${COLS} FROM courses c ${activeOnly ? "WHERE c.active" : ""} ORDER BY c.sort_order, c.id`)).rows;
const find = async (id, client) =>
  ((client || { query }).query(`SELECT ${COLS} FROM courses c WHERE c.id = $1`, [id])).then((r) => r.rows[0]);
const nextSort = async (client) => ((await client.query(`SELECT COALESCE(MAX(sort_order), 0) + 1 AS n FROM courses`)).rows[0].n);

const insert = async (client, v, sort) =>
  (await client.query(
    `INSERT INTO courses (code, name, specialisation, course_type, cricos_code, duration_weeks, tuition_fee, entry_requirements, sort_order, active)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
    [v.code ?? null, v.name, v.specialisation ?? null, v.course_type, v.cricos_code ?? null, v.duration_weeks ?? null, v.tuition_fee ?? null, v.entry_requirements ?? null, sort, v.active ?? true],
  )).rows[0].id;

const update = (client, id, v) =>
  client.query(
    `UPDATE courses SET code=$2, name=$3, specialisation=$4, course_type=$5, cricos_code=$6, duration_weeks=$7, tuition_fee=$8,
       entry_requirements=$9, active=$10, updated_at=now() WHERE id=$1`,
    [id, v.code ?? null, v.name, v.specialisation ?? null, v.course_type, v.cricos_code ?? null, v.duration_weeks ?? null, v.tuition_fee ?? null, v.entry_requirements ?? null, v.active],
  );

const setCampuses = async (client, id, campusIds) => {
  await client.query(`DELETE FROM course_offerings WHERE course_id = $1`, [id]);
  for (const cid of campusIds) await client.query(`INSERT INTO course_offerings (course_id, campus_id) VALUES ($1,$2)`, [id, cid]);
};

module.exports = { campuses, list, find, nextSort, insert, update, setCampuses };
