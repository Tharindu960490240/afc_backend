// Draft text for staff to review. These are fixed templates filled from what staff enter (no outside service is called),
// so nothing is sent until a person has read, edited and approved it.
const fmt = (d) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00Z`).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }) : "");
const bullets = (t) => String(t || "").split(/\n+/).map((x) => x.trim().replace(/^[-*•]\s*/, "")).filter(Boolean).map((x) => `- ${x}`).join("\n");

const BROADCAST_KIND = { product: "product", fee: "fee", policy: "policy", other: "" };

function draftBroadcast({ kind = "product", whatChanged = "", effectiveDate = null }) {
  const label = BROADCAST_KIND[kind] ? `${BROADCAST_KIND[kind]} update` : "update";
  const subject = `AFC ${label}${effectiveDate ? ` from ${fmt(effectiveDate)}` : ""}`;
  const body = [
    `We are writing to let you know about a ${label} at Australian Federation College.`,
    `What has changed:\n${bullets(whatChanged) || "- (add the details of the change here)"}`,
    effectiveDate ? `This applies from ${fmt(effectiveDate)}.` : null,
    "Please use only the current approved information and materials when you talk to students. You can download the latest materials from the agent portal.",
    "If you have any questions, reply to this email or contact your AFC account manager.",
  ].filter(Boolean).join("\n\n");
  return { subject, body };
}

function draftCorrectiveNotice({ agentName, issues, requiredActions, dueDate, periodEnd = null }) {
  const subject = "Corrective action required: Education Agent Agreement";
  const body = [
    `Dear ${agentName},`,
    `Under the monitoring clause of the Education Agent Agreement, Australian Federation College reviews the performance of its agents every six months.${periodEnd ? ` Our review for the period ending ${fmt(periodEnd)} identified the following:` : " Our review identified the following:"}`,
    bullets(issues) || "- (describe the specific issues here)",
    `To address these issues, please do the following by ${fmt(dueDate)}:`,
    bullets(requiredActions) || "- (describe the actions required here)",
    "Please confirm in writing when each action has been completed. We will check the outcome. Failing to carry out a corrective action is grounds for termination of the agreement.",
    "If you believe anything above is wrong, or you need to discuss it, please contact us straight away.",
    "Kind regards,\nAustralian Federation College",
  ].join("\n\n");
  return { subject, body };
}

module.exports = { draftBroadcast, draftCorrectiveNotice, fmt };
