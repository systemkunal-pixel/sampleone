# Loan Recovery – Field Officer App

An offline-first Progressive Web App for loan collection field officers. It plans the day's visits, records collections with receipts, logs visit outcomes and promises to pay, and syncs to the head office when there is network.

No build step and no runtime dependencies: plain HTML, CSS and ES modules.

## Features

- **Prioritised visit plan.** Overdue accounts are ranked by promises due today, broken promises, follow-ups due, days past due and overdue amount. **📍 Near me** shows the distance to each borrower.
- **Account view.** Overdue, outstanding, next EMI, active promise, full repayment schedule and activity history. One-tap Call, WhatsApp and Google Maps directions to the borrower, plus the guarantor's contact.
- **Payment collection.** Cash, UPI, cheque and bank transfer. A reference is required for anything other than cash. The app checks the amount against the outstanding balance, takes a GPS stamp and issues a sequential receipt number (`R-<officer>-<yymmdd>-<seq>`). Receipts can be shared by SMS or WhatsApp, or printed.
- **Direct bank deposits.** If the borrower paid at the bank, the officer picks **Bank deposit**, photographs the pay-in slip (or attaches a PDF), and enters the amount, slip/journal number, bank and branch, and deposit date.
  - Photos are shrunk to a maximum of 1600 px on the phone, typically around 80 KB.
  - A slip number can't be used twice, on any account. Comparison ignores case, spaces and dashes.
  - The deposit date can't be in the future or more than 90 days old.
  - The deposit reduces the borrower's dues right away but is marked **Pending verification**. The borrower gets an acknowledgement instead of a cash receipt.
  - Slip images are kept in IndexedDB and uploaded with the sync.
- **Visit logging.** Outcomes are promise to pay, not available, door locked, refused, dispute and shifted. Each visit can carry a promised date and amount, a follow-up date, notes and a GPS stamp.
- **DPD buckets.** Payments are allocated FIFO across installments. Accounts are bucketed Current / 1–30 / 31–60 / 61–90 / 90+ (NPA).
- **Summary.** Today's collections by payment mode and visit outcomes, a portfolio ageing chart, and a CSV export of the day's activity. The export is safe against spreadsheet formula injection.
- **Offline and sync.** A service worker caches the app shell. Every payment and visit is queued in an outbox and POSTed to your sync endpoint, either on demand or automatically when the device comes back online. JSON backup and restore are included.
- Light and dark themes, large touch targets, works at 320 px and up.

## Run it

```bash
npm start        # http://localhost:8080
npm test         # unit tests for the recovery logic (Node 20.11+)
```

On first launch, enter the officer name, code and branch. Tick **Load demo portfolio** to get 12 sample accounts across all DPD buckets.

## Installing on a phone

Host the app over HTTPS. The camera, GPS, offline mode and installing all need HTTPS, except on `localhost`. Then open the link once on each phone:

- **Android (Chrome):** the app shows an **Install** banner on the Today screen and an **Install app** button in Settings. It installs with its own icon and opens full-screen.
- **iPhone (Safari):** tap Share → **Add to Home Screen**. The app shows these steps itself.

On start-up the app asks the browser to protect its storage, so unsynced records aren't cleared when the phone runs low on space. Settings shows whether storage is protected and how much space is used. Installed apps are normally protected automatically.

For Play Store or MDM distribution, wrap the hosted app as a Trusted Web Activity with [Bubblewrap](https://github.com/GoogleChromeLabs/bubblewrap) or [PWABuilder](https://www.pwabuilder.com/).

## Sync API contract

Set the endpoint URL and token under **Settings → Sync**. The app sends:

```http
POST <syncUrl>
Authorization: Bearer <token>
Content-Type: application/json

{
  "officer": { "name": "…", "code": "FO27", "branch": "…" },
  "sentAt": "2026-10-08T17:42:10",
  "records": [
    { "id": "ob-…", "type": "payment", "loanId": "L1008", "queuedAt": "…",
      "record": { "id": "p-…", "at": "…", "amount": 3617, "mode": "UPI", "reference": "UTR…",
                  "receiptNo": "R-FO27-261008-001", "officer": "FO27", "location": { "lat": 0, "lng": 0, "accuracy": 12 } } },
    { "id": "ob-…", "type": "visit", "loanId": "L1003", "queuedAt": "…",
      "record": { "id": "v-…", "at": "…", "outcome": "PTP", "ptpDate": "2026-10-12", "ptpAmount": 3100,
                  "followUpDate": null, "notes": "…", "officer": "FO27", "location": null } }
  ]
}
```

A bank-deposit payment carries the details in `record.deposit`, and the slip itself is a sibling of `record`:

```json
{ "id": "ob-…", "type": "payment", "loanId": "L1002", "queuedAt": "…",
  "record": { "id": "p-…", "amount": 3100, "mode": "Bank deposit", "reference": "JRN4471", "receiptNo": "…",
              "deposit": { "slipNo": "JRN4471", "bank": "SBI, Chinhat", "depositDate": "2026-10-07",
                           "slipId": "slip-…", "slipType": "image/jpeg", "verification": "pending" } },
  "slip": { "mimeType": "image/jpeg", "base64": "/9j/4AAQ…" } }
```

The back office should match these deposits against the bank statement before treating them as realised.

Return any 2xx status once every record is stored. The app then clears those records from the outbox. Use `record.id` to de-duplicate, because a batch is re-sent if the response is lost. If the server returns a non-2xx status, the records stay queued.

## Project layout

```
src/
  index.html, styles.css, manifest.webmanifest, sw.js, icons/
  js/logic.js   pure domain logic (DPD, allocation, priority, validation, CSV), unit tested
  js/store.js   localStorage persistence, outbox and sync
  js/seed.js    demo portfolio generated relative to today
  js/slips.js   IndexedDB storage and compression for deposit-slip images
  js/app.js     views, hash router and event handling
scripts/serve.js  zero-dependency dev server
tests/            node:test suites
```

## Notes for production

- The loan book currently comes from demo data or a JSON restore. Hook up a "pull allocation" call that fetches each officer's assigned accounts.
- Data is stored unencrypted in the browser's `localStorage`. For real borrower PII, add device-level controls such as MDM or a managed browser, and consider an app PIN.
- Timestamps are device-local and do not include a timezone.
- Deposit verification status (`verified` / `rejected`) is displayed but can't yet be updated from the server. It needs a sync response or a pull endpoint. JSON backups don't include slip images.
