const AppError = require("../utils/AppError");
const agentRepo = require("../repositories/agentRepo");
const agreementRepo = require("../repositories/agreementRepo");

async function getDetail(id) {
  const agent = await agentRepo.findDetail(id);
  if (!agent) throw new AppError(404, "Agent not found.");

  const [invitation, activity, students, agreements] = await Promise.all([
    agentRepo.findInvitation(id),
    agentRepo.recentActivity(id),
    agentRepo.studentCount(id),
    agreementRepo.list({ agentId: id, limit: 50, offset: 0 }),
  ]);

  return {
    ...agent,
    invitation: invitation || null,
    students,
    agreements: agreements.rows,
    activity,
  };
}

module.exports = { getDetail };
