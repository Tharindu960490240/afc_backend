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
The demo data covers everything up to Phase 3: agents at every stage, a month-11 renewal task (Sunrise), induction sessions, online induction progress (complete, waiting for staff, half way), and three marketing materials (two approved, one draft).

- `npm run reset:data` removes everything except administrator logins, the public-holiday calendar and the agreement template. It shows the database name and asks you to type it before deleting. It removes all other users, agents, agreements, tasks, invitations and the audit log (files in `uploads/` are not touched). There is no undo: take a database backup first.
- `npm run seed:demo` then adds sample data for every screen built so far: 7 staff logins (one per role), 9 agents at every stage (prospect to active, rejected), application answers, documents, referees, due diligence, agreements (one sent, two countersigned), a certificate, tasks, history and audit entries. All demo logins use `Passw0rd@1` (change with `DEMO_PASSWORD`). Remove again with `npm run seed:demo -- --remove`.

## Settings (administrators)

Run `npm run migrate` (migration 010). **Settings** in the admin menu (`/admin/settings`, `/api/settings`, administrators only) lets the college change, without a code change:
- **Reference questions:** add, reword, reorder, switch off; mark the "good answer" and whether to ask for details. Each completed check keeps the questions it was answered against, so later edits never rewrite history. Questions cannot be deleted.
- **Documents:** names, short file names, which must be accepted before approval, new types.
- **Deadlines:** acknowledge days (3), decision days (10), amber from day (7), referee link validity (21), reminder frequency and count.
- **Onboarding tasks:** name, owner role, due days (working or calendar), legal backstop, enabled (PRISMS and Induction must stay on, because an agent cannot become Active without them).
- **College and certificate:** name, ABN, RTO, CRICOS, contact details, campuses, certificate signatory and signature image. These replace the standard values in emails, PDFs and the certificate; empty fields keep the standard value.
Changes are saved in the database, recorded in the audit log (before/after), and take effect within seconds. The built-in values remain the defaults. Note: `TRUNCATE users CASCADE` also empties these tables (tests restore them); `npm run reset:data` keeps them.

## Phase 1 and 2 update (AFC Agent Management Developer Requirements)

Run `npm run migrate` (adds 011, 012, 013).

- **Referees**: one positive reference is enough; the "two recommended" warning is gone.
- **Agreement**: pre-fills trading name, address, representative name and position, phone and the agreement date. The sample wording carries Schedule 1 (35% VET, 30% ELICOS), a 1-year term and no sub-contracting. Migration 011 only rewrites the wording if it is still the unedited version 1.
- **Signing**: reminder after 5 unsigned days (then every 5, up to 5). At counter-sign the agent gets one email with the signed agreement and the Certificate of Appointment; the countersigning staff member gets a copy. The certificate can be downloaded from counter-sign. Nothing extra is sent when the agent becomes Active.
- **Registration tasks (5 working days)**: PRISMS to compliance, ASQAnet to the CEO, website to administration (with the listing details in the task). Escalated to a manager on working day 4 (Settings > Deadlines). After the deadline only a manager can close them. The old 30-day ASQAnet backstop is removed.
- **Commission**: staff record the VET/ELICOS percentages (defaults 35/30). The system drafts the email to Accounts; staff check it and send. Sending completes the task. Endpoints: `POST /coms/agents/:id/terms`, `GET .../terms/draft`, `POST .../terms/send`.
- **Authorised staff**: `PATCH /users/:id/authorised` (CEO or administrator); toggle on the Users screen.
- **Termination**: login is blocked at once, sessions end, and PRISMS_REMOVE (compliance), ASQANET_END (CEO) and WEBSITE_REMOVE (admin) tasks are created. A terminated agent's access cannot be switched back on. Records are only ever soft-deleted.
- **Removed screens**: Registrations, the old Agents list and detail page, and the "Soon" Leads and Renewals menu items.

## Phase 3 update: agent induction
- Migration `014_induction.sql` adds `agent_inductions` (date, who ran it, how, attendees, notes, scheduled/held/cancelled) and backfills inductions already recorded.
- Endpoints (staff): `GET/POST /api/coms/agents/:id/inductions`, `POST .../:inductionId/complete|reschedule|cancel`. Recording needs admin, marketing officer or director.
- A held induction sets the BR-02 milestone, finishes the INDUCTION task and activates the agent when the agreement and PRISMS are also recorded. Finishing the INDUCTION task on the task board writes the same record.
- The old `milestones` endpoint no longer accepts `induction`.
- Daily job: reminder to the person running a booked induction the day before, a follow-up if the outcome is not recorded, and reminders on the INDUCTION task (7 days before it is due, and once when overdue, also to directors). The 5-working-day escalation now applies to registration tasks only, not the 30-day induction task.

