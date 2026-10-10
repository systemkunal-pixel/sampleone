// The overlord's own short manual. Company staff have their help inside their apps.
export async function render(el) {
  el.innerHTML = `
    <div class="page-head"><div><h1>Overlord guide</h1><p>How to run LoanDesk for many lending companies, safely.</p></div></div>
    <div class="card"><div class="card-body guide">
      <h2>What the overlord is</h2>
      <p>The platform operator's console. Each lending company on LoanDesk is a separate <b>company</b> (workspace) with its own admins,
        supervisors, officers, loans and audit trail; nobody in one company can see another. The overlord sits above all of them:
        it sees every company's figures, decides what each may use, and can enter one to help — always logged.</p>

      <h2>Signing in</h2>
      <ol>
        <li>Open <code>/overlord/</code>, enter your email and password.</li>
        <li>First time: scan the QR code with Google Authenticator, Microsoft Authenticator or Authy, then type the 6-digit code.</li>
        <li>Every later sign-in asks for the current code from that app.</li>
      </ol>
      <p>You're signed out after 60 minutes without activity, after 12 hours in any case, and when the browser closes.
        Lost your phone? Another overlord can use <b>Reset authenticator</b>, or on the server run
        <code>npm run admin -- overlord-reset-2fa --email you@example.com</code>.</p>

      <h2>Adding a new lending company</h2>
      <ol>
        <li><b>Companies → New company</b>. Pick a short <b>company code</b> (e.g. <code>SANJIVANI</code>), the company's name inside LoanDesk.</li>
        <li>Choose the plan and create the first admin. Send the company code, admin code and password to the customer privately.</li>
        <li>Their admin signs in at <code>/admin/</code>, adds staff and imports loans. Officers sign in to the phone app with their code and PIN. User codes are unique across all of LoanDesk, so nobody types a company code.</li>
      </ol>

      <h2>Helping a customer: support access</h2>
      <ol>
        <li>Open the company and choose <b>Enter as support</b>. Type the reason — it's kept for good.</li>
        <li>Their admin console opens in a new tab with a red banner. You act as <b>LoanDesk support</b>; every change is recorded under your name in their audit log.</li>
        <li>The session ends after 45 minutes, when you press <b>Exit</b> on the banner, or when you end it from <b>Support sessions</b>.</li>
      </ol>

      <h2>Lock, archive, reopen</h2>
      <ul>
        <li><b>Lock sign-in</b> — for unpaid invoices or a security concern. Everyone is signed out; data is untouched; support can still enter.</li>
        <li><b>Archive</b> — the customer has left. Off the overview and figures, sign-in refused, nothing deleted.</li>
        <li><b>Unlock / Reopen</b> — one click; staff can sign in again at once.</li>
      </ul>
      <p>A reason is required for locking and archiving and is shown on the company page.</p>

      <h2>Plans and features</h2>
      <p><b>Plans &amp; features</b> holds the matrix: what Regular, Pro and Enterprise include and their field-officer limits.
        Saving a plan changes every company on it immediately. A per-company override forces one feature on or off for one customer
        (a trial, a special deal) and survives plan changes. When a feature is off, its menu items disappear for that company and the
        server refuses it.</p>

      <h2>Updating LoanDesk</h2>
      <ol>
        <li>On the release PC (once): <code>node scripts/patch.js keygen</code>, then put the printed <code>UPDATE_PUBLIC_KEY=…</code> line in the server's <code>.env</code> and restart LoanDesk.</li>
        <li>For each release: raise the version in <code>package.json</code>, run <code>node scripts/patch.js build</code>.</li>
        <li><b>Update &amp; diagnostics</b> → choose the <code>.ldpatch</code> → <b>Verify</b> → <b>Stage</b> (type the version). The updater agent backs up, installs and checks the new version; if it isn't healthy it puts the old one back by itself.</li>
      </ol>
      <p>Prefer a quiet time: the site is offline for about a minute. Phones keep working offline and send their records afterwards.</p>

      <h2>Accountability</h2>
      <ul>
        <li><b>Support sessions</b> — every entry: who, which company, reason, start, end, IP and what was changed.</li>
        <li><b>Overlord audit log</b> — every action in this console, including failed sign-ins.</li>
        <li><b>Overlord accounts</b> — keep the list short; deactivate people the day they leave.</li>
      </ul>

      <h2>Server commands</h2>
      <p>On the server, in the LoanDesk folder:</p>
      <ul>
        <li><code>npm run admin -- add-overlord --email you@example.com --name "Your Name" --password "…"</code> — first overlord.</li>
        <li><code>npm run admin -- overlord-password --email … --password "…"</code> — forgotten password.</li>
        <li><code>npm run admin -- list-companies</code>, <code>list-overlords</code>.</li>
      </ul>
    </div></div>`;
}
