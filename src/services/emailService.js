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

async function send({ to, subject, html, text, files }) {
  if (env.email.mode === "brevo") {
    // HTTPS API: works on hosts such as Vercel where outgoing SMTP is blocked. The logo must come from LOGO_URL.
    const res = await fetch("https://api.brevo.com/v3/smtp/email", {
      method: "POST",
      headers: { "api-key": env.email.brevoKey, "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        sender: { name: env.email.fromName, email: env.email.from },
        to: [{ email: to }],
        subject,
        htmlContent: html,
        textContent: text,
        ...(files?.length ? { attachment: files.map((f) => ({ name: f.filename, content: f.content.toString("base64") })) } : {}),
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) throw new Error(`Brevo ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return;
  }
  if (env.email.mode !== "smtp") {
    // Local development: show the message instead of sending it.
    outbox.push({ to, subject, text, html, attachments: (files || []).map((f) => ({ filename: f.filename, size: f.content.length })) });
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
    attachments: [...logoAttachments(), ...(files || []).map((f) => ({ filename: f.filename, content: f.content, contentType: "application/pdf" }))],
  });
}

// Fire-and-forget wrapper: email problems are logged, never shown to the caller.
// Pending sends are tracked so a serverless host (Vercel) can wait for them before it freezes the function.
const pending = new Set();
const sendSafely = (message) => {
  const p = send(message).catch((err) => console.error(`Email to ${message.to} failed:`, err.message));
  pending.add(p);
  p.finally(() => pending.delete(p));
  return p;
};
const flushEmails = () => Promise.allSettled([...pending]);

// Every email is: subject + compose({...}) from the shared layout.
const deliver = (to, subject, content, files) => sendSafely({ to, subject, files, ...compose(content) });

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

function sendAgreementApproved({ to, firstName, title, expiresAt, files }) {
  return deliver(to, "Your agreement is approved", {
    preheader: `Valid until ${dateText(expiresAt)}.`,
    title: "Agreement approved",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `**${title}** has been approved and countersigned by the college. It is valid until **${dateText(expiresAt)}**.`,
      files?.length
        ? "The fully signed agreement and your Certificate of Appointment are attached to this email as PDFs. You can also download them from the portal at any time."
        : "The fully signed copy is available to download in the portal.",
      "**What happens next:** the college now registers you (PRISMS, ASQAnet and the college website) and your account manager will contact you for your induction.",
    ],
    action: { text: "Open my agreement", url: agentLink() },
    notice: { tone: "success", title: "You are all set", text: "We will remind you before the agreement expires." },
  }, files);
}

// the countersigning staff member keeps a copy of the fully signed agreement
function sendSignedCopyToStaff({ to, firstName, agentName, title, files }) {
  return deliver(to, `Signed agreement: ${agentName}`, {
    preheader: `${title} is signed by both parties.`,
    title: "Fully signed agreement",
    greeting: `Hello ${firstName},`,
    paragraphs: [`**${title}** for **${agentName}** is now signed by both parties. The signed copy is attached for your records.`],
  }, files);
}

// the certificate of appointment, attached as a PDF once the agent's onboarding is finished
function sendCertificate({ to, firstName, agencyName, filename, buffer }) {
  return deliver(to, "Your Certificate of Appointment", {
    preheader: `${agencyName} is an authorised representative of ${require("../emails/college").name}.`,
    title: "Your Certificate of Appointment",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `Welcome to ${require("../emails/college").name}. **${agencyName}** is appointed as an authorised representative of the college.`,
      "Your Certificate of Appointment is attached to this email as a PDF. You can also download it at any time from your agent portal.",
    ],
    action: { text: "Open my portal", url: `${env.frontendUrl}/agent/agreement` },
    notice: { tone: "success", title: "You are all set", text: "Please keep the certificate for your records." },
  }, [{ filename, content: buffer }]);
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

// Marketing staff are told about every new application, with a short summary
function sendNewApplicationToStaff({ to, firstName, agentName, agencyName, country, link }) {
  return deliver(to, `New agent application: ${agencyName || agentName}`, {
    preheader: `${agentName} has applied to become an agent.`,
    title: "New agent application",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `**${agencyName || agentName}**${country ? ` (${country})` : ""} has submitted an agent application. Contact: ${agentName}.`,
      "The acknowledgement has gone to the applicant. A decision is due within 10 working days.",
    ],
    action: { text: "Open the application", url: link },
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
      "**Next steps:** 1) sign in and check your details; 2) read and sign the agent agreement when it arrives; 3) the college countersigns it and sends you your Certificate of Appointment.",
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

// ---------- Part 2: due diligence and tasks ----------
// E1-4: the referee gets a link to the online reference form
function sendReferenceRequest({ to, refereeName, agentName, officerName, link, reminder = false }) {
  return deliver(to, reminder ? `Reminder: reference for ${agentName}` : `Reference request for ${agentName}`, {
    preheader: `${agentName} has named you as a referee.`,
    title: reminder ? "Reference still needed" : "Reference request",
    greeting: `Hello ${refereeName},`,
    paragraphs: [
      `**${agentName}** has applied to become an education agent for Australian Federation College and named you as a referee.`,
      `${officerName || "The college"} would be grateful if you could answer a few short questions about your experience with them. It takes about five minutes. Your answers are used only to assess the application.`,
    ],
    action: { text: "Open the reference form", url: link },
  });
}

function sendReferenceReceived({ to, firstName, agentName, refereeName, outcome, link }) {
  return deliver(to, `Reference received for ${agentName}`, {
    preheader: `${refereeName} answered the reference form.`,
    title: "Reference received",
    greeting: `Hello ${firstName},`,
    paragraphs: [`**${refereeName}** has answered the reference form for **${agentName}**. The answers look **${outcome}**.`],
    action: { text: "Open the agent record", url: link },
  });
}

// the director's or CEO's own wording (the rejection draft can be edited before it is sent)
function sendAgentDecision({ to, firstName, subject, body }) {
  return deliver(to, subject, {
    preheader: subject,
    title: subject,
    greeting: `Hello ${firstName},`,
    paragraphs: String(body).split(/\n{2,}/).map((p) => p.trim()).filter(Boolean),
  });
}

// BR-08: the decision is due within 10 working days
function sendDecisionTimer({ to, firstName, agentName, level, daysLeft, link }) {
  const red = level === "red";
  return deliver(to, red ? `Decision overdue: ${agentName}` : `Decision due soon: ${agentName}`, {
    preheader: red ? "The 10 working-day decision time is up." : "Day 7 of 10 working days.",
    title: red ? "Agent decision overdue" : "Agent decision due soon",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      red
        ? `The application from **${agentName}** has passed the 10 working-day decision time. Please decide as soon as possible.`
        : `The application from **${agentName}** is at day 7 of 10 working days. ${daysLeft} working day${daysLeft === 1 ? "" : "s"} left to decide.`,
    ],
    action: { text: "Open the application", url: link },
  });
}

// E5-1: reminders and escalation
function sendTaskAlert({ to, firstName, title, agentName, dueDate, level, link }) {
  const heading = level === "escalated" ? "Task escalated" : level === "overdue" ? "Task overdue" : "Task due soon";
  return deliver(to, `${heading}: ${title}`, {
    preheader: `${title}${agentName ? ` (${agentName})` : ""}`,
    title: heading,
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `**${title}**${agentName ? ` for **${agentName}**` : ""} is ${level === "overdue" || level === "escalated" ? "overdue" : "still open"} (due ${dueDate}).`,
      level === "escalated" ? "It has been escalated to you because it is still open." : level === "due_soon" ? "It has not been finished yet and is due soon. It has been escalated to you so it is not missed." : "Please complete it and add the evidence on the task board.",
    ],
    action: { text: "Open the task board", url: link },
  });
}

function sendTaskAssigned({ to, firstName, title, agentName, dueDate, link }) {
  return deliver(to, `New task: ${title}`, {
    preheader: `Due ${dueDate}`,
    title: "A task was assigned to you",
    greeting: `Hello ${firstName},`,
    paragraphs: [`**${title}**${agentName ? ` for **${agentName}**` : ""}, due **${dueDate}**.`],
    action: { text: "Open the task board", url: link },
  });
}

// Phase 3: online induction
function sendAgentWelcome({ to, firstName, agencyName, link }) {
  return deliver(to, `Welcome to ${require("../emails/college").name}`, {
    preheader: "Your agreement is signed. Next, complete your induction.",
    title: "Welcome, your agreement is signed",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `Welcome to ${require("../emails/college").name}. The agreement with **${agencyName}** is now fully signed.`,
      "Your next step is the online induction in the agent portal: six short modules, then you acknowledge our policies and procedures. You sign in with the email address and password you registered with.",
      "Once the college confirms your induction, the rest of the portal opens, including the marketing materials.",
    ],
    action: { text: "Start my induction", url: link },
  });
}
function sendOnlineInductionComplete({ to, firstName, agentName, link }) {
  return deliver(to, `Induction modules finished: ${agentName}`, {
    preheader: `${agentName} finished the induction modules.`,
    title: "An agent finished the induction modules",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `**${agentName}** has completed all the online induction modules.`,
      "Please check the record and confirm the induction once they have also acknowledged the policies. The agent's portal stays limited until you do.",
    ],
    action: { text: "Open the agent record", url: link },
  });
}
function sendMaterialUpdate({ to, firstName, title, version, category, link }) {
  return deliver(to, `New marketing material: ${title}`, {
    preheader: `${category} ${version} is now available.`,
    title: "New marketing material",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `AFC has approved a new ${category.toLowerCase()}: **${title}** (version ${version}).`,
      "Please use this version from now on. You can download it from the agent portal.",
    ],
    action: { text: "Open the agent portal", url: link },
  });
}

// Phase 3: induction
const inductionWhen = ({ date, time }) => `**${date}**${time ? ` at **${time}**` : ""}`;
const inductionHow = ({ mode, meetingUrl, location }) =>
  meetingUrl ? `Join online: ${meetingUrl}` : location ? (mode === "by phone" ? `We will call you on: ${location}` : `Where: ${location}`) : null;
function sendInductionScheduled({ to, firstName, date, time, mode, meetingUrl, location, conductor, portalLink, reminder }) {
  const how = inductionHow({ mode, meetingUrl, location });
  return deliver(to, reminder ? "Reminder: your induction with Australian Federation College" : "Your induction with Australian Federation College", {
    preheader: `Your induction is on ${date}${time ? ` at ${time}` : ""}.`,
    title: reminder ? "Your induction is coming up" : "Your induction is booked",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `Your induction with Australian Federation College is ${reminder ? "coming up on" : "booked for"} ${inductionWhen({ date, time })} (${mode}). It will be run by **${conductor}**.`,
      ...(how ? [how] : []),
      "It covers how we work with agents, our compliance expectations and how to submit student applications. You can see these details any time after you sign in to the agent portal. Please reply to this email if the time does not suit you.",
    ],
    ...(portalLink ? { action: { text: "Open my induction", url: portalLink } } : {}),
  });
}
function sendInductionReminder({ to, firstName, agentName, date, time, mode, meetingUrl, location, level, link }) {
  const heading = level === "record_outcome" ? "Record the induction outcome" : level === "scheduled" ? "Induction scheduled" : "Induction coming up";
  const how = inductionHow({ mode, meetingUrl, location });
  return deliver(to, `${heading}: ${agentName}`, {
    preheader: `${agentName} on ${date}`,
    title: heading,
    greeting: `Hello ${firstName},`,
    paragraphs: [
      level === "record_outcome"
        ? `The induction for **${agentName}** was scheduled for **${date}**. Please record that it was held (date, who ran it and notes), mark that the agent did not attend, or change the date. The agent cannot become Active until it is recorded.`
        : `You are running the induction for **${agentName}** on ${inductionWhen({ date, time })} (${mode}).`,
      ...(how && level !== "record_outcome" ? [how] : []),
    ],
    action: { text: "Open the agent record", url: link },
  });
}

// Procedure step 1: ask the agent for updated information or documents
function sendInfoRequest({ to, firstName, agencyName, message, documents, link }) {
  return deliver(to, `Your application with Australian Federation College: more information needed`, {
    preheader: `We need a little more from you, ${agencyName}.`,
    title: "We need a little more information",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `Thank you for applying on behalf of **${agencyName}**. While reviewing your application we need the following:`,
      message,
      ...(documents && documents.length ? [`Documents to update: ${documents.join("; ")}.`] : []),
      "Please reply to this email or sign in to your portal to add the documents.",
    ],
    action: { text: "Open my application", url: link },
  });
}

// Procedure step 6: report commission and bonus to AFC Accounts
function sendTermsReport({ to, firstName, agencyName, country, commission, bonus, by, link }) {
  return deliver(to, `New agent commission and bonus: ${agencyName}`, {
    preheader: `${agencyName} (${country})`,
    title: "Agent commission and bonus",
    greeting: `Hello ${firstName},`,
    paragraphs: [
      `**${agencyName}** (${country}) has been appointed as an education agent. ${by} has recorded these terms:`,
      `**Commission:** ${commission}`,
      `**Bonus:** ${bonus || "None"}`,
    ],
    action: { text: "Open the agent record", url: link },
  });
}

module.exports = {
  sendInfoRequest, sendTermsReport,
  sendReferenceRequest, sendReferenceReceived, sendAgentDecision, sendDecisionTimer, sendTaskAlert, sendTaskAssigned, sendInductionScheduled, sendInductionReminder, sendAgentWelcome, sendOnlineInductionComplete, sendMaterialUpdate,
  sendAgentVerification, sendRegistrationExists, sendAgentPending, sendApplicationReceived, sendAgentRegistrationToAdmin, sendNewApplicationToStaff,
  sendAgentApproved, sendAgentRejected,
  outbox, flushEmails, sendInvitation, sendPasswordReset, sendPasswordChanged,
  sendAgreementSent, sendAgreementSubmitted, sendAgreementRejected, sendAgreementApproved,
  sendCertificate, sendSignedCopyToStaff, sendAgreementCancelled, sendAgreementReminder, sendReviewReminder, sendAgreementExpiry,
  sendAgreementExpiryToAdmin,
};
