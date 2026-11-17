BACKEND: copy these files over your backend folder (do not delete anything), then:
  npm install && npm run migrate     (applies 008 and 009)
  set CRON_SECRET in your environment
  npm run reset:data                 (keeps only admin login, holidays, agreement template; asks you to type the DB name)
  npm run seed:demo                  (demo staff + agents covering every part; password Passw0rd@1)
  npm test                           (103 tests)
