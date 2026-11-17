BACKEND: copy these files over your backend folder (do not delete anything), then:
  npm install && npm run migrate     (applies 008 and 009)
  set CRON_SECRET in your environment
  optional: CERT_SIGNER_NAME / CERT_SIGNER_POSITION
  optional: npm run seed:demo        (remove: npm run seed:demo -- --remove)
  npm test                           (103 tests)
New this drop: Certificate of Appointment in the college design, emailed when the agent becomes Active.
Includes src/assets/fonts (Anton, OFL licence) and src/emails/assets (logo, signature).
