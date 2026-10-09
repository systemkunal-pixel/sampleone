import { api } from '../api.js';
import { esc, icon, num, dateTime, ago, toast, dialog, confirmDialog, emptyState } from '../../../admin/js/ui.js';
import { route } from '../main.js';

const STATUS = {
  staged: ['Waiting for the agent', 'info'], applying: ['Installing…', 'warn'], applied: ['Applied', 'ok'],
  rolled_back: ['Rolled back', 'warn'], failed: ['Failed', 'bad'], cancelled: ['Cancelled', ''],
};
const statusBadge = (s) => `<span class="badge ${STATUS[s]?.[1] ?? ''}">${STATUS[s]?.[0] || esc(s)}</span>`;
const OUTCOME = { ok: 'ok', refused: 'bad', failed: 'bad', started: 'warn' };
const gb = (n) => `${(n / 1024 ** 3).toFixed(1)} GB`;

let verified = null; // { sha256, fileName, summary } of the last package that passed Verify
let poll = null;

export async function render(el, query, rest, alive) {
  clearTimeout(poll);
  const data = await api('updates');
  const d = data.diagnostics;
  const active = data.active;
  const busy = d.activity.officers15m > 0;
  if (verified && verified.summary.version === d.version) verified = null;

  el.innerHTML = `
    <div class="page-head">
      <div><h1>Update &amp; diagnostics</h1><p>What this server is running, and how to move it to a newer build.</p></div>
    </div>
    <div class="grid two" style="grid-template-columns:1fr 1fr">
      <div class="card">
        <div class="card-head"><h2>${icon('refresh')} Server diagnostics</h2></div>
        <div class="card-body"><dl class="dl keep">
          <dt>Version</dt><dd><b style="font-size:1.1rem">${esc(d.version)}</b>${d.processVersion !== d.version ? ` <span class="badge warn">server still runs ${esc(d.processVersion)}</span>` : ''}</dd>
          <dt>Deployed</dt><dd>${d.deployedAt ? esc(dateTime(d.deployedAt)) : '<span class="muted">by installer</span>'}</dd>
          <dt>Server started</dt><dd>${esc(dateTime(d.startedAt))}</dd>
          <dt>Environment</dt><dd>${esc(d.environment)}</dd>
          <dt>Database</dt><dd>${esc(d.database)}</dd>
          <dt>Node.js</dt><dd>${esc(d.node)}</dd>
          <dt>Server time</dt><dd>${esc(dateTime(d.serverTime))} <span class="muted small">${esc(d.timezone)}</span></dd>
          <dt>Free disk</dt><dd>${d.disk ? `${gb(d.disk.free)} of ${gb(d.disk.total)} · ${Math.round((d.disk.free / d.disk.total) * 100)}% free` : '—'}</dd>
          <dt>Deposits to verify</dt><dd>${num(d.activity.pendingDeposits)}</dd>
          <dt>Updater agent</dt><dd>${d.agent ? (d.agent.live ? `<span class="badge ok">running</span> <span class="muted small">seen ${esc(ago(d.agent.seenAt))}</span>` : `<span class="badge bad">not running</span> <span class="muted small">last seen ${esc(ago(d.agent.seenAt))}</span>`) : '<span class="badge bad">never seen</span> <span class="muted small">re-run the installer</span>'}</dd>
          <dt>Signing key</dt><dd>${d.signingKey.configured ? `<span class="badge ok">set</span> <code>${esc(d.signingKey.fingerprint)}</code>` : `<span class="badge bad">not set</span> <span class="muted small">${esc(d.signingKey.error || 'add UPDATE_PUBLIC_KEY to .env')}</span>`}</dd>
        </dl></div>
      </div>
      <div class="card">
        <div class="card-head"><h2>${icon('shield')} Signed update</h2></div>
        <div class="card-body stack">
          <p class="muted small" style="margin:0">Upload a signed <code>.ldpatch</code>. <b>Verify</b> only inspects it. <b>Stage</b> hands it to the updater agent, which takes the site offline for a minute, swaps the files and puts the previous build back automatically if the new one doesn't come up healthy.</p>
          ${active ? `
            <div class="info-box"><b>${active.status === 'applying' ? 'Installing' : 'Staged'}: ${esc(active.from_version)} → ${esc(active.to_version)}</b>
              <div class="small">${esc(active.file_name)} · staged by ${esc(active.staged_by)} ${esc(ago(active.staged_at))}</div>
              ${active.status === 'staged' ? `<div style="margin-top:8px"><button class="btn sm danger-ghost" data-cancel="${active.id}">Cancel</button>
                ${d.agent?.live ? '' : '<span class="small" style="color:var(--bad)"> The updater agent is not running, so nothing will happen.</span>'}</div>` : '<div class="small">Don\'t restart the server now.</div>'}
            </div>` : `
            <label class="drop" id="drop">
              <input type="file" accept=".ldpatch" hidden id="file">
              ${icon('upload')}<b>Drop the package here</b><span class="muted small">or click to choose a .ldpatch file</span>
              <span class="small" id="file-name">${verified ? esc(verified.fileName) : 'No file selected'}</span>
            </label>
            <div class="row-actions" style="justify-content:flex-start;gap:8px;flex-wrap:wrap">
              <button class="btn" id="verify" ${d.signingKey.configured ? '' : 'disabled'}>${icon('check')} Verify</button>
              <button class="btn primary" id="stage" ${verified ? '' : 'disabled'}>${icon('upload')} Stage &amp; queue update</button>
              <span class="muted small">${verified ? `Verified: ${esc(verified.summary.from)} → <b>${esc(verified.summary.version)}</b>` : 'Verify first'}</span>
            </div>
            ${verified ? `<div class="small muted">${num(verified.summary.files)} files, ${num(verified.summary.changed)} changed${verified.summary.removed ? `, ${num(verified.summary.removed)} removed` : ''} ·
              ${verified.summary.schemaChanges ? '<b>changes the database</b> (backed up first)' : 'no database changes'}${verified.summary.dependencyChanges ? ' · installs new packages' : ''}
              ${verified.summary.notes ? `<div>${esc(verified.summary.notes)}</div>` : ''}</div>` : ''}`}
          ${busy ? `<div class="warn-box small"><b>Field staff are working right now:</b> ${num(d.activity.officers15m)} officer(s) sent ${num(d.activity.records15m)} record(s) in the last 15 minutes. Phones keep working offline during the restart and send everything afterwards, but the admin console is unavailable for a minute.</div>` : ''}
          ${data.history[0] ? `<div class="small"><b>Last update:</b> ${statusBadge(data.history[0].status)} ${esc(data.history[0].detail || '')}</div>` : ''}
        </div>
      </div>
    </div>

    <details class="card" style="margin-top:16px"><summary class="card-head" style="cursor:pointer"><h2>${icon('help')} How updating works, and what happens when a build is bad</h2></summary>
      <div class="card-body guide">
        <ol>
          <li><b>Build</b> on the release PC: <code>node scripts/patch.js build</code> makes <code>loandesk-&lt;version&gt;.ldpatch</code>, signed with the private key that only that PC holds.</li>
          <li><b>Verify</b> here checks the signature against this server's <code>UPDATE_PUBLIC_KEY</code>, that it is LoanDesk and newer than ${esc(d.version)}, and every file's checksum. Nothing is written to the app.</li>
          <li><b>Stage</b> asks you to type the version, then queues it. Within 10 seconds the updater agent backs up the code (and the database if the update changes it), stops the site, installs, and starts the new version.</li>
          <li>If the new version doesn't answer as healthy within two minutes, the agent puts back the old files and database and starts the old version. The history below says <b>Rolled back</b> and why.</li>
        </ol>
        <p>Only <code>server/</code>, <code>src/</code>, <code>scripts/</code>, <code>deploy/</code> and the package files are replaced. <code>.env</code>, logs, backups and data are never touched. The last five backups are kept in the <code>backups</code> folder.</p>
      </div>
    </details>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><div><h2>Update history</h2></div></div>
      ${data.history.length ? `<div class="table-wrap"><table class="data responsive">
        <thead><tr><th>When</th><th>Change</th><th>By</th><th>Outcome</th><th>Detail</th></tr></thead>
        <tbody>${data.history.map((h) => `<tr>
          <td class="primary nowrap">${esc(dateTime(h.finished_at || h.staged_at))}</td>
          <td data-label="Change" class="nowrap">${esc(h.from_version)} → <b>${esc(h.to_version)}</b></td>
          <td data-label="By">${esc(h.staged_by)}</td>
          <td data-label="Outcome">${statusBadge(h.status)}</td>
          <td data-label="Detail" class="small">${esc(h.detail || '')}</td></tr>`).join('')}</tbody></table></div>`
        : emptyState('No updates yet', 'Updates installed from this screen are listed here.', 'refresh')}
    </div>

    <div class="card" style="margin-top:16px">
      <div class="card-head"><div><h2>Activity</h2><p>Every press on this screen and every step of the agent, newest first.</p></div></div>
      ${data.events.length ? `<div class="table-wrap"><table class="data responsive">
        <thead><tr><th>When</th><th>Action</th><th>By</th><th>Detail</th></tr></thead>
        <tbody>${data.events.map((e) => `<tr>
          <td class="primary nowrap">${esc(dateTime(e.at))}</td>
          <td data-label="Action"><span class="badge ${OUTCOME[e.outcome] || ''}">${esc(e.action)} · ${esc(e.outcome)}</span></td>
          <td data-label="By">${esc(e.actor)}</td>
          <td data-label="Detail" class="small">${esc(e.detail || '')}${e.file_name ? `<div class="cell-sub">${esc(e.file_name)}${e.size ? ` · ${(e.size / 1024 / 1024).toFixed(1)} MB` : ''}</div>` : ''}</td></tr>`).join('')}</tbody></table></div>`
        : emptyState('Nothing yet', '', 'audit')}
    </div>`;

  // Keep the page live while an update is queued or running.
  if (active) poll = setTimeout(() => alive() && location.hash.startsWith('#/updates') && route(), 4000);

  let file = null;
  const pick = (f) => {
    file = f;
    verified = null;
    el.querySelector('#file-name').textContent = f ? `${f.name} · ${(f.size / 1024 / 1024).toFixed(1)} MB` : 'No file selected';
    el.querySelector('#stage').disabled = true;
  };
  const drop = el.querySelector('#drop');
  if (drop) {
    el.querySelector('#file').onchange = (e) => pick(e.target.files[0]);
    drop.ondragover = (e) => {
      e.preventDefault();
      drop.classList.add('over');
    };
    drop.ondragleave = () => drop.classList.remove('over');
    drop.ondrop = (e) => {
      e.preventDefault();
      drop.classList.remove('over');
      pick(e.dataTransfer.files[0]);
    };
  }

  el.onclick = async (e) => {
    if (e.target.closest('#verify')) {
      if (!file) return toast('Choose a .ldpatch file first.', 'bad');
      const btn = e.target.closest('#verify');
      btn.disabled = true;
      btn.textContent = 'Checking…';
      try {
        const base64 = await new Promise((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1]);
          r.onerror = () => reject(new Error('Could not read the file.'));
          r.readAsDataURL(file);
        });
        verified = await api('updates/verify', { method: 'POST', body: { fileName: file.name, base64 } });
        toast(`Package OK: ${verified.summary.version}`);
      } catch (err) {
        toast(err.message, 'bad');
      }
      return route();
    }
    if (e.target.closest('#stage') && verified) {
      const v = verified.summary.version;
      const done = await dialog({
        title: `Install ${esc(v)}?`,
        ok: 'Stage update',
        danger: true,
        body: `<div class="form"><p style="margin:0">The site goes offline for about a minute while the agent installs ${esc(verified.summary.from)} → <b>${esc(v)}</b>.
          ${verified.summary.schemaChanges ? 'The database is backed up first because this update changes it.' : ''} If the new version isn't healthy it is rolled back automatically.</p>
          <label class="field"><span>Type <b>${esc(v)}</b> to confirm</span><input class="input" name="confirm" required autocomplete="off" autofocus></label></div>`,
        onOk: (f) => api('updates/stage', { method: 'POST', body: { sha256: verified.sha256, fileName: verified.fileName, confirm: f.confirm } }),
      });
      if (done) {
        verified = null;
        toast('Update staged. The agent starts within 10 seconds.');
        route();
      }
      return;
    }
    const cancel = e.target.closest('[data-cancel]');
    if (cancel && (await confirmDialog('Cancel this update?', 'The package stays verified on the server; nothing is installed.', 'Cancel update', true))) {
      try {
        await api(`updates/${cancel.dataset.cancel}/cancel`, { method: 'POST' });
        toast('Update cancelled');
      } catch (err) {
        toast(err.message, 'bad');
      }
      route();
    }
  };
}
