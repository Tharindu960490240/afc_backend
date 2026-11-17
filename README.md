# AFC Portal API

Node.js + Express + PostgreSQL backend for the Australian Federation College portal.
Roles: `admin`, `agent`, `teacher`, `student`. Accounts are created **only by invitation**.

## First-time setup

```bash
npm install
cp .env.example .env          # then edit .env (never commit it)
createdb afc_portal           # a NEW database, not the old marketplace one
npm run migrate               # creates the tables
npm run seed:admin            # creates the first admin from ADMIN_* in .env
npm run dev                   # http://localhost:3200
```

After seeding, delete `ADMIN_PASSWORD` from `.env` and change the password after first sign-in.
Generate the JWT secret with:
`node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"`

With `EMAIL_MODE=console` (default) emails are printed in the terminal, so you can copy invitation and reset links without any mail server.
Switch to `EMAIL_MODE=smtp` and fill the SMTP_* values to send real mail (required in production).

## Folder structure

```
migrations/    ordered SQL files (001_init.sql ...), applied once by npm run migrate
scripts/       migrate.js, seed-admin.js
src/
  config/        env.js (validated settings), db.js (pool + transactions)
  routes/        URL -> controller wiring, middleware order
  controllers/   thin: read request, call service, shape response
  services/      business rules (login, reset, invitations, users, email, agreements, PDF, file storage)
  repositories/  all SQL lives here (parameterised queries only)
  middlewares/   authenticate, requireRole, validate, rateLimit, errorHandler
  validators/    zod schemas for every request body/query
  emails/        branded HTML email shell
  jobs/          nightly cleanup, agreement reminders and expiry notices
  utils/         password, jwt, tokens, errors
tests/         integration tests (npm test, needs a migrated test database)
```

Add each new feature (applications, offers) as its own migration + repository + service + controller + route file.

## API

| Method | Path | Who | Notes |
|---|---|---|---|
| POST | /api/auth/login | public | `{email,password}` -> `{success,data:{token,user}}` |
| POST | /api/auth/forgot-password | public | always the same answer |
| POST | /api/auth/reset-password/validate | public | `{token}` -> `{data:{email}}` |
| POST | /api/auth/reset-password | public | `{token,password}` |
| GET / PUT | /api/auth/me | signed in | `{success,user}` |
| PUT | /api/auth/me/password | signed in | returns a new token |
| GET | /api/invitations/:token | public | what the sign-up page shows |
| POST | /api/invitations/:token/accept | public | creates the account |
| POST | /api/auth/register-agent | public | agent registers from the college website; always answers the same (no email enumeration); emails a confirm link |
| POST | /api/auth/verify-agent | public | `{token}` confirms the email, moves the registration to `pending_approval` |
| GET | /api/registrations, /counts | admin | website registrations by status (`pending_approval`, `unverified`, `rejected`) |
| POST | /api/registrations/:id/approve, /reject | admin | approving activates the account and emails the agent |
| POST | /api/invitations | admin, agent | agents may invite students only |
| GET | /api/invitations | admin, agent | agents see their own |
| POST | /api/invitations/:id/resend | admin, agent | voids the old link |
| DELETE | /api/invitations/:id | admin, agent | revoke |
| GET | /api/users | admin | filters: role, status, search, page |
| PATCH | /api/users/:id/status | admin | `active` / `suspended` |
| GET | /api/agents | admin | one row per agent with agreement status |
| POST | /api/agreements | admin | `{agent_id,title?,note?,validity_months?}` builds the agreement from the template |
| GET | /api/agreements, /api/agreements/:id | admin, agent | agents see only their own |
| POST | /api/agreements/:id/sign | agent | `{signed_name,signature_image?,accept:true}` |
| POST | /api/agreements/:id/approve | admin | countersign: `{signed_name,position?,signature_image?,accept:true,effective_date?,validity_months?}`; creates the final PDF |
| POST | /api/agreements/:id/reject, /cancel | admin | reason required for reject |
| GET | /api/agreements/:id/pdf | admin, agent | current state as a PDF (the stored final file once signed) |
| GET | /api/agreements/:id/files/:fileId/download | admin, agent | final signed PDF |
| GET / PUT | /api/agreement-template | admin | the wording; each save is a new version |
| POST | /api/agreement-template/preview | admin | preview with example details |

## Agents registering from the website

The college website links to `<portal>/register/agent`. Flow: form -> email with a one-time link (24 h) -> agent confirms -> admin approves on **Registrations** -> agent can sign in -> admin sends the agreement.
Until approved, the account is `unverified` / `pending_approval` / `rejected` and cannot sign in. A second submission for a pending email only re-sends the link and never changes the stored password. Unconfirmed registrations are deleted after 7 days. Invitations still work for agents and every other role.

## Agreements

Admin sends -> the portal fills the template for the agent -> agent signs in the portal -> admin countersigns -> the final PDF is stored and both can download it. Nothing travels by email except reminders.
Finished PDFs are stored under `UPLOAD_DIR` (default `storage/`) with random names and are only served through the authenticated API. Keep that folder outside any public web folder and back it up.

