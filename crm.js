// InnoPlot Library CRM: Supabase auth + contacts dashboard.
// Data access is enforced server-side by row-level security (supabase/schema.sql);
// this file only decides what to show.
const cfg = window.INNOPLOT_CONFIG || {};
const $ = s => document.querySelector(s);
const STATUSES = ['new', 'contacted', 'qualified', 'customer', 'archived'];
const VIEWS = ['setup', 'login', 'reset', 'denied', 'app'];

let sb, contacts = [], openId = null, sortKey = 'last_seen_at', sortDir = -1;

// ------------------------------------------------------------------ helpers

const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => d ? new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '';
const fmtDateTime = d => d ? new Date(d).toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const uniqueResources = c => [...new Set(c.downloads.map(d => d.resource))];

function show(view) { VIEWS.forEach(v => { $('#view-' + v).hidden = v !== view; }); }

function message(el, text, kind) {
  el.textContent = text; el.className = 'msg ' + kind; el.hidden = !text;
}

function toast(text) {
  const t = $('#toast'); t.textContent = text; t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 2600);
}

// ------------------------------------------------------------------ auth

async function init() {
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) { show('setup'); return; }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  sb.auth.onAuthStateChange(event => {
    if (event === 'PASSWORD_RECOVERY') show('reset');
    if (event === 'SIGNED_OUT') { contacts = []; show('login'); }
  });

  // A reset-password link lands here with type=recovery in the URL hash.
  if (location.hash.includes('type=recovery')) { show('reset'); return; }

  const { data: { session } } = await sb.auth.getSession();
  session ? enter(session) : show('login');
}

async function enter(session) {
  const { data: isAdmin, error } = await sb.rpc('is_crm_admin');
  if (error || !isAdmin) { show('denied'); return; }
  $('#who').textContent = session.user.email;
  show('app');
  load();
}

$('#login-form').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#login-msg'); message(msg, '', 'err');
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({
    email: $('#l-email').value.trim(), password: $('#l-pass').value
  });
  btn.disabled = false;
  if (error) { message(msg, 'Incorrect email or password.', 'err'); return; }
  $('#l-pass').value = '';
  enter(data.session);
});

$('#forgot').addEventListener('click', async () => {
  const msg = $('#login-msg'), email = $('#l-email').value.trim();
  if (!email) { message(msg, 'Enter your email address first.', 'err'); return; }
  await sb.auth.resetPasswordForEmail(email, { redirectTo: location.origin + location.pathname });
  message(msg, 'If this address has access, a reset link is on its way.', 'ok');
});

$('#reset-form').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#reset-msg');
  const { data, error } = await sb.auth.updateUser({ password: $('#r-pass').value });
  if (error) { message(msg, error.message, 'err'); return; }
  history.replaceState(null, '', location.pathname);
  const { data: { session } } = await sb.auth.getSession();
  session ? enter(session) : show('login');
});

document.querySelectorAll('[data-signout]').forEach(b =>
  b.addEventListener('click', () => sb.auth.signOut()));

// ------------------------------------------------------------------ data

async function load() {
  const { data, error } = await sb.from('contacts')
    .select('id,email,name,company,status,notes,first_seen_at,last_seen_at,downloads(resource,source_page,created_at)')
    .order('last_seen_at', { ascending: false });
  if (error) { toast('Could not load contacts: ' + error.message); return; }
  contacts = data.map(c => ({
    ...c, downloads: (c.downloads || []).sort((a, b) => b.created_at.localeCompare(a.created_at))
  }));
  fillResourceFilter();
  renderStats();
  render();
}

async function saveContact(id, patch) {
  const { error } = await sb.from('contacts').update(patch).eq('id', id);
  if (error) { toast('Save failed: ' + error.message); return false; }
  Object.assign(contacts.find(c => c.id === id), patch);
  return true;
}

// ------------------------------------------------------------------ rendering

function renderStats() {
  const weekAgo = Date.now() - 7 * 864e5;
  const downloads = contacts.flatMap(c => c.downloads);
  $('#st-total').textContent = contacts.length;
  $('#st-week').textContent = contacts.filter(c => new Date(c.first_seen_at) > weekAgo).length;
  $('#st-dl').textContent = downloads.length;
  $('#st-new').textContent = contacts.filter(c => c.status === 'new').length;

  const counts = {};
  downloads.forEach(d => { counts[d.resource] = (counts[d.resource] || 0) + 1; });
  const rows = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  const max = rows[0] ? rows[0][1] : 1;
  $('#bars').innerHTML = rows.length ? rows.map(([name, n]) => `
    <div class="bar-row">
      <span class="name" title="${esc(name)}">${esc(name)}</span>
      <div class="bar-track"><div class="bar-fill" style="width:${(n / max * 100).toFixed(1)}%"></div></div>
      <span class="n">${n}</span>
    </div>`).join('') : '<div class="empty">No downloads yet.</div>';
}

function fillResourceFilter() {
  const sel = $('#f-res'), current = sel.value;
  const all = [...new Set(contacts.flatMap(uniqueResources))].sort();
  sel.innerHTML = '<option value="">All resources</option>' +
    all.map(r => `<option value="${esc(r)}">${esc(r)}</option>`).join('');
  if (all.includes(current)) sel.value = current;
}

function filtered() {
  const q = $('#q').value.trim().toLowerCase();
  const st = $('#f-status').value, res = $('#f-res').value;
  return contacts
    .filter(c => !st || c.status === st)
    .filter(c => !res || c.downloads.some(d => d.resource === res))
    .filter(c => !q || [c.email, c.name, c.company, c.notes].some(v => (v || '').toLowerCase().includes(q)))
    .sort((a, b) => String(a[sortKey] ?? '').localeCompare(String(b[sortKey] ?? '')) * sortDir);
}

