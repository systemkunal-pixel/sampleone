# Loan Recovery

A loan collection system with three parts:

| Part | Who | Where |
|---|---|---|
| **Field app**: installable phone app (PWA) | Field officers and supervisors | `https://<your-domain>/` |
| **Admin console**: responsive web console | Head office admins | `https://<your-domain>/admin/` |
| **Server**: Node.js API with a **MariaDB** database | | Serves both of the above |

No build step is needed. The app is plain HTML, CSS and JavaScript, and the server's only runtime dependencies are `mariadb` and `exceljs`.

## Quick install (Ubuntu / Debian)

One script installs everything on a fresh machine: Node.js 22, MariaDB, the database and its user (with a random password), and the app in `/opt/loan-recovery`. It also creates the first admin and starts the server on port 8080 as a service.

```bash
git clone -b claude/eager-ride-t1oaiq https://github.com/systemkunal-pixel/sampleone.git ~/sampleone
sudo bash ~/sampleone/scripts/install.sh --demo        # --demo adds sample data; leave it out for production
```

At the end it prints the admin password, which is also saved in `/root/loan-recovery-credentials.txt` (readable by root only). Open `http://localhost:8080/admin/` and sign in as **ADMIN**.

- **HTTPS on a public server:** point your domain's DNS at the machine, open ports 80 and 443, then run `sudo bash ~/sampleone/scripts/install.sh --domain recovery.example.com`. Caddy obtains the certificate.
- **Updating:** `git -C ~/sampleone pull && sudo bash ~/sampleone/scripts/install.sh`. The database, data and passwords are kept.
- **Other options:** `--port`, `--app-dir`, `--db-name`, and `--public` (listen on your network without HTTPS, for testing only). Run with `--help` to see them all.

## Quick install (Windows 10 / 11)

`scripts/install.ps1` uses winget to install Node.js LTS and MariaDB, if they're missing. It then secures MariaDB's root account with a generated password, creates the database and its user, and copies the app to `C:\LoanRecovery`. It also creates the admin and starts the server in the background at every Windows start-up, as a scheduled task that restarts automatically.

In **PowerShell run as Administrator**:

```powershell
winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
# close and reopen PowerShell (as Administrator), then:
git clone -b claude/eager-ride-t1oaiq https://github.com/systemkunal-pixel/sampleone.git C:\src\sampleone
powershell -ExecutionPolicy Bypass -File C:\src\sampleone\scripts\install.ps1 -Demo
```

