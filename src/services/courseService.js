// Course catalogue. Everyone signed in can read the active courses (agents and students choose from them);
// only administrators change it. Courses are switched off, never deleted.
const { withTransaction } = require("../config/db");
const AppError = require("../utils/AppError");
const audit = require("../repositories/auditRepo");
const repo = require("../repositories/courseRepo");
const { ROLES } = require("../const");

const fieldError = (field, message) => new AppError(400, "Please check the highlighted fields.", { errors: { [field]: message } });
const isUnique = (e) => e && e.code === "23505";

async function list(user) {
  const staffView = user.role === ROLES.ADMIN;
  const [campuses, courses] = await Promise.all([repo.campuses(), repo.list({ activeOnly: !staffView })]);
  return { campuses: campuses.filter((c) => c.active || staffView), courses };
}

async function checkCampuses(ids) {
  const known = new Set((await repo.campuses()).map((c) => Number(c.id)));
  for (const id of ids) if (!known.has(Number(id))) throw fieldError("campus_ids", "Unknown campus");
}

async function create(actor, body, ctx) {
  await checkCampuses(body.campus_ids);
  try {
    return await withTransaction(async (client) => {
      const id = await repo.insert(client, body, await repo.nextSort(client));
      await repo.setCampuses(client, id, body.campus_ids);
      const after = await repo.find(id, client);
      await audit.log({ actorId: actor.id, action: "course.created", entityType: "course", entityId: String(id), after, ...ctx }, client);
      return after;
    });
  } catch (e) {
    if (isUnique(e)) throw fieldError("code", "A course with this code (and specialisation) is already listed");
    throw e;
  }
}

async function update(actor, id, body, ctx) {
  const before = await repo.find(id);
  if (!before) throw new AppError(404, "Course not found.");
  await checkCampuses(body.campus_ids);
  try {
    return await withTransaction(async (client) => {
      await repo.update(client, id, body);
      await repo.setCampuses(client, id, body.campus_ids);
      const after = await repo.find(id, client);
      await audit.log({ actorId: actor.id, action: before.active !== after.active ? (after.active ? "course.activated" : "course.deactivated") : "course.updated", entityType: "course", entityId: String(id), before, after, ...ctx }, client);
      return after;
    });
  } catch (e) {
    if (isUnique(e)) throw fieldError("code", "A course with this code (and specialisation) is already listed");
    throw e;
  }
}

module.exports = { list, create, update };
