// ===============================================================
// Reusable AFC email layout.
//
//   const { html, text } = compose({
//     preheader: "Short preview shown in the inbox list",
//     title: "Reset your password",
//     greeting: "Hello Sam,",
//     paragraphs: ["Plain text. Use **double stars** for bold."],
//     action: { text: "Choose a new password", url: "https://..." },
//     notice: { tone: "warning", title: "Did not ask for this?", text: "..." },
//     outro: "Optional closing line.",
//   });
//
// All text is escaped here, so user data is safe to pass in.
// The layout uses tables and inline styles so it renders in Gmail,
// Outlook and mobile mail apps.
// ===============================================================
const env = require("../config/env");
const college = require("./college");

const NAVY = "#282c7d";
const RED = "#ed1f24";
const FONT = "Segoe UI, Helvetica, Arial, sans-serif";

const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

// escape, then turn **x** into bold
const rich = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '<strong style="color:#111827">$1</strong>');
const plain = (s) => String(s ?? "").replace(/\*\*(.+?)\*\*/g, "$1");

const NOTICE_TONES = {
  info: { bg: "#eef0fb", border: NAVY, title: NAVY },
  warning: { bg: "#fff6e5", border: "#d97706", title: "#92400e" },
  danger: { bg: "#fdeced", border: RED, title: "#b91c1c" },
  success: { bg: "#e9f7ef", border: "#16a34a", title: "#166534" },
};

// "cid:" image is attached by emailService (works with no public URL).
// If you host the logo publicly, set LOGO_URL and it is used instead.
const LOGO_CID = "afc-logo";
const logoSrc = () => env.email.logoUrl || `cid:${LOGO_CID}`;

function button({ text, url }) {
  return `
  <table role="presentation" cellspacing="0" cellpadding="0" border="0" align="center" style="margin:28px auto 8px">
    <tr><td align="center" bgcolor="${NAVY}" style="border-radius:8px">
      <a href="${esc(url)}" target="_blank"
         style="display:inline-block;padding:14px 34px;font-family:${FONT};font-size:15px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;border-bottom:3px solid ${RED}">
        ${esc(text)}
      </a>
    </td></tr>
  </table>
  <p style="margin:18px 0 4px;font-family:${FONT};font-size:12px;line-height:1.5;color:#6b7280;text-align:center">
    Button not working? Copy and paste this link into your browser:
  </p>
  <p style="margin:0;font-family:${FONT};font-size:12px;line-height:1.5;color:${NAVY};text-align:center;word-break:break-all">
    <a href="${esc(url)}" style="color:${NAVY}">${esc(url)}</a>
  </p>`;
}

function notice({ tone = "info", title, text }) {
  const t = NOTICE_TONES[tone] || NOTICE_TONES.info;
  return `
  <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="margin:26px 0 0">
    <tr><td style="background:${t.bg};border-left:4px solid ${t.border};border-radius:6px;padding:14px 16px;font-family:${FONT};font-size:13px;line-height:1.55;color:#374151">
      ${title ? `<div style="font-weight:700;color:${t.title};margin-bottom:3px">${esc(title)}</div>` : ""}
      ${rich(text)}
    </td></tr>
  </table>`;
}

function compose({ preheader = "", title, greeting, paragraphs = [], action, notice: note, outro }) {
  const support = env.email.support || college.email;

  const body = [
    greeting ? `<p style="margin:0 0 14px;font-family:${FONT};font-size:16px;line-height:1.6;color:#111827">${rich(greeting)}</p>` : "",
    ...paragraphs.map((p) => `<p style="margin:0 0 14px;font-family:${FONT};font-size:15px;line-height:1.65;color:#374151">${rich(p)}</p>`),
    action ? button(action) : "",
    note ? notice(note) : "",
    outro ? `<p style="margin:26px 0 0;font-family:${FONT};font-size:15px;line-height:1.65;color:#374151">${rich(outro)}</p>` : "",
  ].join("");

  const html = `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light"><title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f3f9">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${esc(preheader)}${"&nbsp;&zwnj;".repeat(40)}</div>
<table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0" style="background:#f1f3f9">
<tr><td align="center" style="padding:28px 12px">
  <table role="presentation" width="600" cellspacing="0" cellpadding="0" border="0" style="width:100%;max-width:600px">
    <tr><td style="background:#ffffff;border-radius:14px;overflow:hidden;box-shadow:0 4px 18px rgba(15,18,56,.08)">
      <table role="presentation" width="100%" cellspacing="0" cellpadding="0" border="0">
        <tr><td height="6" style="height:6px;line-height:6px;font-size:0;background:${NAVY};border-bottom:0">&nbsp;</td></tr>
        <tr><td align="center" style="padding:30px 30px 6px">
          <img src="${esc(logoSrc())}" width="190" alt="${esc(college.name)}" style="display:block;width:190px;max-width:100%;height:auto;border:0">
        </td></tr>
        <tr><td align="center" style="padding:14px 30px 0">
          <h1 style="margin:0;font-family:${FONT};font-size:24px;line-height:1.3;color:${NAVY};font-weight:800">${esc(title)}</h1>
          <table role="presentation" cellspacing="0" cellpadding="0" border="0" style="margin:14px auto 0"><tr><td width="44" height="3" style="width:44px;height:3px;line-height:3px;font-size:0;background:${RED};border-radius:2px">&nbsp;</td></tr></table>
        </td></tr>
        <tr><td style="padding:26px 36px 34px">${body}</td></tr>
      </table>
    </td></tr>
    <tr><td align="center" style="padding:22px 20px 6px;font-family:${FONT};font-size:12px;line-height:1.7;color:#6b7280">
      <strong style="color:#374151">${esc(college.name)}</strong><br>
      ${college.campuses.map(esc).join("<br>")}<br>
      <a href="tel:${esc(college.phone.replace(/\s/g, ""))}" style="color:#6b7280;text-decoration:none">${esc(college.phone)}</a>
      &nbsp;|&nbsp;
      <a href="mailto:${esc(support)}" style="color:${NAVY}">${esc(support)}</a><br>
      <a href="${esc(college.website)}" style="color:${NAVY}">${esc(college.websiteLabel)}</a><br>
      CRICOS ${esc(college.cricos)} &nbsp;&middot;&nbsp; RTO ${esc(college.rto)}
    </td></tr>
    <tr><td align="center" style="padding:10px 24px 0;font-family:${FONT};font-size:11px;line-height:1.6;color:#9ca3af">
      This is an automated message from the AFC portal. Please do not reply to this email.<br>
      &copy; ${new Date().getFullYear()} ${esc(college.name)}. All rights reserved.
    </td></tr>
  </table>
</td></tr></table></body></html>`;

  const text = [
    title.toUpperCase(),
    "",
    greeting ? plain(greeting) : null,
    greeting ? "" : null,
    ...paragraphs.flatMap((p) => [plain(p), ""]),
    action ? `${action.text}:\n${action.url}\n` : null,
    note ? `${note.title ? note.title + ": " : ""}${plain(note.text)}\n` : null,
    outro ? plain(outro) + "\n" : null,
    "--",
    `${college.name} | ${college.phone} | ${support}`,
    "This is an automated message. Please do not reply.",
  ].filter((l) => l !== null).join("\n");

  return { html, text };
}

module.exports = { compose, LOGO_CID, esc };
