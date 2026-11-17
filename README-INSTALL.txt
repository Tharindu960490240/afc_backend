BACKEND: copy these files over your backend folder (do not delete anything), then:
  npm install && npm run migrate     (applies 008, 009 and 010)
  set CRON_SECRET in your environment
  npm run reset:data / npm run seed:demo   (optional clean start and demo data)
  npm test                           (109 tests)
New: Settings (reference questions, documents, deadlines, onboarding tasks, college and certificate details) stored in the database.