- **Running from the cloned folder:** add `-AppDir` with the project folder itself, e.g. `-AppDir "E:\Code Works\LoanRecovery"`. The app then runs from there instead of being copied to `C:\LoanRecovery`, and `.env`, `credentials.txt` and `logs\` are git-ignored.
- **Passwords:** the admin password and the MariaDB root password are printed at the end and saved in `C:\LoanRecovery\credentials.txt` (readable by Administrators only).
- **Testing from phones on your Wi-Fi:** add `-Public` to open the firewall port. Without HTTPS, phones can't use the camera, GPS or install the app.
- **Updating:** `git -C C:\src\sampleone pull`, then run the same `install.ps1` command again. Data and passwords are kept.
- **Logs and control:** the log is at `C:\LoanRecovery\logs\server.log`. Stop or start the server with `Stop-ScheduledTask LoanRecovery` / `Start-ScheduledTask LoanRecovery`.
- **MariaDB already installed:** the script lists every database server it finds (service, version, port, data folder) and says which one it uses. It asks for that server's root password (3 tries); you can also pass `-DbRootPassword '<password>'`.
- **Forgotten root password:** add `-ResetRootPassword`. The MariaDB service stops for about a minute while a new root password is set (saved in `credentials.txt`); databases and data are kept.
- **Several servers installed:** pick one with `-DbPort 3307`. The script refuses to continue if another program (e.g. XAMPP's MySQL) holds the chosen port.

## What each role can do

**Field officer** (phone, 4–8 digit PIN)
- Sees the day's visit plan in priority order: promises due today, then broken promises, follow-ups, and the most overdue loans.
- Collects payments (Cash, UPI, Cheque, Bank transfer) and issues GPS-stamped receipts.
- Records **bank deposits** with a photo of the pay-in slip.
- Logs visits and promises to pay.
- Works offline. Records are sent the moment the server is reachable, and the header shows **● Live**, **Sending…** or **Offline · N queued**.

**Supervisor** (phone, PIN)
- Verifies or rejects (with a reason) the bank deposits recorded in their branch, looking at the slip image. Automatic checks flag suspicious deposits.
- Sees the branch accounts and a branch summary.

**Admin** (admin console, password of 10+ characters, 12-hour sessions)
- **Dashboard:** outstanding, overdue, PAR 30, today's and this month's collections, deposits awaiting verification, unassigned loans, portfolio ageing by days past due (DPD), branch performance and recent activity.
- **Users:**
  - Create officers, supervisors and admins, and edit them.
  - Reset a PIN or password; the new one is shown once and the user is signed out everywhere.
  - Deactivate or reactivate accounts, with safety rules:
    - you can't lock yourself out;
    - there's always at least one admin;
    - an officer's loans must be reassigned before you deactivate them or move them to another branch.
- **Loans:** search and filter by branch, officer, DPD band or unassigned, with sorting and paging. You can also:
  - open a loan to see its details, payments, visits and schedule, and reassign it;
  - select many loans and assign them to an officer in one go;
  - export the list to CSV.
- **Import loans:** upload Excel (.xlsx), CSV or JSON, then review the result before anything is saved (new or updated loans, warnings, and errors with row numbers), download an error report, and confirm. Import history is kept, and a downloadable Excel template is included.
- **Audit log:** every sign-in (and failed attempt), user change, PIN reset, import, reassignment and deposit decision.

## Help & guides inside the app

The full user manual is built in, so staff don't need a separate document:

- **Phone app:** tap **?** at the top of any screen to open the guide for that screen. Or go to **Settings → Help & guides**, which is searchable, works offline, and can be opened from the sign-in screen. Officers and supervisors each see only their own topics.
- **Admin console:** open **Help & guides** in the sidebar (or from the account menu). You can filter by role, and **Print guide** makes a printable training handout for each role. Every page has a **Help** button for its own topic. A **Getting started** checklist on the dashboard ticks itself off as you complete setup.
- **Contents:** getting started, how-to guides for every task, daily routines for each role, a two-week rollout plan, troubleshooting and a glossary.
- **Editing:** the content lives in one file, `src/help/content.js`. Edit it there, and `tests/help.test.js` checks that every help link in the apps still points to an existing topic.

## Loan import format

Download the template from **Import loans → Excel template**. The rules:

- **Matching:** loans are matched on **Loan No**. Re-importing updates the borrower details, schedule and officer. Payments and visits are never changed.
- **Required columns:** Loan No, Branch, Principal, EMI, Disbursed On, Borrower Name, Phone.
- **Optional columns:** Officer Code, Product, Tenure, First Due Date, Frequency (monthly / weekly / fortnightly), Business, Address, Village, Latitude, Longitude, Guarantor Name, Guarantor Phone.
- **Headings are matched flexibly.** For example, "Loan Account No", "Customer Name", "Mobile No", "No of EMIs" and "First EMI Date" are all recognised. Supported aliases are listed in `server/importer.js` (`LOAN_COLUMNS`). Once your system's export file is available, any unrecognised headings only need adding to that list.
- **Schedule:** if an **Installments** sheet (Loan No, Installment No, Due Date, Amount) has rows for a loan, that exact schedule is used. Otherwise one is generated from Tenure + First Due Date + EMI + Frequency.
- **Dates:** Excel dates, `DD-MM-YYYY`, `DD/MM/YYYY`, `25-Feb-2026` or `YYYY-MM-DD`. The day always comes first.
- **Phone:** a 10-digit Indian mobile number. `+91` or a leading `0` is removed automatically.
- **Officer:** must be an active field officer of the same branch. Leave it blank to import the loan unassigned.
- **JSON:** an array of loans, either flat rows with the same headings or the API shape (`borrower {…}`, `installments […]`).
- **Limits:** 10 MB and 20,000 loans per file. Old `.xls` files must be saved as `.xlsx` first.

Rows with errors are skipped. Valid rows can be imported straight away, and the error report lists every problem with its row number. The server re-validates everything when you confirm.

## Setup (local or server)

Requirements: Node.js 20.12 or later, and MariaDB 10.6 or later.

```bash
# 1. Database (as MariaDB root)
mariadb -e "CREATE DATABASE loan_recovery CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
            CREATE USER 'recovery'@'localhost' IDENTIFIED BY 'a-strong-password';
            GRANT ALL ON loan_recovery.* TO 'recovery'@'localhost';"

# 2. App
cp .env.example .env            # set DB_PASSWORD (and DB_HOST if MariaDB is on another machine)
npm ci --omit=dev

# 3. First admin (tables are created automatically)
npm run admin -- add-user --code ADMIN --name "Your Name" --role admin --branch "Head Office" --pin 'A-strong-pass1'

