const path = require("path");
const nodemailer = require("nodemailer");
const env = require("../config/env");
const { compose, LOGO_CID } = require("../emails/template");

// ---------- transport ----------
let transporter;
const getTransporter = () => {
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: env.email.host,
      port: env.email.port,
      secure: env.email.port === 465, // 587 uses STARTTLS automatically
      auth: { user: env.email.user, pass: env.email.pass },
    });
  }
  return transporter;
};

// Console mode keeps the last few messages in memory so automated tests can read links.
const outbox = [];

// The logo travels inside the email (inline attachment), so it shows even without a public URL.
const logoAttachments = () =>
  env.email.logoUrl
    ? []
    : [{ filename: "afc-logo.png", path: path.join(__dirname, "..", "emails", "assets", "afc-logo.png"), cid: LOGO_CID }];

async function send({ to, subject, html, text }) {
  if (env.email.mode !== "smtp") {
    // Local development: show the message instead of sending it.
    outbox.push({ to, subject, text, html });
    if (outbox.length > 50) outbox.shift();
    console.log(`\n--- EMAIL (console mode) ---\nTo: ${to}\nSubject: ${subject}\n${text}\n----------------------------\n`);
    return;
  }
  await getTransporter().sendMail({
    from: `"${env.email.fromName}" <${env.email.from}>`,
    to,
    subject,
    html,
    text,
    attachments: logoAttachments(),
  });
}

// Fire-and-forget wrapper: email problems are logged, never shown to the caller.
const sendSafely = (message) =>
  send(message).catch((err) => console.error(`Email to ${message.to} failed:`, err.message));

// Every email is: subject + compose({...}) from the shared layout.
const deliver = (to, subject, content) => sendSafely({ to, subject, ...compose(content) });

// ---------- messages ----------
const ROLE_TEXT = {
  admin: "an administrator",
  agent: "an education agent",
  teacher: "a teacher",
  student: "a student",
  ceo: "the CEO / Principal Executive Officer",
  director: "the Strategy & Growth Director",
  marketing_officer: "a Sales & Marketing Officer",
  admissions: "an Admissions officer",
  coe_admin: "an Administration Manager / CoE Administrator",
  accounts: "an Accounts officer",
  compliance: "a Compliance officer",
};

function sendPasswordReset({ to, firstName, link, ttlMinutes }) {
  return deliver(to, "Reset your AFC portal password", {
    preheader: `Use this link within ${ttlMinutes} minutes to choose a new password.`,
    title: "Reset your password",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      "We received a request to reset the password for your AFC portal account.",
      `Click the button below to choose a new password. For your security, the link can be used **once** and expires in **${ttlMinutes} minutes**.`,
    ],
    action: { text: "Choose a new password", url: link },
    notice: {
      tone: "warning",
      title: "Did not ask for this?",
      text: "You can safely ignore this email and your password will stay the same. If you keep receiving these, please contact the college.",
    },
  });
}

function sendPasswordChanged({ to, firstName }) {
  return deliver(to, "Your AFC portal password was changed", {
    preheader: "Your password was just changed.",
    title: "Password changed",
    greeting: `Hello ${firstName},`,
    paragraphs: ["The password for your AFC portal account was just changed, and you have been signed out on other devices."],
    notice: {
      tone: "danger",
      title: "Was this not you?",
      text: "Contact the college straight away so we can secure your account.",
    },
  });
}

function sendInvitation({ to, firstName, role, link, invitedByName, expiresAt }) {
  const when = expiresAt.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });
  return deliver(to, "Your invitation to Australian Federation College", {
    preheader: `${invitedByName} invited you to join the AFC portal.`,
    title: "You are invited",
    greeting: firstName ? `Hello ${firstName},` : "Hello,",
    paragraphs: [
      `**${invitedByName}** has invited you to join the Australian Federation College portal as ${ROLE_TEXT[role]}.`,
      `Use the button below to create your account. The link can be used **once** and expires on **${when}**.`,
    ],
    action: { text: "Create my account", url: link },
    notice: {
      tone: "info",
      title: "Not expecting this?",
      text: "If you do not know why you received this invitation, you can ignore this email.",
    },
  });
}

// ---------- agreements ----------
// The documents never travel by email. These messages only tell people to sign in.
const agentLink = () => `${env.frontendUrl}/agent/agreement`;
const adminLink = (id) => `${env.frontendUrl}/admin/agreements/${id}`;
const dateText = (d) =>
  new Date(d).toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" });

