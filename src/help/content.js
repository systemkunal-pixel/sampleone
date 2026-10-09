// LoanDesk — user manual, how-to guides, routines, troubleshooting and glossary.
// One source for the field app (officers, supervisors) and the admin console.
// Topic bodies are static, trusted HTML written here; never put user data into them.

export const ROLES = { officer: 'Field officer', supervisor: 'Supervisor', admin: 'Admin' };

export const CATEGORIES = [
  { id: 'start', label: 'Getting started' },
  { id: 'howto', label: 'How to' },
  { id: 'routine', label: 'Daily routines & rollout' },
  { id: 'faq', label: 'Troubleshooting' },
  { id: 'glossary', label: 'Glossary' },
];

const ALL = ['officer', 'supervisor', 'admin'];
const FIELD = ['officer', 'supervisor'];

export const TOPICS = [
  // ------------------------------------------------------------------ getting started
  {
    id: 'welcome', category: 'start', audience: ALL,
    title: 'Welcome to LoanDesk',
    summary: 'What the app does and who uses which part.',
    body: `
      <p>LoanDesk helps your team collect overdue loan payments in the field and keeps head office up to date in real time.</p>
      <table class="help-table">
        <tr><th>Who</th><th>Uses</th><th>Main jobs</th></tr>
        <tr><td><b>Field officer</b></td><td>Phone app</td><td>Visit borrowers, collect payments, issue receipts, record bank deposits, log visits and promises to pay.</td></tr>
        <tr><td><b>Supervisor</b></td><td>Phone app</td><td>Check and verify bank deposits recorded in the branch; watch branch accounts.</td></tr>
        <tr><td><b>Admin</b></td><td>Admin console (web)</td><td>Create users, import loans, assign loans to officers, monitor the portfolio, review the audit log.</td></tr>
      </table>
      <p>Everything an officer saves is sent to the server immediately. If there is no signal, the phone keeps it safely and sends it automatically later.</p>`,
  },
  {
    id: 'install-phone', category: 'start', audience: ALL,
    title: 'Install the app on a phone',
    summary: 'Put the app on the home screen of an Android phone or iPhone.',
    steps: [
      'Open the app address your admin gave you (it starts with <b>https://</b>) in <b>Chrome</b> on Android or <b>Safari</b> on iPhone.',
      '<b>Android:</b> tap <b>Install</b> on the green banner on the Today screen, or go to <b>Settings → Install app on this phone</b>. If neither shows, open the browser menu (⋮) and choose <b>Install app</b> / <b>Add to Home screen</b>.',
      '<b>iPhone:</b> tap the Share button <b>⬆</b>, then <b>Add to Home Screen</b>.',
      'Open the app from its new icon. It now opens full-screen like any other app and works without signal.',
      'Allow <b>Location</b> and <b>Camera</b> when asked — they are needed for GPS-stamped receipts and deposit-slip photos.',
    ],
    tips: [
      'The app must be opened over <b>https://</b>. Over plain http the camera, GPS and install do not work.',
      'Settings → App shows whether the app is installed and whether its storage is protected.',
    ],
  },
  {
    id: 'sign-in', category: 'start', audience: FIELD,
    title: 'Sign in and sign out',
    summary: 'Log in with your company code, your code and PIN; when you can and cannot log out.',
    steps: [
      'Enter your <b>company code</b> (for example BRMC — your admin gives it to you). The phone remembers it for next time.',
      'Enter your <b>officer / supervisor code</b> (for example FO27) and your <b>PIN</b>, then tap <b>Log in</b>.',
      'You stay signed in for 30 days on that phone. If your session expires, sign in again — nothing you saved is lost.',
      'To sign out: <b>Settings → Log out</b>.',
    ],
    tips: [
      'You cannot log out while records are still waiting to be sent. Get signal, wait for the header to show <b>● Live</b>, then log out.',
      'Five wrong PINs lock your code for 15 minutes.',
      'Forgot your PIN? Ask your admin to reset it — they will give you a new one.',
      'If the app says <b>“Enter your company code as well”</b>, type the company code: the same officer code exists in another company on LoanDesk.',
    ],
  },
  {
    id: 'screen-tour', category: 'start', audience: FIELD,
    title: 'Find your way around the phone app',
    summary: 'The tabs, the connection badge and the ? help button.',
    body: `
      <h4>Tabs at the bottom</h4>
      <ul>
        <li><b>Today</b> (officers) — your visit plan, today's numbers and any alerts.</li>
        <li><b>Deposits</b> (supervisors) — bank deposits waiting for verification.</li>
        <li><b>Accounts</b> — search every account you can see.</li>
        <li><b>Summary</b> — today's collections and the overdue picture.</li>
        <li><b>Settings</b> — connection, install, help, log out.</li>
      </ul>
      <h4>The badge at the top right</h4>
      <ul>
        <li><b>● Live</b> — connected; everything you save goes to the server at once.</li>
        <li><b>Sending…</b> — records are being sent right now.</li>
        <li><b>Offline · 3 queued</b> — no connection; 3 records are safely stored on the phone and will be sent automatically. Tap it to see details.</li>
      </ul>
      <p>Tap <b>?</b> at the top of any screen to open the guide for that screen.</p>`,
  },
  {
    id: 'admin-first-day', category: 'start', audience: ['admin'],
    title: 'First-day setup for admins',
    summary: 'The order to set things up so officers can start the same day.',
    steps: [
      'Sign in to the admin console with your <b>company code</b>, admin code and password, then <b>change your password</b> (account menu, top right).',
      'Add your <b>supervisors</b> and <b>field officers</b> under <b>Users</b>, each with the correct branch. Write down the PINs the console shows.',
      'Download the <b>Excel template</b> under <b>Import loans</b>, or export your loan system’s file, and <b>import your loans</b>.',
      'Open <b>Loans</b>, filter <b>Unassigned</b>, select them and <b>assign</b> each group to an officer of that branch.',
      'Send each officer the app address, your <b>company code</b>, their code and PIN, and the guide <b>Install the app on a phone</b>.',
      'Check the <b>Dashboard</b> next morning: collections and visits should start appearing.',
    ],
    tips: ['The dashboard shows a <b>Getting started</b> checklist that ticks itself off as you complete these steps.'],
  },

  // ------------------------------------------------------------------ how to: officers
  {
    id: 'plan-day', category: 'howto', audience: ['officer'],
    title: 'Plan your day with the visit plan',
    summary: 'Which borrowers to visit first, and why.',
    body: `
      <p>The <b>Today</b> screen lists every overdue account assigned to you, most urgent first:</p>
      <ol>
        <li><b>PTP due today</b> — the borrower promised to pay today.</li>
        <li><b>Broken PTP</b> — a promised date has passed without payment.</li>
        <li>Follow-ups you scheduled for today or earlier.</li>
        <li>Everyone else, by days past due (DPD) and overdue amount.</li>
      </ol>
      <p>Borrowers whose promise date is still in the future move down the list to give them time. Accounts you visit or collect from today move to <b>Done today</b>.</p>
      <p>Tap <b>📍 Near me</b> to show the distance to each borrower (needs location permission and the borrower’s map location).</p>`,
    tips: ['The four boxes at the top show what you collected today, visits logged, deposits awaiting verification and records not yet sent.'],
  },
  {
    id: 'find-account', category: 'howto', audience: FIELD,
    title: 'Find a borrower’s account',
    summary: 'Search by name, phone, village or loan number.',
    steps: [
      'Open the <b>Accounts</b> tab.',
      'Type part of the name, phone number, village or loan number in the search box.',
      'Use the chips (Current, 1–30 DPD …) to show only one overdue band.',
      'Tap an account to open it: call, WhatsApp or get directions, see dues, history and the repayment schedule.',
    ],
  },
  {
    id: 'collect-payment', category: 'howto', audience: ['officer'],
    title: 'Collect a payment and issue a receipt',
    summary: 'Cash, UPI, cheque or bank transfer collected from the borrower.',
    steps: [
      'Open the borrower’s account and tap <b>Collect payment</b>.',
      'Enter the amount, or tap a quick amount (EMI, overdue, or full outstanding).',
      'Choose the mode. For <b>UPI, Cheque or Bank transfer</b> enter the reference / UTR / cheque number.',
      'Tap <b>Confirm &amp; issue receipt</b> and confirm. The phone records your GPS location.',
      'The receipt opens. <b>✓ Received by server</b> means it is saved at head office; <b>⏳ Saved on this phone</b> means it will be sent automatically when you have signal.',
      'Tap <b>Share / SMS</b> to send the receipt to the borrower, or <b>Print</b>.',
    ],
    tips: [
      'Receipt numbers look like <b>R-FO27-261009-004</b>: your code, the date, and a running number.',
      'You cannot collect more than the total outstanding.',
      'Borrower paid at the bank instead? Use <b>Bank deposit</b> — see “Record a borrower’s bank deposit”.',
    ],
  },
  {
    id: 'record-bank-deposit', category: 'howto', audience: ['officer'],
    title: 'Record a borrower’s bank deposit',
    summary: 'When the borrower paid directly at the bank and shows you the slip.',
    steps: [
      'Open the account → <b>Collect payment</b> → choose <b>Bank deposit</b>.',
      'Tap <b>📷 Take photo or choose file</b> and photograph the pay-in slip (or attach a PDF). Make sure every number is readable.',
      'Enter the <b>amount</b>, the <b>slip / journal number</b>, the <b>bank &amp; branch</b> and the <b>deposit date</b> exactly as printed.',
      'Tap <b>Save deposit &amp; issue acknowledgement</b>. The borrower gets an acknowledgement marked <b>Pending verification</b>.',
      'Your supervisor checks it against the bank. You will see <b>Verified</b> or <b>Rejected</b> (with the reason) on the account.',
    ],
    tips: [
      'The deposit date cannot be in the future or more than 90 days ago.',
      'Each slip number can be used only once. If it was already recorded on another account, the app tells you which one.',
      'A rejected deposit no longer reduces the borrower’s dues — revisit the borrower.',
    ],
  },
  {
    id: 'share-receipt', category: 'howto', audience: ['officer'],
    title: 'Send or reprint a receipt',
    summary: 'Find an old receipt and share it again.',
    steps: [
      'Open the borrower’s account and scroll to <b>History</b>.',
      'Tap the receipt number (it starts with R-).',
      'Tap <b>Share / SMS</b> (WhatsApp, SMS, etc.) or <b>Print</b>.',
    ],
  },
  {
    id: 'log-visit', category: 'howto', audience: ['officer'],
    title: 'Log a visit or a promise to pay',
    summary: 'Record what happened when no money was collected.',
    steps: [
      'Open the account and tap <b>Log visit</b>.',
      'Choose the outcome: <b>Promise to pay</b>, Borrower not available, Door locked, Refused to pay, Disputes the dues, or Shifted / not traceable.',
      'For a <b>Promise to pay</b>, enter the promised date (up to 30 days ahead) and amount.',
      'Optionally set a <b>Next follow-up</b> date and write notes (who you met, what was said).',
      'Tap <b>Save visit</b>.',
    ],
    tips: [
      'Collected money? Use <b>Collect payment</b> instead — it counts as the visit too.',
      'On the promised date the account jumps to the top of your visit plan as <b>PTP due today</b>; if it passes unpaid it shows <b>Broken PTP</b>.',
    ],
  },
  {
    id: 'work-offline', category: 'howto', audience: FIELD,
    title: 'Work without signal',
    summary: 'What happens when the phone or the server is offline.',
    body: `
      <p>You can keep working with no signal — or while the server is down for maintenance:</p>
      <ul>
        <li>Receipts and visits are saved on the phone and the badge shows <b>Offline · N queued</b>.</li>
        <li>As soon as the server is reachable, they are sent automatically, oldest first. You do not need to do anything.</li>
        <li>To send immediately once you have signal: <b>Settings → Send now</b>.</li>
        <li>A record is never counted twice, even if it is sent more than once.</li>
      </ul>
      <p><b>Do not</b> clear the browser’s data or uninstall the app while records are queued — they exist only on the phone until sent.</p>`,
  },
  {
    id: 'fix-rejected', category: 'howto', audience: ['officer'],
    title: 'Fix a record the server did not accept',
    summary: 'Red alerts on the Today screen and what to do about them.',
    body: `
      <h4>“Not accepted by server”</h4>
      <p>Shown when a record you saved was refused, for example a slip number already used, or an amount larger than what is outstanding. The alert shows the reason. Correct the details, record it again, then tap <b>Dismiss</b>.</p>
      <h4>“Bank deposit rejected”</h4>
      <p>Your supervisor could not confirm the deposit. The reason is shown. The amount no longer counts towards the borrower’s dues. Visit the borrower, get the right slip or amount, and record the deposit again (the same slip number can be reused after a rejection).</p>`,
  },
  {
    id: 'end-of-day', category: 'howto', audience: ['officer'],
    title: 'Close your day',
    summary: 'Make sure everything reached head office.',
    steps: [
      'Check the badge shows <b>● Live</b> and the <b>Not sent</b> box on Today shows <b>0</b>. If not, find signal and tap <b>Settings → Send now</b>.',
      'Open <b>Summary</b> to see today’s collections by mode (hand over cash as per your branch rules).',
      'Optional: <b>Export today (CSV)</b> for your own records.',
    ],
  },

  // ------------------------------------------------------------------ how to: supervisors
  {
    id: 'verify-deposit', category: 'howto', audience: ['supervisor', 'admin'],
    title: 'Verify a bank deposit',
    summary: 'Check an officer’s deposit slip against the bank and confirm it.',
    steps: [
      'Open the <b>Deposits</b> tab. <b>Pending</b> shows the oldest first.',
      'Tap a deposit. Tap the slip image to see it full size.',
      'Compare the slip with your bank statement or branch credit: amount, slip / journal number, bank, date and borrower.',
      'Read the warnings, if any: deposited more than 7 days before it was reported, amount more than 3× the EMI, or no GPS location.',
      'If everything matches, tap <b>✓ Verify</b> and confirm.',
    ],
    tips: ['Each deposit can be decided only once. If another supervisor already decided it, the app tells you.'],
  },
  {
    id: 'reject-deposit', category: 'howto', audience: ['supervisor', 'admin'],
    title: 'Reject a bank deposit',
    summary: 'When the slip does not match the bank.',
    steps: [
      'Open the deposit from the <b>Deposits</b> tab.',
      'Type a clear reason, or tap a quick reason (amount does not match, not credited, slip unreadable, another account’s slip).',
      'Tap <b>✕ Reject deposit</b>.',
    ],
    tips: [
      'The officer sees the rejection and your reason on their Today screen; the borrower’s dues go back up.',
      'The slip number becomes free again so the officer can re-enter it correctly.',
    ],
  },
  {
    id: 'branch-view', category: 'howto', audience: ['supervisor'],
    title: 'Watch your branch',
    summary: 'Accounts and summary for the whole branch.',
    body: `
      <ul>
        <li><b>Accounts</b> shows every loan in your branch with its officer; search also matches officer codes.</li>
        <li><b>Summary</b> shows today’s branch collections and how much is overdue in each band.</li>
        <li>Open any account to see its full history, including receipts and visits from every officer.</li>
      </ul>`,
  },

  // ------------------------------------------------------------------ how to: admins
  {
    id: 'read-dashboard', category: 'howto', audience: ['admin'],
    title: 'Read the dashboard',
    summary: 'What each figure means.',
    body: `
      <ul>
        <li><b>Total outstanding</b> — everything still to be repaid on active loans.</li>
        <li><b>Overdue</b> — installments already due but unpaid.</li>
        <li><b>PAR 30</b> — share of the outstanding balance on loans more than 30 days late. Lower is better.</li>
        <li><b>Collected today</b> — receipts recorded today (rejected deposits excluded).</li>
        <li><b>Deposits to verify</b> — bank deposits waiting for supervisors.</li>
        <li><b>Unassigned loans</b> — loans no officer can see yet. Click to assign them.</li>
        <li><b>Portfolio ageing</b> — outstanding by days past due. Click a band to open its loans.</li>
        <li><b>Branches</b> — the same figures per branch. Click a branch to open its loans.</li>
      </ul>`,
  },
  {
    id: 'add-user', category: 'howto', audience: ['admin'],
    title: 'Add a user',
    summary: 'Create a field officer, supervisor or admin.',
    steps: [
      'Open <b>Users</b> → <b>Add user</b>.',
      'Enter a <b>user code</b> (letters and digits, e.g. FO42 — used to sign in; cannot be changed later) and the full name.',
      'Choose the <b>role</b> and type the <b>branch</b> exactly as it appears on the loans.',
      'Enter a PIN (4–8 digits for officers and supervisors) or a password (10+ characters with letters and numbers for admins), or tap <b>Generate</b>.',
      'Tap <b>Create user</b>. The PIN is shown once — give it to the user privately.',
    ],
  },
  {
    id: 'reset-pin', category: 'howto', audience: ['admin'],
    title: 'Reset a forgotten PIN or password',
    summary: 'Give a user a new PIN.',
    steps: [
      'Open <b>Users</b> and find the person.',
      'Click the <b>key</b> icon (Reset PIN).',
      'Keep the generated PIN or type one, then confirm.',
      'Give the new PIN to the user privately. They are signed out on all devices immediately.',
    ],
  },
  {
    id: 'deactivate-user', category: 'howto', audience: ['admin'],
    title: 'Deactivate someone who left',
    summary: 'Block sign-in while keeping all their records.',
    steps: [
      'If they are a field officer, first move their loans: open <b>Loans</b>, filter by their name, select all and assign them to another officer.',
      'Open <b>Users</b>, click the <b>power</b> icon next to the person and confirm.',
      'They are signed out at once and cannot sign in. All their receipts and visits remain.',
    ],
    tips: ['You cannot deactivate yourself, and there must always be at least one active admin.', 'Use the same button to reactivate someone.'],
  },
  {
    id: 'import-loans', category: 'howto', audience: ['admin'],
    title: 'Import loans from Excel, CSV or JSON',
    summary: 'Add new loans or update existing ones from your loan system.',
    steps: [
      'Open <b>Import loans</b>. If this is your first import, click <b>Excel template</b> to see the expected columns.',
      'Drop your file on the upload box or click to choose it (.xlsx, .csv or .json, up to 10 MB / 20,000 loans).',
      'Review the result: rows in file, new loans, updates, warnings and errors. Nothing is saved yet.',
      'Click <b>Import N loans</b> and confirm. Rows with errors are skipped.',
      'Assign any <b>unassigned</b> loans to officers (see “Assign loans to officers”).',
    ],
    tips: [
      'Loans are matched by <b>Loan No</b>: importing the same loan again updates it. Payments and visits are never changed.',
      'Column headings are recognised flexibly (“Loan Account No”, “Customer Name”, “Mobile No” all work).',
      'Dates are read day first: 25-02-2026. Phone numbers lose +91 or a leading 0 automatically.',
      'To give an exact schedule, add an <b>Installments</b> sheet; otherwise it is generated from Tenure, First due date, EMI and Frequency.',
    ],
  },
  {
    id: 'fix-import-errors', category: 'howto', audience: ['admin'],
    title: 'Fix import errors',
    summary: 'Common problems in an import file and how to correct them.',
    body: `
      <p>Click <b>Error report</b> to download every problem with its row number, fix the file, and import it again — rows that were fine are simply updated.</p>
      <table class="help-table">
        <tr><th>Message</th><th>Fix</th></tr>
        <tr><td>Missing required columns</td><td>The first non-empty row of the Loans sheet must be the heading row. Start from the template if unsure.</td></tr>
        <tr><td>Not a valid date</td><td>Use DD-MM-YYYY (day first) or a real Excel date. 31/02 does not exist.</td></tr>
        <tr><td>Not a valid 10-digit mobile number</td><td>Use the borrower’s 10-digit mobile starting with 6–9.</td></tr>
        <tr><td>Officer X does not exist / is deactivated</td><td>Create the officer first, or leave Officer Code blank to import unassigned.</td></tr>
        <tr><td>Officer X belongs to another branch</td><td>Correct the branch or the officer code.</td></tr>
        <tr><td>Duplicate of row N</td><td>The same loan number appears twice in the file. Keep one row.</td></tr>
        <tr><td>Tenure / first due date missing</td><td>Fill both, or give the loan’s rows on an Installments sheet.</td></tr>
      </table>`,
  },
  {
    id: 'assign-loans', category: 'howto', audience: ['admin'],
    title: 'Assign loans to officers',
    summary: 'One at a time or in bulk.',
    steps: [
      'Open <b>Loans</b>. Filter by branch, by <b>Unassigned</b>, by officer or by overdue band.',
      'Tick the loans (or the header box for the whole page; then “Select all N matching” for every page).',
      'In the dark bar, choose the officer and click <b>Assign</b>. Or click <b>Unassign</b>.',
      'For one loan: click the row and change the officer in the panel that opens.',
    ],
    tips: ['Only active officers of the loan’s branch can be chosen.', 'The officer’s phone shows the change within about a minute.'],
  },
  {
    id: 'export-loans', category: 'howto', audience: ['admin'],
    title: 'Export loans to Excel (CSV)',
    summary: 'Download the current list for reporting.',
    steps: [
      'Open <b>Loans</b> and set the filters you want (branch, officer, overdue band, search).',
      'Click <b>Export CSV</b>. The file opens in Excel and includes outstanding, overdue and DPD for each loan.',
    ],
  },
  {
    id: 'audit-log', category: 'howto', audience: ['admin'],
    title: 'Check who did what (audit log)',
    summary: 'Every sign-in, change, import, reassignment and deposit decision.',
    steps: [
      'Open <b>Audit log</b>.',
      'Filter by action (for example “rejected deposit”) or type a user code.',
      'Each line shows when, who, what, and the details of the change.',
    ],
  },
  {
    id: 'change-password', category: 'howto', audience: ['admin'],
    title: 'Change your admin password',
    summary: 'Do this after your first sign-in.',
    steps: [
      'Click your name at the top right → <b>Change password</b>.',
      'Enter your current password and the new one twice (10+ characters, letters and numbers).',
    ],
    tips: ['Admin sessions end after 12 hours or when you close the browser.'],
  },

  // ------------------------------------------------------------------ routines & rollout
  {
    id: 'routine-officer', category: 'routine', audience: ['officer', 'admin'],
    title: 'Field officer daily routine',
    summary: 'A simple rhythm that keeps collections and records up to date.',
    steps: [
      '<b>Morning:</b> open the app while you have Wi-Fi or signal so your list is fresh. Review <b>Today</b>: PTP due today and broken PTPs first.',
      'Use <b>📍 Near me</b> and the order of the list to plan your route.',
      '<b>At each borrower:</b> collect and issue a receipt, or log the visit and any promise to pay. Never leave without recording something.',
      '<b>Bank deposits:</b> photograph the slip clearly and type the numbers exactly as printed.',
      '<b>Evening:</b> check <b>Not sent</b> is 0 and the badge shows <b>● Live</b>. Hand over cash as per branch rules.',
    ],
  },
  {
    id: 'routine-supervisor', category: 'routine', audience: ['supervisor', 'admin'],
    title: 'Supervisor daily routine',
    summary: 'Keep deposits verified the same day.',
    steps: [
      '<b>Morning:</b> clear yesterday’s <b>Pending</b> deposits after checking the bank statement.',
      '<b>During the day:</b> look at deposits marked <b>Check</b> first.',
      '<b>Evening:</b> review branch <b>Summary</b>; follow up officers with broken promises or no visits.',
      'Reject with a clear reason — the officer acts on exactly what you write.',
    ],
  },
  {
    id: 'routine-admin', category: 'routine', audience: ['admin'],
    title: 'Admin weekly routine',
    summary: 'Keep data, users and assignments healthy.',
    steps: [
      'Import the latest loan file from your loan system (new loans and schedule changes).',
      'Assign every <b>Unassigned</b> loan.',
      'Check the <b>Dashboard</b>: PAR 30 trend, branches with high overdue, deposits waiting too long.',
      'Deactivate staff who left (move their loans first); reset PINs on request.',
      'Skim the <b>Audit log</b> for failed sign-ins or unusual rejections.',
    ],
  },
  {
    id: 'rollout-plan', category: 'routine', audience: ['admin'],
    title: 'Rolling the app out to your team',
    summary: 'A two-week plan that gets every officer comfortable quickly.',
    body: `
      <h4>Week 1 — pilot</h4>
      <ol>
        <li>Pick one branch, one supervisor and 2–3 officers.</li>
        <li>Import that branch’s loans and assign them.</li>
        <li>Run a 30-minute session: install the app, sign in, and practise on one real borrower each — a receipt, a visit and a promise to pay.</li>
        <li>Print the officer guides (Help → Print) and give one to each officer.</li>
        <li>Each evening, the supervisor checks Summary and Deposits with the pilot officers.</li>
      </ol>
      <h4>Week 2 — all branches</h4>
      <ol>
        <li>Fix anything the pilot found (import columns, PINs, phones without https access).</li>
        <li>Import all branches and assign loans.</li>
        <li>Train supervisors first; they then train their officers using the printed guides.</li>
        <li>For the first week, ask supervisors to confirm daily that every officer’s <b>Not sent</b> count is 0.</li>
      </ol>
      <h4>Tips for fast adoption</h4>
      <ul>
        <li>Make the app the only way receipts are issued — paper receipts slow adoption.</li>
        <li>Share the dashboard numbers with the team weekly; officers like seeing their collections.</li>
        <li>Point people to the <b>?</b> button on each screen before calling head office.</li>
      </ul>`,
  },

  // ------------------------------------------------------------------ troubleshooting
  {
    id: 'faq-forgot-pin', category: 'faq', audience: ALL,
    title: 'I forgot my PIN or password',
    summary: 'Ask an admin to reset it.',
    body: '<p>Field officers and supervisors: ask your admin to reset your PIN (Users → key icon). Admins: another admin can reset your password; if you are the only admin, the server administrator can run <code>npm run admin -- set-pin --code ADMIN --pin …</code>.</p>',
  },
  {
    id: 'faq-locked', category: 'faq', audience: ALL,
    title: '“Too many wrong attempts”',
    summary: 'Your code is locked for 15 minutes.',
    body: '<p>After 5 wrong PINs or passwords the code is locked for 15 minutes. Wait, then try again — or ask your admin to reset the PIN.</p>',
  },
  {
    id: 'faq-offline', category: 'faq', audience: FIELD,
    title: 'The badge says Offline',
    summary: 'No connection to the server — keep working.',
    body: '<p>You have no signal, or the server is being maintained. Keep working: everything is stored on the phone and sent automatically when the connection returns. If it stays offline for a long time with good signal, tell your admin.</p>',
  },
  {
    id: 'faq-cant-logout', category: 'faq', audience: FIELD,
    title: 'I can’t log out',
    summary: 'Records are still waiting to be sent.',
    body: '<p>Logging out would delete records that have not reached the server yet. Get signal, wait until <b>Not sent</b> is 0 (or tap Settings → Send now), then log out.</p>',
  },
  {
    id: 'faq-amount-exceeds', category: 'faq', audience: ['officer'],
    title: '“Amount exceeds total outstanding”',
    summary: 'You entered more than the borrower owes.',
    body: '<p>The app does not accept more than the loan’s total outstanding. Check the amount. If the borrower’s balance looks wrong, ask your admin to check the loan’s schedule.</p>',
  },
  {
    id: 'faq-duplicate-slip', category: 'faq', audience: ['officer', 'supervisor'],
    title: '“Slip … is already recorded”',
    summary: 'The same bank slip number was entered before.',
    body: '<p>Each slip can be recorded once. The message shows which loan already has it. Check you typed the number correctly. If the earlier entry was wrong, the supervisor can reject it, which frees the slip number.</p>',
  },
  {
    id: 'faq-camera-gps', category: 'faq', audience: FIELD,
    title: 'Camera or location does not work',
    summary: 'Permissions and https.',
    body: '<ul><li>The app must be opened from an <b>https://</b> address.</li><li>Allow camera and location for the app (Android: long-press the app icon → App info → Permissions; iPhone: Settings → Safari → Camera / Location).</li><li>Without location, receipts are still saved — just without GPS.</li></ul>',
  },
  {
    id: 'faq-loan-missing', category: 'faq', audience: ALL,
    title: 'A loan is missing from an officer’s phone',
    summary: 'It is probably not assigned to them.',
    body: '<p>Officers see only loans assigned to them. In the admin console open <b>Loans</b>, search for the loan and check the officer. After assigning, the phone shows it within a minute (or tap Settings → Refresh from server).</p>',
  },
  {
    id: 'loandesk-support', category: 'faq', audience: ['admin'],
    title: 'When LoanDesk support works in your account',
    summary: 'The red support banner, what support can do, and how it is recorded.',
    body: `
      <p>If you ask LoanDesk for help, a support person may open your admin console to look at the problem with you.</p>
      <ul>
        <li>While they are inside, a <b>red striped banner</b> runs along the bottom of their screen. Each visit lasts at most 45 minutes.</li>
        <li>They act as <b>SUPPORT</b>. Every change they make appears in your <b>Audit log</b> under the code SUPPORT, with the support person’s name.</li>
        <li>Support never needs your password and never asks for it. Don’t share passwords or PINs with anyone, including LoanDesk.</li>
      </ul>`,
  },
  {
    id: 'faq-not-in-plan', category: 'faq', audience: ALL,
    title: '“This feature isn’t included in your plan”',
    summary: 'Some features depend on your company’s LoanDesk plan.',
    body: `<p>Bank deposits, CSV export, the audit log screen and loan import can be switched on or off for your company by LoanDesk,
      depending on your plan. When a feature is off its button or menu item is hidden. To get it, contact LoanDesk to change your plan.
      The plan also sets how many field officers can be active at once.</p>`,
  },
  {
    id: 'faq-session-expired', category: 'faq', audience: ALL,
    title: '“Your session has expired”',
    summary: 'Sign in again — nothing is lost.',
    body: '<p>Sessions last 30 days on phones and 12 hours in the admin console, and end when a PIN is reset, a user is deactivated, or LoanDesk locks your company’s sign-in. Sign in again; records saved on the phone are kept and sent after you sign in. If sign-in says your company is locked, your admin should contact LoanDesk.</p>',
  },
  {
    id: 'faq-import-headings', category: 'faq', audience: ['admin'],
    title: 'The import does not recognise my column names',
    summary: 'Rename the headings or ask for them to be added.',
    body: '<p>Rename the heading in your file to the template’s name (for example “Loan No”, “Borrower Name”, “Phone”), or send the heading to your technical contact — new names can be added to the import in one place.</p>',
  },

  // ------------------------------------------------------------------ glossary
  {
    id: 'glossary', category: 'glossary', audience: ALL,
    title: 'Glossary',
    summary: 'Terms used in the app.',
    body: `
      <dl class="help-dl">
        <dt>EMI</dt><dd>Equated monthly (or weekly) installment — the regular repayment amount.</dd>
        <dt>Outstanding</dt><dd>Everything the borrower still has to repay, due or not.</dd>
        <dt>Overdue</dt><dd>Installments already due but not yet paid.</dd>
        <dt>DPD</dt><dd>Days past due — days since the oldest unpaid installment fell due.</dd>
        <dt>Overdue bands</dt><dd>Current, 1–30, 31–60, 61–90 and 90+ DPD.</dd>
        <dt>NPA</dt><dd>Non-performing asset — a loan more than 90 days past due.</dd>
        <dt>PAR 30</dt><dd>Portfolio at risk: share of the outstanding balance on loans more than 30 days late.</dd>
        <dt>PTP</dt><dd>Promise to pay — the date and amount a borrower promised.</dd>
        <dt>Broken PTP</dt><dd>A promise whose date has passed without the promised payment.</dd>
        <dt>Receipt</dt><dd>Proof of money collected by the officer (cash, UPI, cheque, transfer).</dd>
        <dt>Acknowledgement</dt><dd>Given for a bank deposit; final only after the supervisor verifies it.</dd>
        <dt>Queued / Not sent</dt><dd>Saved on the phone, waiting for a connection to reach the server.</dd>
        <dt>Unassigned loan</dt><dd>A loan with no officer; no officer sees it until an admin assigns it.</dd>
      </dl>`,
  },
];

