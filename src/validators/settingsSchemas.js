const { z } = require("zod");

const text = (min, max, msg) => z.string().trim().min(min, msg).max(max);

const questionItem = z.object({
  key: z.string().trim().max(60).optional(),            // present for existing questions (never changes)
  label: text(5, 400, "Write the question (at least 5 characters)"),
  type: z.enum(["text", "yesno"]),
  required: z.boolean(),
  favourable: z.boolean().nullable().optional(),        // the answer that counts as a good reference
  ask_details: z.boolean().optional(),                  // ask for details when the answer is not the favourable one
  active: z.boolean(),
}).strict();
const saveQuestions = z.object({ items: z.array(questionItem).min(1).max(40) }).strict();

const docTypeItem = z.object({
  key: z.string().trim().max(60).optional(),
  label: text(3, 160, "Give the document a name"),
  file_name: text(2, 80, "Give a short name for the file"),
  required: z.boolean(),
  active: z.boolean(),
}).strict();
const saveDocTypes = z.object({ items: z.array(docTypeItem).min(1).max(30) }).strict();

const int = (min, max) => z.number().int().min(min).max(max);
const saveTimers = z.object({
  ack_days: int(1, 30), decision_days: int(1, 60), amber_after_days: int(1, 60),
  referee_link_days: int(1, 90), referee_reminder_days: int(1, 30), referee_max_reminders: int(0, 10),
}).strict();

const optional = (max) => z.string().trim().max(max).optional();
const saveCollege = z.object({
  name: optional(120), abn: optional(20), rto: optional(20), cricos: optional(20),
  phone: optional(40), email: optional(160), website: optional(200), websiteLabel: optional(120),
  campuses: z.array(z.string().trim().min(3).max(200)).max(6).optional(),
  signer_name: optional(100), signer_position: optional(120),
}).strict();
const saveSignature = z.object({ signature_image: z.string().min(100).max(300000) }).strict();

const taskItem = z.object({
  type: z.string().trim().max(30),
  title: text(5, 200, "Write the task name"),
  owner_role: z.string().trim().max(30),
  due_days: int(1, 120),
  due_basis: z.enum(["business", "calendar"]),
  legal_days: int(1, 365).nullable().optional(),
  prefer_account_manager: z.boolean(),
  enabled: z.boolean(),
}).strict();
const saveTasks = z.object({ items: z.array(taskItem).min(1).max(10) }).strict();

module.exports = { saveQuestions, saveDocTypes, saveTimers, saveCollege, saveSignature, saveTasks };
