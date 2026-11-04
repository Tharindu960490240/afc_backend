const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const calendar = require("../services/calendarService");
const audit = require("../repositories/auditRepo");

const holidays = asyncHandler(async (req, res) => {
  const r = await calendar.list();
  res.json({ success: true, data: r.rows, coveredYears: r.coveredYears, jurisdictions: r.jurisdictions });
});
const addHoliday = asyncHandler(async (req, res) => {
  res.status(201).json({ success: true, data: await calendar.add(req.user, req.body, clientInfo(req)) });
});
const removeHoliday = asyncHandler(async (req, res) => {
  await calendar.remove(req.user, req.params.id, clientInfo(req));
  res.json({ success: true, message: "Holiday removed." });
});

const auditList = asyncHandler(async (req, res) => {
  const q = req.query;
  const r = await audit.search({
    entityType: q.entity_type, entityId: q.entity_id, actorId: q.actor_id, action: q.action, from: q.from, to: q.to,
    limit: q.limit, offset: (q.page - 1) * q.limit,
  });
  res.json({ success: true, data: r.rows, pagination: { total: r.total, page: q.page, limit: q.limit } });
});

module.exports = { holidays, addHoliday, removeHoliday, auditList };
