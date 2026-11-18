const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const svc = require("../services/onlineInductionService");
const comsAgents = require("../services/comsAgentService");

const ok = (res, data) => res.json({ success: true, data });
const send = (res, f) => {
  res.set({ "Content-Type": f.mime, "Content-Length": f.size, "Content-Disposition": `attachment; filename="${encodeURIComponent(f.name)}"`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  f.stream.pipe(res);
};

// ---- the agent's own portal ----
const mine = asyncHandler(async (req, res) => ok(res, await svc.mine(req.user)));
const completeModule = asyncHandler(async (req, res) => ok(res, await svc.completeModule(req.user, req.params.id, clientInfo(req))));
const acknowledge = asyncHandler(async (req, res) => ok(res, await svc.acknowledgePolicy(req.user, req.body, clientInfo(req))));
const myMaterials = asyncHandler(async (req, res) => ok(res, await svc.materialsForAgent(req.user)));
const myMaterialDownload = asyncHandler(async (req, res) => send(res, await svc.openMaterialForAgent(req.user, req.params.id, clientInfo(req))));

// ---- staff ----
const modules = asyncHandler(async (req, res) => ok(res, await svc.listModules(req.user)));
const updateModule = asyncHandler(async (req, res) => ok(res, await svc.updateModule(req.user, req.params.id, req.body, clientInfo(req))));
const policies = asyncHandler(async (req, res) => ok(res, await svc.listPolicies()));
const publishPolicy = asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await svc.publishPolicy(req.user, req.body, clientInfo(req)) }));
const materials = asyncHandler(async (req, res) => ok(res, await svc.listMaterials()));
const createMaterial = asyncHandler(async (req, res) => res.status(201).json({ success: true, data: await svc.createMaterial(req.user, req.body, clientInfo(req)) }));
const approveMaterial = asyncHandler(async (req, res) => ok(res, await svc.approveMaterial(req.user, req.params.id, clientInfo(req))));
const retireMaterial = asyncHandler(async (req, res) => ok(res, await svc.retireMaterial(req.user, req.params.id, clientInfo(req))));
const materialDownload = asyncHandler(async (req, res) => send(res, await svc.openMaterial(req.user, req.params.id, clientInfo(req))));
const status = asyncHandler(async (req, res) => {
  await comsAgents.getDetail(req.user, req.params.id); // read permission and 404
  ok(res, await svc.statusFor(req.params.id));
});

module.exports = { mine, completeModule, acknowledge, myMaterials, myMaterialDownload, modules, updateModule, policies, publishPolicy, materials, createMaterial, approveMaterial, retireMaterial, materialDownload, status };