// ------------------------------------------------------------------ translations
// src/help/i18n/<lang>.js exports { labels: { Tips, categories: {id: label}, roles: {role: label} },
// topics: { id: { title, summary, steps?, tips?, body? } } }. Anything missing falls back to English.

let local = null;

/** Loads the help text for a language ('en' = the English above). */
export async function loadHelpLang(code) {
  local = null;
  if (!code || code === 'en') return;
  try {
    local = (await import(`./i18n/${code}.js`)).default;
  } catch {
    local = null;
  }
}

const localize = (t) => (t && local?.topics?.[t.id] ? { ...t, ...local.topics[t.id] } : t);
export const categoryLabel = (c) => local?.labels?.categories?.[c.id] || c.label;
export const roleLabel = (r) => local?.labels?.roles?.[r] || ROLES[r] || r;

/** Topics for a role, optionally filtered by a search phrase (matches the translation and the English). */
export function topicsFor(role, query = '') {
  const q = query.trim().toLowerCase();
  const text = (t) => `${t.title} ${t.summary} ${(t.steps || []).join(' ')} ${(t.tips || []).join(' ')} ${t.body || ''}`;
  return TOPICS.filter((t) => !role || t.audience.includes(role)).filter((t) => {
    if (!q) return true;
    const hay = `${text(t)} ${text(localize(t))}`.replace(/<[^>]+>/g, ' ').toLowerCase();
    return q.split(/\s+/).every((w) => hay.includes(w));
  }).map(localize);
}

export const topicById = (id) => localize(TOPICS.find((t) => t.id === id));

/** The full HTML of a topic (steps, body, tips). */
export function topicHtml(t) {
  return `
    ${t.body || ''}
    ${t.steps ? `<ol class="help-steps">${t.steps.map((s) => `<li>${s}</li>`).join('')}</ol>` : ''}
    ${t.tips ? `<div class="help-tips"><b>${local?.labels?.Tips || 'Tips'}</b><ul>${t.tips.map((s) => `<li>${s}</li>`).join('')}</ul></div>` : ''}`;
}
