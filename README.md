# Loan Recovery – Field Officer App

A loan collection app for field officers, with supervisor verification of bank deposits.

- **Phone app:** an installable web app (PWA) in `src/`. It's plain HTML, CSS and JavaScript with no build step.
- **Server:** Node.js in `server/`. It serves the app and a JSON API, with **MariaDB** as the database.

The app works **in real time**: every payment and visit goes to the server the moment it's saved, and supervisor decisions reach officers within about a minute. If the server can't be reached (no signal, or server maintenance), the app keeps working. Records wait on the phone and are sent automatically when the server is back. The header always shows **● Live**, **Sending…** or **Offline · N queued**.

## Features

**Field officers**
- **Prioritised visit plan.** Promises to pay due today come first, then broken promises, follow-ups due, days past due and overdue amount. **📍 Near me** shows the distance to each borrower.
- **Account view.** Dues, next EMI, the active promise, repayment schedule and full history. One-tap Call, WhatsApp and Maps for the borrower and guarantor.
- **Collect payment:** Cash, UPI, Cheque, Bank transfer, or **Bank deposit**.
  - Every payment gets a GPS stamp and a sequential receipt (`R-<officer>-<yymmdd>-<seq>`) to share by SMS or WhatsApp, or print.
  - **Bank deposit:** the borrower paid at the bank. The officer photographs the pay-in slip (or attaches a PDF) and enters the slip number, bank and deposit date. The borrower gets an acknowledgement marked *pending verification*.
- **Visit logging.** Outcome, promise to pay (date and amount), follow-up date and notes.
- **Live feedback.** If the server refuses a record, such as a slip already used on another account, the officer sees why straight away. If a supervisor rejects a deposit, it shows on the Today screen with the reason.

**Supervisors**
- **Deposit verification queue**, oldest first.
  - Each deposit shows the slip image, the amount entered, slip number, bank, deposit date and who recorded it.
  - Automatic checks flag a deposit reported more than 7 days late, an amount over 3× the EMI, or a missing GPS stamp.
- **Verify** or **Reject**. Rejecting needs a reason, and there are quick-pick reasons. A rejected deposit no longer reduces the borrower's dues, and its slip number can be entered again after correction. A deposit can only be decided once, so two supervisors can't both act on it. Every decision is recorded in `audit_log`.
- Branch-wide accounts and a branch summary.

**Both:** a portfolio breakdown by days past due, a CSV export of the day's activity, an install-to-home-screen prompt, and protected device storage.

## Running it

Requirements: Node.js 20.12 or later, and MariaDB 10.6 or later.

```bash
# 1. Database and user (as MariaDB root)
mariadb -e "CREATE DATABASE loan_recovery CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
            CREATE USER 'recovery'@'localhost' IDENTIFIED BY 'a-strong-password';
            GRANT ALL ON loan_recovery.* TO 'recovery'@'localhost';"

# 2. Configure
cp .env.example .env          # set DB_PASSWORD etc.
npm install

# 3. Users and loans (tables are created automatically)
npm run admin -- seed-demo    # optional demo branch: FO27 / FO31 (PIN 1234), SUP1 (PIN 9999)
npm run admin -- add-user --code FO40 --name "Anil Rao" --role officer --branch "Lucknow Rural" --pin 4821
npm run admin -- import-loans loans.json

# 4. Start
npm start                     # http://localhost:8080
```

Other admin commands: `set-pin`, `deactivate`, `list-users` and `migrate`. Run `npm run admin` to see them all.

### Production

- **HTTPS is required.** Phones only allow camera, GPS, offline mode and installing over HTTPS. Put nginx or Caddy in front of `npm start`, and run it under systemd or pm2 so it restarts on its own.
- **During maintenance**, the proxy's 502/503 responses are treated as "server unreachable". Officers keep working, and queued records are sent when it's back. Records are de-duplicated by ID, so a resend never creates a double entry.
- Back up the MariaDB database. It holds everything, including the slip images (`deposit_slips`).
- Sessions last 30 days (`SESSION_DAYS`). Five wrong PINs lock a code for 15 minutes. `set-pin` and `deactivate` end all of that user's sessions.