## Security design

- Passwords: bcrypt (cost 12), policy enforced on the server, max 72 chars.
- Invitation and reset tokens: 256-bit random, only the SHA-256 is stored, single use, expire (7 days / 60 minutes), a new one voids the old one.
- The role and email of a new account come from the invitation row, never from the browser; extra fields are rejected.
- Access token (JWT HS256, issuer/audience checked) is re-checked against the database each request. Changing the password or suspending a user bumps `token_version` and kills every older token. Reset tokens are random strings, not JWTs, so they cannot be used to call the API.
- Login: same error for unknown email and wrong password, equal timing, lockout after 5 failures for 15 minutes, rate limits per IP.
- Forgot password never reveals whether an email exists.
- Responses never include password hashes, token hashes or lockout data.
- helmet, strict CORS allow-list, 100 kb body limit, parameterised SQL, central error handler (no stack traces to clients).
- `audit_logs` records logins, failures, invitations, resets, status changes.
- The server refuses to start without a 32+ character JWT secret, and requires real SMTP in production.

## Production checklist

- `NODE_ENV=production`, `EMAIL_MODE=smtp`, HTTPS in front (nginx / load balancer) and `TRUST_PROXY=1`.
- `DB_SSL=true` with `DB_SSL_REJECT_UNAUTHORIZED=true` for a managed database.
- Use a database user that owns only the AFC database.
- Back up the database (the old pg_dump-to-S3 job can be re-added as `src/jobs/backup.js` with new AWS keys).

## COMS Block 1, Part 1: staff roles, agent register, calendar, audit

- New staff roles: `ceo`, `director`, `marketing_officer`, `admissions`, `coe_admin`, `accounts`, `compliance` (admin invites them from Invitations). `admin` can do everything.
- CSV exports (NF-13, each one is written to the audit log): `/api/coms/agents/export`, `/api/users/export` (admin), `/api/agreements/export` (admin), `/api/coms/holidays/export`, `/api/coms/audit/export` (admin, compliance, CEO). They apply the same filters as the on-screen list.
- Approving a website registration (`POST /api/registrations/:id/approve`) is refused with 409 while a PRISMS field, a declaration or a referee is still missing; the message lists what is missing.
- Agent register: `/api/coms/agents` (list, create from expression of interest, edit, status, people, milestones, soft delete/restore, CSV export). Existing agent accounts are back-filled by migration `005`.
- Working-day calendar: `public_holidays` table (Tasmania and Victoria, seeded for 2026-2027), editable by admin at `/api/coms/holidays`. Add Launceston local days and the 2027 AFL Grand Final Friday when announced.
- Audit log now keeps before/after values; rows cannot be edited, and cannot be deleted for 7 years. For a developer database only: `SET afc.allow_audit_purge = on;` allows deletes.
- Run `npm run migrate` after updating.

### Agent application form (completes COMS Part 1)

- Public page `/register/agent` is now a six-step application: account, business (PRISMS fields), people, two referees, declarations, review. `POST /api/auth/register-agent` takes the whole application; nothing is saved if any part is invalid.
- Agents invited by the college complete the same form after sign-in at `/agent/application` (`GET` and `POST /api/agent-application`, once only).
- Migration `006` adds the declarations to `agents` and the `agent_referees` table. Referee checks are built in Part 2.
- Email can also be sent over HTTPS for hosts that block SMTP (for example Vercel): set `EMAIL_MODE=brevo`, `BREVO_API_KEY` and `EMAIL_FROM`.
- `api/index.js` and `vercel.json` let the same code run on Vercel (see `.env.example`).

## COMS Block 1, Part 2: due diligence, approval, agreement, onboarding tasks

**Run `npm run migrate`** (adds migration 007).

New environment variables
- `EVIDENCE_MAX_MB` – largest evidence upload in MB (default 3). Allowed: PDF, JPG, PNG, DOCX, XLSX, EML, MSG (type checked by content, not just name).
- `CRON_SECRET` – secret for the daily job. Vercel sends it as `Authorization: Bearer <secret>` to `GET /api/jobs/daily`. `vercel.json` schedules it at 21:10 UTC (about 08:10 Tasmania). On a normal server the same job runs through node-cron.

What it does
- **Referee checks (E1-4/E1-5):** staff add referees on the agent record, then either email the online form (single-use link, 21 days) or record a phone check using the same 7 questions. Reminders issue a fresh link. A negative or unanswered reference is flagged; staff confirm the outcome.
- **Due-diligence checklist (E1-6):** referees, ABN, MARN, PRISMS data, conflict-of-interest and code-of-ethics declaration (with file).
- **Decision (E1-7, BR-06/BR-08/BR-09):** Director, CEO or admin approve or reject with a reason (rejection email can be edited first). Whoever prepared the checks cannot decide the same file. A 10-working-day timer shows amber from day 7 and red from day 10, with one email at each point.
- **Agreement:** an approved agent gets the agreement from the agent record. When the agent signs and the CEO countersigns, the agent moves to **Onboarding**, a certificate PDF is stored with the agreement and four tasks are created.
- **Task engine (E5):** regulatory tasks (PRISMS add, ASQAnet notice, website listing) need a note or evidence file to close; general tasks can be added by managers. Tasks can be assigned, cancelled, filtered, exported to CSV (logged in the audit trail), and are reminded and escalated by the daily job.
- **Active:** the agent becomes Active once the agreement, PRISMS entry and induction are all recorded.
- Approving through the old Registrations screen now delegates to the same due-diligence decision.