function statusSelect(c) {
  return `<select class="status s-${esc(c.status)}" data-id="${esc(c.id)}" aria-label="Status">` +
    STATUSES.map(s => `<option value="${s}"${s === c.status ? ' selected' : ''}>${cap(s)}</option>`).join('') +
    '</select>';
}

function render() {
  const list = filtered();
  $('#count').textContent = `${list.length} of ${contacts.length} contacts`;
  $('#empty').hidden = list.length > 0;
  $('#rows').innerHTML = list.map(c => `
    <tr data-id="${esc(c.id)}">
      <td><div class="em">${esc(c.email)}</div>${c.name || c.company
        ? `<div class="sub">${esc([c.name, c.company].filter(Boolean).join(' · '))}</div>` : ''}</td>
      <td>${statusSelect(c)}</td>
      <td><div class="chips">${uniqueResources(c).map(r => `<span class="chip-s">${esc(r)}</span>`).join('')}</div></td>
      <td>${fmtDate(c.first_seen_at)}</td>
      <td>${fmtDate(c.last_seen_at)}</td>
    </tr>`).join('');
  document.querySelectorAll('th[data-sort]').forEach(th => {
    th.querySelector('.arr').textContent = th.dataset.sort === sortKey ? (sortDir > 0 ? '↑' : '↓') : '';
  });
}

// ------------------------------------------------------------------ table interactions

$('#f-status').innerHTML += STATUSES.map(s => `<option value="${s}">${cap(s)}</option>`).join('');
['#q', '#f-status', '#f-res'].forEach(s => $(s).addEventListener('input', render));
$('#refresh').addEventListener('click', load);

document.querySelectorAll('th[data-sort]').forEach(th => th.addEventListener('click', () => {
  if (sortKey === th.dataset.sort) sortDir *= -1;
  else { sortKey = th.dataset.sort; sortDir = sortKey.endsWith('_at') ? -1 : 1; }
  render();
}));

$('#rows').addEventListener('change', async e => {
  if (!e.target.matches('select.status')) return;
  const sel = e.target, id = sel.dataset.id, prev = contacts.find(c => c.id === id).status;
  sel.className = 'status s-' + sel.value;
  if (await saveContact(id, { status: sel.value })) { renderStats(); toast('Status updated'); }
  else { sel.value = prev; sel.className = 'status s-' + prev; }
});

$('#rows').addEventListener('click', e => {
  if (e.target.closest('select')) return;
  const tr = e.target.closest('tr[data-id]');
  if (tr) openDrawer(tr.dataset.id);
});

// ------------------------------------------------------------------ drawer

$('#d-status').innerHTML = STATUSES.map(s => `<option value="${s}">${cap(s)}</option>`).join('');

function openDrawer(id) {
  const c = contacts.find(x => x.id === id); if (!c) return;
  openId = id;
  $('#d-email').textContent = c.email;
  $('#d-meta').textContent = `First seen ${fmtDate(c.first_seen_at)} · ${c.downloads.length} download${c.downloads.length === 1 ? '' : 's'}`;
  $('#d-name').value = c.name || '';
  $('#d-company').value = c.company || '';
  $('#d-status').value = c.status;
  $('#d-notes').value = c.notes || '';
  $('#d-hist').innerHTML = c.downloads.map(d =>
    `<li><span>${esc(d.resource)}</span><time>${fmtDateTime(d.created_at)}</time></li>`).join('');
  $('#drawer').classList.add('open'); $('#scrim').classList.add('open');
}

function closeDrawer() {
  openId = null;
  $('#drawer').classList.remove('open'); $('#scrim').classList.remove('open');
}

$('#d-close').addEventListener('click', closeDrawer);
$('#scrim').addEventListener('click', closeDrawer);
document.addEventListener('keydown', e => { if (e.key === 'Escape' && openId) closeDrawer(); });

$('#d-form').addEventListener('submit', async e => {
  e.preventDefault();
  const patch = {
    name: $('#d-name').value.trim() || null,
    company: $('#d-company').value.trim() || null,
    status: $('#d-status').value,
    notes: $('#d-notes').value.trim() || null
  };
  if (await saveContact(openId, patch)) { renderStats(); render(); closeDrawer(); toast('Contact saved'); }
});

$('#d-delete').addEventListener('click', async () => {
  const c = contacts.find(x => x.id === openId);
  if (!c || !confirm(`Delete ${c.email} and their download history? This cannot be undone.`)) return;
  const { error } = await sb.from('contacts').delete().eq('id', c.id);
  if (error) { toast('Delete failed: ' + error.message); return; }
  contacts = contacts.filter(x => x.id !== c.id);
  closeDrawer(); fillResourceFilter(); renderStats(); render(); toast('Contact deleted');
});

// ------------------------------------------------------------------ CSV export

$('#export').addEventListener('click', () => {
  // Prefix cells that start with = + - @ so spreadsheet apps don't run them as formulas.
  const cell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@]/.test(s)) s = "'" + s;
    return '"' + s.replace(/"/g, '""') + '"';
  };
  const header = ['Email', 'Name', 'Company', 'Status', 'First seen', 'Last activity', 'Downloads', 'Resources', 'Notes'];
  const lines = filtered().map(c => [
    c.email, c.name, c.company, c.status, c.first_seen_at, c.last_seen_at,
    c.downloads.length, uniqueResources(c).join('; '), c.notes
  ].map(cell).join(','));
  const blob = new Blob(['﻿' + [header.map(cell).join(','), ...lines].join('\r\n')], { type: 'text/csv;charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `innoplot-library-contacts-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

init();