function sendAgreementSent({ to, firstName, title, note, validityMonths }) {
  return deliver(to, "An agreement is waiting for you in the AFC portal", {
    preheader: "Please sign in to read and sign your agreement.",
    title: "Agreement ready to sign",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `Australian Federation College has sent you **${title}** in the portal.`,
      "Please sign in, read the agreement and sign it on screen. For security the document is not attached to this email.",
      ...(note ? [`Message from the college: ${note}`] : []),
      `Once approved, the agreement is valid for **${validityMonths} months**.`,
    ],
    action: { text: "Open my agreement", url: agentLink() },
  });
}

function sendAgreementSubmitted({ to, firstName, agentName, agencyName, id }) {
  return deliver(to, `Agreement submitted by ${agentName}`, {
    preheader: `${agentName} signed an agreement and it is ready for you.`,
    title: "Agreement to review",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `**${agentName}**${agencyName ? ` (${agencyName})` : ""} has signed an agreement in the portal.`,
      "Please review it, then countersign it, or send it back with a reason.",
    ],
    action: { text: "Review agreement", url: adminLink(id) },
  });
}

function sendAgreementRejected({ to, firstName, title, reason }) {
  return deliver(to, "Your agreement needs changes", {
    preheader: "Please read and sign again.",
    title: "Changes needed",
    greeting: `Hello ${firstName},`,
    paragraphs: [`The college could not approve **${title}** yet. Please read it again and sign it again.`],
    action: { text: "Open my agreement", url: agentLink() },
    notice: { tone: "warning", title: "Reason", text: reason },
  });
}

function sendAgreementApproved({ to, firstName, title, expiresAt }) {
  return deliver(to, "Your agreement is approved", {
    preheader: `Valid until ${dateText(expiresAt)}.`,
    title: "Agreement approved",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `**${title}** has been approved and countersigned by the college. It is valid until **${dateText(expiresAt)}**.`,
      "You can now submit students. The fully signed copy is available to download in the portal.",
    ],
    action: { text: "Open my agreement", url: agentLink() },
    notice: { tone: "success", title: "You are all set", text: "We will remind you before the agreement expires." },
  });
}

function sendAgreementCancelled({ to, firstName, title, reason }) {
  return deliver(to, "Your agreement was withdrawn", {
    preheader: "The college has withdrawn this agreement.",
    title: "Agreement withdrawn",
    greeting: `Hello ${firstName},`,
    paragraphs: [`**${title}** has been withdrawn by the college.`, "If you have questions, please contact us."],
    ...(reason ? { notice: { tone: "info", title: "Note", text: reason } } : {}),
  });
}

function sendAgreementReminder({ to, firstName, title, rejected }) {
  return deliver(to, "Reminder: your agreement is waiting", {
    preheader: "Please sign in to finish your agreement.",
    title: "Agreement reminder",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      rejected
        ? `**${title}** needs to be signed again by you.`
        : `**${title}** is still waiting for your signature.`,
      "Please sign in, read it and sign it on screen.",
    ],
    action: { text: "Open my agreement", url: agentLink() },
  });
}

function sendReviewReminder({ to, firstName, agentName, id }) {
  return deliver(to, `Reminder: ${agentName}'s agreement needs review`, {
    preheader: "A signed agreement is waiting for you to countersign.",
    title: "Review reminder",
    greeting: `Hello ${firstName},`,
    paragraphs: [`The agreement signed by **${agentName}** is still waiting for review.`],
    action: { text: "Review agreement", url: adminLink(id) },
  });
}

function sendAgreementExpiry({ to, firstName, title, expiresAt, daysLeft }) {
  const expired = daysLeft < 0;
  return deliver(to, expired ? "Your agreement has expired" : `Your agreement expires in ${daysLeft} days`, {
    preheader: expired ? "Please contact the college to renew." : `Valid until ${dateText(expiresAt)}.`,
    title: expired ? "Agreement expired" : "Agreement expiring soon",
    greeting: `Hello ${firstName},`,
    paragraphs: expired
      ? [`**${title}** expired on **${dateText(expiresAt)}**. You cannot submit new students until a renewal is approved.`, "Please contact the college to renew your agreement."]
      : [`**${title}** expires on **${dateText(expiresAt)}** (${daysLeft} days).`, "Please contact the college to renew it so you can keep submitting students."],
    action: { text: "Open my agreement", url: agentLink() },
    notice: { tone: expired ? "danger" : "warning", title: expired ? "Renewal needed" : "Renew in time", text: "The college will send you a new agreement to sign." },
  });
}

