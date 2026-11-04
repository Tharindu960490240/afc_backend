const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const svc = require("../services/agreementService");

const page = (res, r) =>
  res.json({ success: true, data: r.rows, pagination: { total: r.total, page: r.page, limit: r.limit } });

const send = asyncHandler(async (req, res) => {
  const data = await svc.send(req.user, req.body, clientInfo(req));
  res.status(201).json({ success: true, message: "Agreement sent.", data });
});

const list = asyncHandler(async (req, res) => page(res, await svc.list(req.user, req.query)));

const get = asyncHandler(async (req, res) => {
  res.json({ success: true, data: await svc.get(req.user, req.params.id) });
});

const sign = asyncHandler(async (req, res) => {
  const data = await svc.sign(req.user, req.params.id, req.body, clientInfo(req));
  res.json({ success: true, message: "Agreement signed.", data });
});

const reject = asyncHandler(async (req, res) => {
  const data = await svc.reject(req.user, req.params.id, req.body.reason, clientInfo(req));
  res.json({ success: true, message: "Agreement rejected.", data });
});

const approve = asyncHandler(async (req, res) => {
  const data = await svc.approve(req.user, req.params.id, req.body, clientInfo(req));
  res.json({ success: true, message: "Agreement countersigned.", data });
});

const cancel = asyncHandler(async (req, res) => {
  const data = await svc.cancel(req.user, req.params.id, req.body.reason, clientInfo(req));
  res.json({ success: true, message: "Agreement cancelled.", data });
});

const sendFile = (res, f) => {
  res.setHeader("Content-Type", f.mime);
  res.setHeader("Content-Length", f.size);
  res.setHeader("Content-Disposition", `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`);
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Cache-Control", "private, no-store");
  if (f.buffer) return res.end(f.buffer);
  f.stream.on("error", () => res.destroy());
  return f.stream.pipe(res);
};

const download = asyncHandler(async (req, res) =>
  sendFile(res, await svc.openFile(req.user, req.params.id, req.params.fileId, clientInfo(req))));

const pdf = asyncHandler(async (req, res) =>
  sendFile(res, await svc.openPdf(req.user, req.params.id, clientInfo(req))));

const agents = asyncHandler(async (req, res) => page(res, await svc.agentsOverview(req.query)));

const agentDetail = asyncHandler(async (req, res) =>
  res.json({ success: true, data: await require("../services/agentService").getDetail(req.params.id) }));

module.exports = { agentDetail, send, list, get, sign, reject, approve, cancel, download, pdf, agents };
