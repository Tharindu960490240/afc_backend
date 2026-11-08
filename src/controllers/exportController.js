const asyncHandler = require("../utils/asyncHandler");
const { clientInfo } = require("../utils/request");
const { sendCsv } = require("../utils/csv");
const svc = require("../services/exportService");

const users = asyncHandler(async (req, res) => sendCsv(res, "users", await svc.users(req.user, req.query, clientInfo(req))));
const agreements = asyncHandler(async (req, res) => sendCsv(res, "agreements", await svc.agreements(req.user, req.query, clientInfo(req))));
const holidays = asyncHandler(async (req, res) => sendCsv(res, "public-holidays", await svc.holidays(req.user, clientInfo(req))));
const auditLog = asyncHandler(async (req, res) => sendCsv(res, "audit-log", await svc.auditLog(req.user, req.query, clientInfo(req))));

module.exports = { users, agreements, holidays, auditLog };