function sendAgreementExpiryToAdmin({ to, firstName, agentName, expiresAt, daysLeft, id }) {
  const expired = daysLeft < 0;
  return deliver(to, expired ? `${agentName}'s agreement has expired` : `${agentName}'s agreement expires in ${daysLeft} days`, {
    preheader: `Expiry date: ${dateText(expiresAt)}.`,
    title: expired ? "Agreement expired" : "Agreement expiring soon",
    greeting: `Hello ${firstName},`,
    paragraphs: [`The agreement for **${agentName}** ${expired ? "expired" : "expires"} on **${dateText(expiresAt)}**.`, "You can send a renewal from the portal."],
    action: { text: "Open agreement", url: adminLink(id) },
  });
}

// ---------- agent registration from the website ----------
function sendAgentVerification({ to, firstName, link, ttlHours }) {
  return deliver(to, "Confirm your email to finish registering", {
    preheader: "One more step: confirm your email address.",
    title: "Confirm your email",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      "Thank you for registering as an education agent with Australian Federation College.",
      `Please confirm your email address with the button below. The link can be used **once** and works for **${ttlHours} hours**.`,
      "After that, the college will review your registration and email you the result.",
    ],
    action: { text: "Confirm my email", url: link },
    notice: { tone: "info", title: "Not you?", text: "If you did not register, you can ignore this email and nothing will happen." },
  });
}

function sendRegistrationExists({ to, firstName, signInUrl }) {
  return deliver(to, "You already have an AFC portal account", {
    preheader: "Someone tried to register with this email.",
    title: "You already have an account",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      "A registration form was just filled in with your email address, but you already have an account with us.",
      "You can sign in, or use Forgot password on the sign-in page if you cannot remember your password.",
    ],
    action: { text: "Go to sign in", url: signInUrl },
    notice: { tone: "info", title: "Was this not you?", text: "You can ignore this email. Your account is not changed." },
  });
}

function sendAgentPending({ to, firstName }) {
  return deliver(to, "We received your registration", {
    preheader: "The college will review it and email you.",
    title: "Registration received",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      "Your email is confirmed and your registration is now with the college.",
      "We will email you as soon as it is approved. You will then be able to sign in and sign your agent agreement.",
    ],
  });
}

// AG-03: acknowledgement of an application, with whatever is still missing
function sendApplicationReceived({ to, firstName, legalName, missing = [] }) {
  const paragraphs = [
    `We have received the application for **${legalName}**. A decision is made within 10 working days of receipt.`,
  ];
  if (missing.length) {
    paragraphs.push(`To keep the review moving, please send us: ${missing.join("; ")}.`);
  }
  return deliver(to, "We received your agent application", {
    preheader: "Your application is now with the college.",
    title: "Application received",
    greeting: `Hello ${firstName},`,
    paragraphs,
  });
}

function sendAgentRegistrationToAdmin({ to, firstName, agentName, agencyName, country, link }) {
  return deliver(to, `New agent registration: ${agentName}`, {
    preheader: `${agentName} registered from the website.`,
    title: "New agent to approve",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `**${agentName}**${agencyName ? ` (${agencyName}${country ? `, ${country}` : ""})` : ""} registered as an agent from the website and confirmed their email.`,
      "Please review the details and approve or reject the registration.",
    ],
    action: { text: "Review registrations", url: link },
  });
}

function sendAgentApproved({ to, firstName, signInUrl }) {
  return deliver(to, "Your agent registration is approved", {
    preheader: "You can now sign in to the AFC portal.",
    title: "You are approved",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      "Your registration as an education agent with Australian Federation College has been approved.",
      "You can sign in now. The college will send you the agent agreement to read and sign in the portal.",
    ],
    action: { text: "Sign in", url: signInUrl },
  });
}

function sendAgentRejected({ to, firstName, reason }) {
  return deliver(to, "About your agent registration", {
    preheader: "The college could not approve your registration.",
    title: "Registration not approved",
    greeting: `Hello ${firstName},`,
    paragraphs: ["Thank you for your interest. The college is not able to approve your registration at this time.", "If you think this is a mistake, please contact the college."],
    ...(reason ? { notice: { tone: "info", title: "Note from the college", text: reason } } : {}),
  });
}

module.exports = {
  sendAgentVerification, sendRegistrationExists, sendAgentPending, sendApplicationReceived, sendAgentRegistrationToAdmin,
  sendAgentApproved, sendAgentRejected,
  outbox, sendInvitation, sendPasswordReset, sendPasswordChanged,
  sendAgreementSent, sendAgreementSubmitted, sendAgreementRejected, sendAgreementApproved,
  sendAgreementCancelled, sendAgreementReminder, sendReviewReminder, sendAgreementExpiry,
  sendAgreementExpiryToAdmin,
};
