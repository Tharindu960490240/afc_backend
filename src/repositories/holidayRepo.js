const { query } = require("../config/db");

const all = async () =>
  (await query(`SELECT id, holiday_date, name, jurisdiction FROM public_holidays ORDER BY holiday_date, jurisdiction`)).rows;

const add = async ({ date, name, jurisdiction }) =>
  (
    await query(
      `INSERT INTO public_holidays (holiday_date, name, jurisdiction) VALUES ($1,$2,$3)
       RETURNING id, holiday_date, name, jurisdiction`,
      [date, name, jurisdiction],
    )
  ).rows[0];

const findById = async (id) => (await query(`SELECT * FROM public_holidays WHERE id=$1`, [id])).rows[0];
const remove = (id) => query(`DELETE FROM public_holidays WHERE id=$1`, [id]);

module.exports = { all, add, findById, remove };
