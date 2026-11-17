// College details used in emails, PDFs and the certificate. The values below are the defaults; an administrator can
// change them in Settings (stored in the database), and those take priority.
const defaults = {
  name: "Australian Federation College",
  website: "https://www.afcollege.edu.au",
  websiteLabel: "www.afcollege.edu.au",
  phone: "+61 3 6393 3225",
  email: "info@afcollege.edu.au",
  cricos: "03854G",
  abn: "49635394857",
  rto: "45616",
  campuses: [
    "Level 1, 126 Charles St, Launceston TAS 7250",
    "Level 5, 250 Collins St, Melbourne VIC 3000",
  ],
};
const signerDefaults = {
  name: process.env.CERT_SIGNER_NAME || "Sohel RANA",
  position: process.env.CERT_SIGNER_POSITION || "Strategy & Growth Director",
};

// read through to the settings cache each time, so a change takes effect without a restart
module.exports = new Proxy(defaults, {
  get(target, prop) {
    const o = require("../services/settingsService").collegeValues();
    if (prop === "signer") return { name: o.signer_name || signerDefaults.name, position: o.signer_position || signerDefaults.position };
    if (prop === "campuses") return Array.isArray(o.campuses) && o.campuses.length ? o.campuses : target.campuses;
    if (typeof prop === "string" && o[prop]) return o[prop];
    return target[prop];
  },
});
