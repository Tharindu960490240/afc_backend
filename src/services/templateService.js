const AppError = require("../utils/AppError");
const { withTransaction } = require("../config/db");
const repo = require("../repositories/templateRepo");
const audit = require("../repositories/auditRepo");
const docs = require("./agreementDocument");

const withHelp = (t) => ({ ...t, placeholders: docs.PLACEHOLDERS });

async function getActive() {
  const t = await repo.active();
  if (!t) throw new AppError(500, "No agreement template is set up.");
  return withHelp(t);
}

async function save(actor, { name, body }, ctx) {
  docs.assertTemplate(body);
  await withTransaction(async (client) => {
    await repo.publish(client, { name, body, userId: actor.id });
    await audit.log({ actorId: actor.id, action: "agreement_template.updated", entityType: "agreement_template", ...ctx }, client);
  });
  return getActive();
}

// What the agreement would look like with example details.
function preview(body) {
  docs.assertTemplate(body);
  return { blocks: docs.parseBlocks(docs.sampleSnapshot(body).replace(/\{\{\s*effective_date\s*\}\}/g, "the date the College countersigns this Agreement").replace(/\{\{\s*expiry_date\s*\}\}/g, "the day 12 months after that date")) };
}

module.exports = { getActive, save, preview };
