# LoanDesk — notes for Claude Code

LoanDesk is a multi-company loan-recovery platform by DataHaat: field app (PWA) for agents and coordinators, admin
console for each company, overlord console for the operator, Node.js server with MariaDB. Live at
https://loandesk.datahaat.com (Windows Server, IIS in front, app in `C:\websites\loandesk\app`, run by the updater agent).
Company 1 is BRMC, a recovery agency; its first client portfolio is a lender's recovery list (VFS, about 11,000 accounts).
The README is the full manual; this file is what to keep in mind while changing the code.

## How the owner works

- Windows PC, PowerShell, project folder `E:\Code Works\LoanRecovery`. All work so far is on branch `claude/eager-ride-t1oaiq`.
- Releases are signed patches built on this PC and installed from the overlord console (Update & diagnostics).
- **Always give the complete script** (PowerShell, copy-paste ready) for anything the owner runs: build, install, server steps.
- Plain language in replies; they test on the live server and report back with screenshots.

## Releasing

1. Raise `version` in `package.json` and on lines 3 and 9 of `package-lock.json` only (other `"version"` lines belong to libraries).
2. `npm test` with the test database (below) — everything must pass.
3. `node scripts/patch.js build --notes "what changed"` → `dist\loandesk-<version>.ldpatch` (signing key stays on this PC,
   in `%USERPROFILE%\.loandesk\`; never copy it anywhere else). Install it from the overlord console.
4. Schema changes: the updater backs up the database first and rolls back if the new version is unhealthy. Rehearse
   migrations on a copy with production-sized data (e.g. an 11,000-account recovery list) before releasing.
5. While the app restarts IIS shows `deploy/updating.html` (set up on the server with `scripts/iis-updating-page.ps1`).

## Tests

```powershell
$env:TEST_DB_USER='recovery_test'; $env:TEST_DB_PASSWORD='<test password>'; $env:TEST_DB_NAME='loan_recovery_test'; npm test
```
The DB tests **wipe** that database — use a dedicated one (`CREATE DATABASE loan_recovery_test; CREATE USER
'recovery_test'@'localhost' IDENTIFIED BY '…'; GRANT ALL ON loan_recovery_test.* TO 'recovery_test'@'localhost';`).
When adding a table, add it to the drop list at the top of every DB test file (admin, desk, mail, overlord, server).

## Conventions

- **No build step, few dependencies.** Plain HTML/CSS/JS modules in `src/`; server uses only mariadb, exceljs, nodemailer,
  qrcode-svg. Prefer the standard library over a new package.
- **Schema** (`server/schema.sql`) runs at every start: statements must be idempotent (`IF NOT EXISTS`, `ADD COLUMN IF NOT
  EXISTS`). The file is split on `;` — never put a semicolon inside a comment or string. Data migrations go in `db.migrate`.
- **Company isolation:** every query is limited to the signed-in user's `company_id`; check that loan/payment ids belong to
  the company before reading or writing. Supervisors see only their team (`team.js` `supervisorScope` / `scopeSql`).
- **Shared logic:** `src/js/logic.js` runs in the browser and on the server (loan status, daily report, ageing). Put
  calculations there so the phone and the server agree.
- **Languages:** English text is the key (`t('Collect payment')`). Every new string needs Hindi and Bengali in
  `src/i18n/hi.js` and `bn.js`; server error messages shown to users are listed in `src/i18n/server-messages.js`. Run
  `node scripts/i18n-keys.js` then `node scripts/i18n-keys.js --check` (missing, unused and placeholder checks also run in tests).
- **Help manual:** `src/help/content.js`, with `src/help/i18n/hi.js` and `bn.js` having the same topics and the same
  number of steps and tips. Every help link in the apps must point to an existing topic (tested).
- **Field app offline cache:** a new file under `src/js/` must be added to `SHELL` in `src/sw.js`, and `CACHE` bumped on every release.
- Imports never reject a row of a lender's file for bad data: keep it, warn, and report.

## Domain facts worth remembering

- Hierarchy: Agency Head (admin) → State Head (Regional Coordinator) → District/Area Coordinator → Agent. Posts
  `state_head`, `coordinator`, `agent`; the company can rename them (Team → Settings).
- An agent's usual portfolio is **25 accounts** — a planning figure (recruitment plan), **not a cap**.
- Client → State → Circle (optional) → District → Branch (optional) → Accounts; billing by circle or state; each payment
  keeps the client and circle it had when collected.
- Daily report: contacted = reached (payment, PTP, refused, dispute); no-contact = not available, door locked, shifted,
  phone not answered; a payment counts as a visit unless the account was only phoned. Recovery % = collected this month ÷
  overdue on the 1st. Payments count for the agent who collected them.
- RBI contact hours 8 am – 7 pm: the evening team report goes out at 7:30 pm.

## Security rules (the repository is public)

- Never commit `.env`, `credentials.txt`, `secret.key`, `*.pem`, `*.ldpatch`, passwords or connection strings.
- Never commit real borrower data; tests and demos use made-up names and numbers.
- Passwords shared in chat must never go into code. Don't ask for the SMTP password in chat — it is typed into the console.

## Open items (owner)

- Nightly database backups with an off-site copy on the production server.
- Change the ADMIN password; rotate passwords that were shared in chat; remove `credentials.txt` from the server;
  keep an offline backup of the signing key.
- Open question: does a lender's next monthly file already deduct payments our agents collected? If so, a reconciliation
  against receipts since the previous file is needed before re-importing (project report item B14.9).
- The project report (Word) and its generator are kept outside this repository (confidential).
