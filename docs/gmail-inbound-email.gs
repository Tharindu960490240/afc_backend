/**
 * Sends agent emails from a Gmail mailbox to the AFC portal so they appear in each agent's communication log.
 * No extra cost. Works with a normal Gmail account or a Google Workspace mailbox.
 *
 * SETUP (about 10 minutes)
 * 1. Pick ONE mailbox for this, e.g. agents@afcollege.edu.au. Staff add it as BCC (or forward to it) when they email agents.
 *    Agents' replies reach it when staff keep it in CC. Only this mailbox is read; nobody's personal mail is touched.
 * 2. In that mailbox, create the label  AFC/agents  and a filter that applies it to everything you want logged
 *    (for example: every message that arrives in this mailbox).
 * 3. Open script.google.com while signed in as that mailbox > New project > paste this file.
 * 4. Project Settings > Script properties, add:
 *      PORTAL_URL   = https://YOUR-BACKEND-HOST          (no trailing slash)
 *      INBOUND_SECRET = the same value as INBOUND_EMAIL_SECRET on the backend
 * 5. Run  installTrigger  once (it asks for permission), and it then checks for new mail every 5 minutes.
 *
 * The portal matches the sender (or the recipient, for mail staff send) to an agent's email address.
 * Mail from anyone else is ignored and only noted in the audit log. Repeats are safe: each message is stored once.
 */
var LABEL_IN = "AFC/agents";
var LABEL_DONE = "AFC/logged";

function installTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) { ScriptApp.deleteTrigger(t); });
  ScriptApp.newTrigger("sendNewMail").timeBased().everyMinutes(5).create();
}

function sendNewMail() {
  var props = PropertiesService.getScriptProperties();
  var url = props.getProperty("PORTAL_URL") + "/api/inbound/email";
  var secret = props.getProperty("INBOUND_SECRET");
  var inLabel = GmailApp.getUserLabelByName(LABEL_IN);
  if (!inLabel) throw new Error("Create the Gmail label " + LABEL_IN + " first.");
  var doneLabel = GmailApp.getUserLabelByName(LABEL_DONE) || GmailApp.createLabel(LABEL_DONE);

  inLabel.getThreads(0, 50).forEach(function (thread) {
    var allSent = true;
    thread.getMessages().forEach(function (m) {
      var res = UrlFetchApp.fetch(url, {
        method: "post",
        contentType: "application/json",
        headers: { "x-inbound-secret": secret },
        muteHttpExceptions: true,
        payload: JSON.stringify({
          from: m.getFrom(),
          to: m.getTo() + (m.getCc() ? "," + m.getCc() : ""),
          subject: m.getSubject(),
          text: m.getPlainBody(),
          date: m.getDate().toISOString(),
          message_id: m.getHeader("Message-ID") || m.getId(),
        }),
      });
      if (res.getResponseCode() >= 300) allSent = false;
    });
    if (allSent) { thread.removeLabel(inLabel); thread.addLabel(doneLabel); }
  });
}
