// Vercel entry point: every /api/* request is handled by the Express app.
// Scheduled jobs (src/jobs) are not started here, because serverless functions do not stay running.
//
// Serverless functions are frozen as soon as the response ends, which would cancel emails that are still
// being sent. So the response is held back until any email started by this request has finished.
const app = require("../src/app");
const { flushEmails } = require("../src/services/emailService");

module.exports = (req, res) => {
  const end = res.end.bind(res);
  res.end = (...args) => {
    flushEmails().then(() => end(...args));
    return res;
  };
  app(req, res);
};
