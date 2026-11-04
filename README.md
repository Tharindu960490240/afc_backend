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
- Agent register: `/api/coms/agents` (list, create from expression of interest, edit, status, people, milestones, soft delete/restore, CSV export). Existing agent accounts are back-filled by migration `005`.
- Working-day calendar: `public_holidays` table (Tasmania and Victoria, seeded for 2026-2027), editable by admin at `/api/coms/holidays`. Add Launceston local days and the 2027 AFL Grand Final Friday when announced.
- Audit log now keeps before/after values; rows cannot be edited, and cannot be deleted for 7 years. For a developer database only: `SET afc.allow_audit_purge = on;` allows deletes.
- Run `npm run migrate` after updating.
#   a f c _ b a c k e n d  
 