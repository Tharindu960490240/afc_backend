BACKEND: copy these files over your backend folder (do not delete anything), then:
  npm install && npm run migrate     (applies 008)
  set CRON_SECRET in your environment
  optional: npm run seed:demo        (remove: npm run seed:demo -- --remove)
  npm test                           (102 tests)