# 4. Start
npm start                       # http://localhost:8080   ·   console at /admin/
```

Sign in to `/admin/`, create officers and supervisors, then import your loans. To try everything with sample data on an empty database instead, run `npm run admin -- seed-demo`. It creates FO27 / FO31 (PIN 1234), SUP1 (PIN 9999) and ADMIN (password `Demo@Admin2026`). **Don't** run it on a production database.

Command-line equivalents: `npm run admin -- add-user | set-pin | deactivate | list-users | import-loans <file> | migrate`.

### Moving to another MariaDB server

Change `DB_HOST`, `DB_PORT`, `DB_USER`, `DB_PASSWORD` and `DB_NAME` in `.env` and restart. The schema is created and upgraded automatically on start. To move existing data, use `mariadb-dump loan_recovery | mariadb -h <new-host> loan_recovery`. Slip images are stored in the database, so nothing else needs copying.

## Hosting on HTTPS

HTTPS is required: phones only allow the camera, GPS, offline mode and installing over HTTPS. Ready-made files are in `deploy/`:

1. Copy the project to `/opt/loan-recovery`, create `.env` (keep `HOST=127.0.0.1`), and run `npm ci --omit=dev`.
2. Install `deploy/loan-recovery.service` as a systemd service. It starts at boot and restarts on failure.
3. Set up HTTPS with **either**:
   - `deploy/nginx.conf` plus `certbot --nginx -d your-domain`, **or**
   - `deploy/Caddyfile`, where Caddy gets and renews the certificate itself.

   Both allow 50 MB request bodies for imports and slips, and add HSTS.
4. Open `https://your-domain/admin/` and sign in.

**Maintenance:** while the app is stopped, the proxy answers 502. The field app treats that as "server unreachable": officers keep working, and queued records are sent automatically when the server returns. Records are de-duplicated, so a resend never double-counts.

**Backups:** back up the MariaDB database, for example a nightly `mariadb-dump`. It contains everything, including slip images.

## Security

- PINs and passwords are hashed with scrypt.
- Sessions are random tokens, and only their SHA-256 hash is stored. Field sessions last 30 days and admin sessions 12 hours; admin sessions also end when the browser closes.
- 5 wrong attempts lock a code for 15 minutes.
- Deactivating a user, resetting their PIN, or changing their role or branch ends their sessions immediately.
- Every input is validated on the server. Officers can only record against loans assigned to them, and supervisors only see their own branch.
- Slip files are checked by their actual file contents (they must really be JPEG, PNG, WebP or PDF).
- Pages are served with a strict Content-Security-Policy, `X-Frame-Options: DENY` and `nosniff`. CSV exports are protected against formula injection.
- Every administrative action is written to `audit_log`.

## API

All endpoints except `login` and `health` need `Authorization: Bearer <token>`.

| Endpoint | Role | Purpose |
|---|---|---|
| `POST /api/login` `{code, pin}` · `POST /api/logout` | all | Sessions |
| `GET /api/bootstrap` | officer, supervisor | The officer's loans (or a supervisor's branch) with history |
| `POST /api/records` | officer | Payments and visits. Idempotent per record ID |
| `GET /api/slips/:paymentId` | officer (own), supervisor (branch), admin | Deposit slip |
| `GET /api/deposits?status=` · `POST /api/deposits/:id/decision` | supervisor | Verification queue and decisions |
| `GET /api/admin/summary` | admin | Dashboard figures |
| `GET/POST /api/admin/users` · `PATCH /api/admin/users/:code` · `POST /api/admin/users/:code/reset-pin` | admin | User management |
| `GET /api/admin/loans` · `GET/PATCH /api/admin/loans/:id` · `POST /api/admin/loans/assign` · `GET /api/admin/loans/export` | admin | Loans |
| `GET /api/admin/import/template` · `POST /api/admin/import/preview` · `POST /api/admin/import/commit` · `GET /api/admin/imports` | admin | Import |
| `GET /api/admin/audit` · `POST /api/admin/me/password` · `GET /api/admin/branches` | admin | Audit, own password, branch list |

## Project layout

```
src/                  field app (PWA)
  admin/              admin console: index.html, admin.css, js/main.js, js/views/*.js
server/
  index.js            entry point            app.js        routes, static hosting, headers
  admin-api.js        admin endpoints        importer.js   Excel/CSV/JSON parsing, validation, template
  records.js          officer record intake  auth.js       PINs, sessions, throttling
  db.js schema.sql    MariaDB                admin.js      admin command-line tool
deploy/               nginx, Caddy and systemd files
tests/                node:test suites
```

## Tests

```bash
npm test                                     # logic and import parsing (database tests are skipped)
TEST_DB_USER=recovery TEST_DB_PASSWORD=… TEST_DB_NAME=loan_recovery_test npm test   # everything
```

The database tests **wipe** the test database, so point them at a dedicated one.