Assumptions to confirm with the client
- PRISMS and website listing tasks are due in 5 working days; induction in 30 calendar days; the ASQAnet notice 30 calendar days from the agreement start (shown as the legal deadline; alert at day 20, escalation at day 25).
- Reference emails are sent from the system address and name the college officer.
- Virus scanning and Microsoft 365 storage for evidence are a later step; files are stored privately on the server.

## Part 2b: the AFC application form V2.0 and the "Processing Agent Application" procedure

**Run `npm run migrate`** (adds migration 008). Then `npm run seed:demo` loads sample agents (remove with `npm run seed:demo -- --remove`).

Application form (AFC-EAAF V2.0). The website and portal form now asks every section of the college's PDF: company profile (GST, CEO/owner, staff, years, services, offshore offices, sub-contractors, offshore partners), registrations, recruiting experience (Australian and other sectors), ESOS Act / National Code familiarity, personal experience, markets, memberships, services to the college, referees (company, contact, position, phone, email), privacy notice and the CEO/owner declaration. The long lists are stored in `agents.application_extra` (JSON), the searchable answers in their own columns. Staff can download the completed form as a PDF (`GET /api/coms/agents/:id/application.pdf`).
Conflict of interest is kept as an extra declaration required by the COMS handover.

Procedure steps
1. **Agent folder:** documents (business registration, organisational profile, MARA certificate, other) are filed on the agent record, reviewed one by one (accepted / needs update) and downloaded with a filing name `<Agency> - <Document> - <date>.<ext>`. Staff can email the agent "more information needed" (the email lists documents needing an update). Approval is blocked until the business registration certificate and organisational profile are accepted (for applications made on the form). Website applicants cannot sign in before approval, so they email their documents and staff add them; invited agents can upload in the portal.
2. **SMS contact:** recorded on the agent record (`POST /coms/agents/:id/milestones` with `type: sms_contact`). Shown as a warning on the due-diligence checklist until recorded; it does not block approval.
3. **Referee verification:** unchanged from Part 2 (at least one positive).
4. **Agreement** and 5. **signing:** unchanged (the certificate of appointment is generated on countersign).
6. **Reporting:** on countersign, five tasks are created: PRISMS (CoE Administrator), ASQAnet (CoE Administrator), website listing (Administration), record and report commission and bonus (Marketing), induction. PRISMS, ASQAnet and website are due in 5 working days. The 30-day legal deadline for ASQAnet is kept as a backstop (alert at day 20, escalation at day 25). Every user in the responsible role is emailed. Saving the commission and bonus on the agent record (`POST /coms/agents/:id/terms`) emails AFC Accounts and finishes the commission task.

Assumptions to confirm: "AFC Administration" is the `admin` role; "COE Administrator" is `coe_admin`; the 5 days are working days; accepted documents may not be removed by the agent.

## Certificate of Appointment (final onboarding step)

Run `npm run migrate` (migration 009). The certificate follows the college's design (logo, Anton font, signature of the Strategy & Growth Director). It is drawn from the agent's current signed agreement each time, so every download or email uses the current design.
- When onboarding finishes and the agent becomes **Active**, the certificate is emailed to the agent's main contact as a PDF attachment.
- Staff: **Agreements** tab on the agent record (when Active) has **Download (PDF)** and **Email it to the agent** (`GET /api/coms/agents/:id/certificate`, `POST /api/coms/agents/:id/certificate/send`).
- Agent: **My agreement** page shows a **Download certificate** button once Active (`GET /api/agent-application/certificate`, `.../certificate/download`).
- Signatory shown on the certificate: set `CERT_SIGNER_NAME` and `CERT_SIGNER_POSITION` (defaults: Sohel RANA, Strategy & Growth Director). The signature image is `src/emails/assets/signature-sohel-rana.png`. Replace it if the signatory changes.

## Clean start and demo data

- `npm run reset:data` removes everything except administrator logins, the public-holiday calendar and the agreement template. It shows the database name and asks you to type it before deleting. It removes all other users, agents, agreements, tasks, invitations and the audit log (files in `uploads/` are not touched). There is no undo: take a database backup first.
- `npm run seed:demo` then adds sample data for every screen built so far: 7 staff logins (one per role), 9 agents at every stage (prospect to active, rejected), application answers, documents, referees, due diligence, agreements (one sent, two countersigned), a certificate, tasks, history and audit entries. All demo logins use `Passw0rd@1` (change with `DEMO_PASSWORD`). Remove again with `npm run seed:demo -- --remove`.