### Induction booking details (migration 015)
- A booking now needs a start time, plus a meeting link (online), or a place (in person), or the number to call (phone). Only http(s) links are accepted.
- The agent is emailed the details when it is booked or changed, and again the day before. `GET /api/agent-application/induction` (agents only) returns the agent's own booking with the join link and past sessions, never internal notes.
- `POST /api/coms/agents/:id/inductions/:inductionId/missed` records that the agent did not attend (not held, a new booking can be made).

### Correcting an induction (migration 016)
- `PATCH /api/coms/agents/:id/inductions/:inductionId` edits a held induction (date, who ran it, how, attendees, notes). Admin, marketing officer or director. Audited with before and after; the "induction recorded" date follows the latest held record.
- `POST .../:inductionId/undo` (director or administrator, reason required) marks a held induction as undone. If it was the only one, the milestone is cleared and the finished induction task opens again. An agent who is already Active is not demoted: the response carries a warning.

### Online induction, policies and materials (migration 017)
Follows the client requirements for Phase 3. An agent works through six modules in order, then acknowledges the current Policies and Procedures (PP). Staff confirm the induction (agent record, Onboarding tasks, "Confirm the online induction"), which opens the student-application part of the portal.
- Completions and PP acknowledgements are evidence: server time, IP, browser, no edits or deletes (database triggers).
- Staff edit modules and publish PP versions at Induction and materials. A new PP version asks agents to acknowledge again.
- Marketing materials are drafts until approved; approving emails every active agent.
- Safety net for the 24-hour notice duty: the daily job re-sends the notice to any active agent who was not told about an approved material, and records `material.notice_late` in the audit trail if it was more than 24 hours after approval.
- Migration 019 replaces the starter module text with content written from AFC's website and published policies. It is a draft for AFC to review. The policies and procedures text is still the placeholder until AFC sends the updated version (with the AI wording).
- Who does what: Marketing (and Admin, Director, CEO) upload materials; only Admin, Director and CEO approve or retire them.
- The module, PP and starter-material wording is placeholder text for AFC to review and replace.

### Renewal task (migration 018)
The daily job opens one "Agreement renewal review" task at month 11 of every active agreement (owner: the account manager, else Marketing).

## Phase 4 update: CRM and communications (migration 020)
Follows the client requirements for Phase 4.
- **Communication log**: every email, call, meeting and file note about an agent. Staff: `GET/POST /api/coms/agents/:id/communications`. Agents see their own log at `GET /api/agent-application/communications`. The agent sees every entry in their log (client requirement: "Agent sees all logged communications. Cannot edit or delete."), file notes included, so staff write notes accordingly.
- **Inbound email logging**: `POST /api/inbound/email` for the mail service (forwarding or BCC address) to post received mail. It needs the header `x-inbound-secret` equal to the new environment variable `INBOUND_EMAIL_SECRET`; without the variable the endpoint is switched off. It matches the sender to an agent and is safe to repeat (same Message-ID is stored once).
- **Agent leads**: agents log students they are talking to (`/api/agent-application/leads`); staff see them on the agent record (`/api/coms/agents/:id/leads`). Outcome: pending, submitted, not proceeding.
- **Training records**: `/api/coms/agents/:id/training` (staff). Shown together with induction on the agent record.
- **Six-monthly monitoring**: `/api/coms/agents/:id/monitoring` saves the review form (applications, conversion, complaints, compliance, notes). The daily job opens a MONITORING task from 14 days before each 6-month point of the agreement until 90 days after. Only saving the review closes it; completing it from the task board returns 409.
- **Corrective-action notices**: draft, review and edit, send, then mark implemented or not implemented (`/api/coms/agents/:id/corrective-actions`, `/send`, `/implemented`, `/not-implemented`, `/cancel`, `/redraft`). The daily job alerts the managers once when a sent notice is overdue; "not implemented" emails the Director and CEO.
- **Broadcasts** (`/api/coms/broadcasts`): anyone with access drafts; only Admin, Director and CEO approve. Approving sends at once to active agents, records a delivery per agent and logs it in each agent's communications. The daily job retries stuck sends and records `broadcast.notice_late` if over 24 hours.
- **Drafts** are fixed templates (`crmDrafts.js`), not AI. A person always reads and edits before anything is sent.
- **7-year retention**: database triggers block deletion of communications, leads, training, monitoring, notices, broadcasts and agents. Records are cancelled or closed, never removed.
- Demo data: `npm run seed:demo` now adds communications, leads, training, a monitoring review with a sent notice, and two `[Demo]` broadcasts.
- **Using Gmail for inbound email**: `docs/gmail-inbound-email.gs` is a small Google Apps Script. It runs every 5 minutes inside one chosen Gmail or Workspace mailbox, posts the mail labelled `AFC/agents` to `/api/inbound/email` with the secret, then relabels it `AFC/logged`. Setup steps are at the top of the file. No paid service is needed. Email sent to or from an agent's address is matched to that agent; everything else is ignored.

