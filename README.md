# Loan Recovery – Field Officer App

An offline-first Progressive Web App for loan collection field officers. It plans the day's visits, records collections with receipts, logs visit outcomes and promises to pay, and syncs to the head office when there is network.

No build step and no runtime dependencies: plain HTML, CSS and ES modules.

## Features

- **Prioritised visit plan.** Overdue accounts are ranked by promises due today, broken promises, follow-ups due, days past due and overdue amount. **📍 Near me** shows the distance to each borrower.
- **Account view.** Overdue, outstanding, next EMI, active promise, full repayment schedule and activity history. One-tap Call, WhatsApp and Google Maps directions to the borrower, plus the guarantor's contact.
- **Payment collection.** Cash, UPI, cheque and bank transfer. A reference is required for anything other than cash. The app checks the amount against the outstanding balance, takes a GPS stamp and issues a sequential receipt number (`R-<officer>-<yymmdd>-<seq>`). Receipts can be shared by SMS or WhatsApp, or printed.
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

To install on a phone, serve the `src/` folder over HTTPS (any static host works) and use **Add to Home screen**. Service workers and geolocation need HTTPS, except on `localhost`.

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

Return any 2xx status once every record is stored. The app then clears those records from the outbox. Use `record.id` to de-duplicate, because a batch is re-sent if the response is lost. If the server returns a non-2xx status, the records stay queued.

## Project layout

```
src/
  index.html, styles.css, manifest.webmanifest, sw.js, icons/
  js/logic.js   pure domain logic (DPD, allocation, priority, validation, CSV), unit tested
  js/store.js   localStorage persistence, outbox and sync
  js/seed.js    demo portfolio generated relative to today
  js/app.js     views, hash router and event handling
scripts/serve.js  zero-dependency dev server
tests/            node:test suites
```

## Notes for production

- The loan book currently comes from demo data or a JSON restore. Hook up a "pull allocation" call that fetches each officer's assigned accounts.
- Data is stored unencrypted in the browser's `localStorage`. For real borrower PII, add device-level controls such as MDM or a managed browser, and consider an app PIN.
- Timestamps are device-local and do not include a timezone.