## Installing on a phone

Open the server's HTTPS address once on each phone:

- **Android (Chrome):** tap **Install** on the banner, or **Install app** in Settings. The app gets its own icon and opens full-screen.
- **iPhone (Safari):** tap Share → **Add to Home Screen**. The app shows these steps itself.

For Play Store or MDM distribution, wrap the hosted app as a Trusted Web Activity with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) or [PWABuilder](https://www.pwabuilder.com/).

## Loan import format

`import-loans` upserts by `id`, so re-importing reassigns accounts or updates schedules. Payments and visits are never touched.

```json
[{
  "id": "L1001", "loanNo": "MFL/24/1001", "branch": "Lucknow Rural", "officerCode": "FO27",
  "product": "Micro Business Loan", "principal": 50000, "emi": 5167, "disbursedOn": "2026-01-25",
  "borrower": { "name": "Ramesh Kumar", "phone": "9810000000", "business": "Kirana store",
                "address": "Ward 4", "village": "Rampur", "lat": 26.851, "lng": 80.949,
                "guarantor": { "name": "…", "phone": "…" } },
  "installments": [{ "no": 1, "dueDate": "2026-02-25", "amount": 5167 }]
}]
```

## API

All endpoints except `login` and `health` need `Authorization: Bearer <token>`.

| Method & path | Who | Purpose |
|---|---|---|
| `POST /api/login` `{code, pin}` | anyone | Returns `{token, user}` |
| `POST /api/logout` | any | Ends the session |
| `GET /api/bootstrap` | any | The officer's accounts (or a supervisor's whole branch) with payments and visits |
| `POST /api/records` `{records:[…]}` | officer | Stores payments and visits. Returns `accepted`, `duplicate` or `rejected` (with a reason) for each record |
| `GET /api/slips/:paymentId` | officer (own) / supervisor (branch) | The deposit slip image or PDF |
| `GET /api/deposits?status=pending\|verified\|rejected` | supervisor | The verification queue |
| `POST /api/deposits/:paymentId/decision` `{decision, note}` | supervisor | `verified` or `rejected` (a note is required to reject) |
| `GET /api/health` | anyone | Checks the server and its database connection |

**Server-side checks.** Every field is validated, and the officer code comes from the session, not the phone. Payments are checked against the outstanding balance. Slip files must really be JPEG, PNG, WebP or PDF (checked by file signature, max 5 MB). Slip numbers are unique, ignoring case and punctuation, until a supervisor rejects the deposit. The app is served with a strict Content-Security-Policy.

## Project layout

```
src/                 the phone app (served as static files)
  js/app.js          router, officer screens, events
  js/supervisor.js   deposit verification screens
  js/store.js        session, live sync, offline outbox
  js/api.js          API client (tells "server unreachable" apart from "server said no")
  js/logic.js        pure domain logic, shared with the server (DPD, allocation, validation)
  js/slips.js        slip image storage (IndexedDB) and compression
  js/install.js      install prompt and storage protection
  js/seed.js         demo portfolio (used by `admin seed-demo`)
server/
  index.js           entry point
  app.js             HTTP routes, static hosting, security headers
  records.js         validation and storage of officers' records
  auth.js            PIN hashing (scrypt), sessions, login throttling
  db.js schema.sql   MariaDB pool, migrations, queries
  admin.js           admin command-line tool
tests/               node:test suites
```

## Tests

```bash
npm test             # domain logic. The server tests are skipped without a database.
TEST_DB_USER=recovery TEST_DB_PASSWORD=… TEST_DB_NAME=loan_recovery_test npm test
```

The server tests **wipe** the test database. Point them at a dedicated one.

## Not yet included

- Data on the phone (including the session token) is stored unencrypted in the browser. Use managed devices, MDM, for real borrower data.
- There is no web admin screen. Users and loans are managed with `npm run admin`.
- Timestamps are local time in the server's `TZ` (default `Asia/Kolkata`).