## Phase 5 groundwork: course catalogue (migrations 021 and 022)
Taken from AFC's *Application for Enrolment Form - International Students* V3.1 and AFC's course list of 24 November 2026.
- Tables `campuses`, `courses`, `course_offerings`. 15 courses: 14 qualifications and General English (ELICOS). Melbourne offers all 15; Launceston offers 13 (not General English or RII60520). ICT60220 has three versions that share one CRICOS code (no specialisation, Telecommunications Network Engineering, Cyber Security) with different durations and fees; AFC's compliance team is checking this.
- Each course has CRICOS code, duration (weeks), tuition fee, material fee, enrolment fee (AUD 250 for every qualification) and entry requirements. Fees exclude the enrolment fee. General English fees are not published, so they stay empty.
- `GET /api/courses` for anyone signed in (active courses only; the administrator also sees switched-off ones). `POST /api/courses` and `PUT /api/courses/:id` are administrator only and audited. Courses are switched off, never deleted. Fees and durations can change, so staff edit them on the **Courses** screen.

## Phase 5: student applications (migrations 023, 024 and 025)
Agents submit students through the portal only. AFC assesses within 5 working days, issues a Letter of Offer, records payment and the CoE, and can issue a Verification of Enrolment.

**Flow:** agent draft → submitted (`received`) → `under_review` → `info_requested` (agent edits and resubmits, back to `under_review`) → `decision_made` (offer or not offered) → Letter of Offer issued → payment confirmed → CoE recorded (`coe_issued`) → Verification of Enrolment issued. `withdrawn` is available to staff until a CoE is issued.

**Who can do what** (`APP_PERMS` in `src/const.js`, easy to change): every staff role reads; Admin, Director and Admissions assess and prepare the letter; Director, CEO and Admin issue it; Admin and Accounts confirm payment; Admin and the CoE Administrator record the CoE and issue the VoE; only Admin edits the settings. The agent must be Active and have finished the induction.

**Agent side** (`/agent/applications`): a step-by-step version of the AFC Application for Enrolment Form (International) V3.1. Each step saves when the agent moves on. Draft saving is lenient, submitting is strict (all required answers, the student is 18 or over at the start date, passport not expired, course offered at the campus, all required documents uploaded, every declaration ticked, the two agent confirmations). Flags set on submit: `late_submission` (submitted more than the configured hours after the agent received the documents) and `needs_transfer_review` (studying a principal course elsewhere for under 12 months and not released, National Code Standard 7). The agent is emailed an acknowledgement, and so is the student. Admissions are emailed (the Director if there are none).

**Staff side** (`/coms/applications`): queue sorted by due date with the working days left, flags, search and filters; a detail page with every answer, document review (accept, or "needs update" with a note), request for information, decision, withdraw, and the letter, payment, CoE and VoE steps. The daily job emails the Director once at day 4 of 5 for anything still undecided.

**Settings** (`/admin/application-settings`, so AFC can change them without a developer): declaration statements, privacy notice, the two agent confirmations, hours to submit, working days to assess, the list of required documents (switched off, never deleted), downloadable forms (for example the GS form), and the Letter of Offer and VoE wording with the signer. **Letters cannot be issued until an administrator ticks "confirmed"**, so the placeholder wording can never go to a student by accident. Unfilled `{{fields}}` also stop a letter being issued.

**Records:** applications, documents, status log and letters are kept for 7 years (delete is blocked by database triggers). Every action is in the audit log. Files are named for the student when downloaded.

**API** (all under `/api/student-applications`): agents `GET /config`, `GET /`, `POST /`, `GET|PUT /:id`, `POST /:id/discard|submit|documents`, `POST /:id/documents/:docId/delete`, `GET /:id/documents/:docId/download`, `GET /:id/files/letter|coe|voe`; staff `GET /staff`, `GET /staff/:id`, `POST /staff/:id/start-review|request-info|decision|withdraw|letter|letter/issue|letter/revise|payment|coe|voe`, `PUT /staff/:id/letter`, `POST /staff/:id/documents/:docId/review`; administrators `GET|PUT /settings`, `PUT /settings/document-types`, `POST /settings/forms`, `POST /settings/forms/:formId`.

**Waiting for AFC** (set in the settings or the Courses screen, no code change): the Letter of Offer template, conditions and signer; the VoE wording; the pre-enrolment pack wording; privacy and consent wording; the GS form and Credit Transfer/RPL form (upload on the settings screen); intake dates and English score minimums (not enforced yet); financial evidence rules; who assesses and who manages; how payment is confirmed; whether students get a login (today they only receive emails).

Demo data: `npm run seed:demo` adds six sample applications for the Golden Gate demo agent (received, under review and due, waiting for the agent, offer with a draft letter, not offered, and one with all three flags). `npm run seed:demo -- --remove` removes them.
