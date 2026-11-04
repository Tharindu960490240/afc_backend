const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const svc = require("../services/comsAgentService");

const ok = (res, data, extra = {}) => res.json({ success: true, data, ...extra });

const list = asyncHandler(async (req, res) => {
  const r = await svc.list(req.user, req.query);
  ok(res, r.rows, { pagination: { total: r.total, page: r.page, limit: r.limit } });
});
const meta = asyncHandler(async (req, res) => ok(res, await svc.meta(req.user)));
const detail = asyncHandler(async (req, res) => ok(res, await svc.getDetail(req.user, req.params.id)));

const create = asyncHandler(async (req, res) => {
  const { agent, linkSent } = await svc.createFromEoi(req.user, req.body, clientInfo(req));
  res.status(201).json({
    success: true,
    message: linkSent ? "Agent added and the application link was emailed." : "Agent added.",
    data: agent,
    linkSent,
  });
});
const sendLink = asyncHandler(async (req, res) => {
  await svc.sendApplicationLink(req.user, req.params.id, clientInfo(req));
  res.json({ success: true, message: "Application link sent." });
});
const update = asyncHandler(async (req, res) => ok(res, await svc.update(req.user, req.params.id, req.body, clientInfo(req))));
const status = asyncHandler(async (req, res) => ok(res, await svc.changeStatus(req.user, req.params.id, req.body, clientInfo(req))));
const remove = asyncHandler(async (req, res) => {
  await svc.remove(req.user, req.params.id, req.body.reason, clientInfo(req));
  res.json({ success: true, message: "Agent deleted. An administrator can restore it." });
});
const restore = asyncHandler(async (req, res) => ok(res, await svc.restore(req.user, req.params.id, clientInfo(req))));
const milestone = asyncHandler(async (req, res) => ok(res, await svc.recordMilestone(req.user, req.params.id, req.body, clientInfo(req))));

const addPerson = asyncHandler(async (req, res) => {
  const r = await svc.addPerson(req.user, req.params.id, req.body, clientInfo(req));
  res.status(201).json({ success: true, data: r.persons });
});
const updatePerson = asyncHandler(async (req, res) =>
  ok(res, await svc.updatePerson(req.user, req.params.id, req.params.personId, req.body, clientInfo(req))));
const removePerson = asyncHandler(async (req, res) =>
  ok(res, await svc.removePerson(req.user, req.params.id, req.params.personId, req.body.reason, clientInfo(req))));

const exportCsv = asyncHandler(async (req, res) => {
  const csv = await svc.exportCsv(req.user, req.query, clientInfo(req));
  res.set({
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="agent-register-${new Date().toISOString().slice(0, 10)}.csv"`,
    "Cache-Control": "no-store",
  });
  res.send(String.fromCharCode(0xfeff) + csv); // byte-order mark so Excel reads UTF-8
});

module.exports = { list, meta, detail, create, sendLink, update, status, remove, restore, milestone, addPerson, updatePerson, removePerson, exportCsv };
