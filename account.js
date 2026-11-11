// InnoPlot Library: visitor accounts ("My library").
// Row-level security (supabase/schema.sql) limits each visitor to their own rows.
const cfg = window.INNOPLOT_CONFIG || {};
const $ = s => document.querySelector(s);
const VIEWS = ['setup', 'signin', 'signup', 'check', 'reset', 'app'];
const PDF_PATH = /^assets\/whitepapers\/[\w.-]+\.pdf$/;
const ORDER_STATUS = { paid: 'Paid · being prepared', shipped: 'Shipped', cancelled: 'Cancelled' };

let sb, enteredAs = null;

// Pages that send visitors here to sign in, and where to send them back afterwards.
const RETURN_TO = { toolkit: 'toolkit.html' };
const NEXT_KEY = 'innoplot-next', NEXT_TTL = 60 * 60 * 1000;
function rememberNext(next) {
  if (!RETURN_TO[next]) return;
  try { localStorage.setItem(NEXT_KEY, JSON.stringify({ next, at: Date.now() })); } catch (e) { /* private mode */ }
}
function takeNext() {
  try {
    const saved = JSON.parse(localStorage.getItem(NEXT_KEY) || 'null');
    localStorage.removeItem(NEXT_KEY);
    if (saved && RETURN_TO[saved.next] && Date.now() - saved.at < NEXT_TTL) return RETURN_TO[saved.next];
  } catch (e) { /* ignore */ }
  return null;
}

const esc = v => String(v ?? '').replace(/[&<>"']/g, c =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmtDate = d => new Date(d).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const money = (cents, cur) => new Intl.NumberFormat('nl-NL', { style: 'currency', currency: (cur || 'eur').toUpperCase() }).format(cents / 100);
const here = () => location.origin + location.pathname;

function show(view) { VIEWS.forEach(v => { $('#view-' + v).hidden = v !== view; }); }
function message(el, text, kind) { el.textContent = text; el.className = 'msg ' + kind; el.hidden = !text; }

// ------------------------------------------------------------------ auth

async function init() {
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) { show('setup'); return; }
  sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);

  // Supabase queries must not run inside this callback (it holds the auth lock), hence setTimeout.
  sb.auth.onAuthStateChange((event, session) => {
    if (event === 'PASSWORD_RECOVERY') show('reset');
    else if (event === 'SIGNED_OUT') { enteredAs = null; show('signin'); }
    else if (event === 'SIGNED_IN' && session && $('#view-reset').hidden) setTimeout(() => enter(session), 0);
  });

  const params = new URLSearchParams(location.search);
  if (params.get('next') === 'toolkit') {
    rememberNext('toolkit');
    const why = 'Free, and it unlocks the Innovation Paradox Thinking Toolkit: the guide and all 21 canvases.';
    $('#view-signup').querySelector('p').textContent = why;
    $('#view-signin').querySelector('p').textContent = 'Sign in to unlock the Innovation Paradox Thinking Toolkit.';
  }
  if (params.get('email')) { $('#su-email').value = params.get('email'); $('#si-email').value = params.get('email'); }
  if (location.hash.includes('type=recovery')) { show('reset'); return; }

  const { data: { session } } = await sb.auth.getSession();
  if (session) { enter(session); return; }
  show(params.get('signup') ? 'signup' : 'signin');

  // A failed sign-in comes back with the reason in the URL; show it instead of a silent blank form.
  const back = new URLSearchParams(location.hash.slice(1));
  const why = back.get('error_description') || params.get('error_description');
  if (why) {
    message($('#si-msg'), 'Sign-in failed: ' + why.replace(/\+/g, ' '), 'err');
    history.replaceState(null, '', location.pathname);
  }
}

document.querySelectorAll('[data-go]').forEach(b => b.addEventListener('click', () => show(b.dataset.go)));

document.querySelectorAll('[data-google]').forEach(b => b.addEventListener('click', () =>
  sb.auth.signInWithOAuth({ provider: 'google', options: { redirectTo: here() } })));

$('#view-signin').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#si-msg'); message(msg, '', 'err');
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
  const { data, error } = await sb.auth.signInWithPassword({
    email: $('#si-email').value.trim(), password: $('#si-pass').value
  });
  btn.disabled = false;
  if (error) {
    message(msg, /confirm/i.test(error.message)
      ? 'Please confirm your email address first, using the link we sent you.'
      : 'Incorrect email or password.', 'err');
    return;
  }
  $('#si-pass').value = '';
  enter(data.session);
});

$('#view-signup').addEventListener('submit', async e => {
  e.preventDefault();
  const msg = $('#su-msg'); message(msg, '', 'err');
  const email = $('#su-email').value.trim();
  const btn = e.target.querySelector('button[type=submit]'); btn.disabled = true;
  const { data, error } = await sb.auth.signUp({
    email, password: $('#su-pass').value,
    options: { emailRedirectTo: here(), data: { full_name: $('#su-name').value.trim() } }
  });
  btn.disabled = false;
  if (error) { message(msg, error.message, 'err'); return; }
  if (data.session) { enter(data.session); return; }
  $('#check-email').textContent = email;
  show('check');
});

$('#forgot').addEventListener('click', async () => {
  const msg = $('#si-msg'), email = $('#si-email').value.trim();
  if (!email) { message(msg, 'Enter your email address first.', 'err'); return; }
  await sb.auth.resetPasswordForEmail(email, { redirectTo: here() });
  message(msg, 'If there’s an account for this address, a reset link is on its way.', 'ok');
});

$('#view-reset').addEventListener('submit', async e => {
  e.preventDefault();
  const { error } = await sb.auth.updateUser({ password: $('#r-pass').value });
  if (error) { message($('#reset-msg'), error.message, 'err'); return; }
  history.replaceState(null, '', location.pathname);
  const { data: { session } } = await sb.auth.getSession();
  session ? enter(session) : show('signin');
});

$('#signout').addEventListener('click', () => sb.auth.signOut());

// ------------------------------------------------------------------ library

async function enter(session) {
  const user = session.user;
  if (enteredAs === user.id) return;
  enteredAs = user.id;
  const back = takeNext();
  if (back) { location.replace(back); return; }
  if (location.hash) history.replaceState(null, '', location.pathname);
  show('app');
  $('#who').textContent = 'Signed in as ' + user.email;
  $('#downloads').innerHTML = $('#orders').innerHTML = '<div class="none">Loading…</div>';

  const { data, error } = await sb.from('contacts')
    .select('name,downloads(resource,file,created_at),orders(product,quantity,amount_total,currency,status,created_at)')
    .eq('user_id', user.id);
  if (error) {
    $('#downloads').innerHTML = $('#orders').innerHTML = '<div class="none">Couldn’t load your library. Please refresh the page.</div>';
    return;
  }

  const name = user.user_metadata?.full_name || data.find(c => c.name)?.name || '';
  $('#greet').textContent = name ? `Welcome, ${name.split(' ')[0]}` : 'Your library';
  renderDownloads(data.flatMap(c => c.downloads || []));
  renderOrders(data.flatMap(c => c.orders || []));
}

function renderDownloads(rows) {
  const byResource = new Map();
  rows.sort((a, b) => b.created_at.localeCompare(a.created_at)).forEach(d => {
    const key = d.file || d.resource;
    const seen = byResource.get(key);
    if (seen) seen.count++; else byResource.set(key, { ...d, count: 1 });
  });
  const list = [...byResource.values()];
  $('#downloads').innerHTML = list.length ? list.map(d => `
    <div class="item">
      <div><h4>${esc(d.resource)}</h4>
        <small>Downloaded ${fmtDate(d.created_at)}${d.count > 1 ? ` · ${d.count} times` : ''}</small></div>
      ${d.file && PDF_PATH.test(d.file) ? `<a class="btn" href="${esc(d.file)}" download>Download again</a>` : ''}
    </div>`).join('')
    : '<div class="none">No downloads yet. <a href="resources.html">Browse the resources →</a></div>';
}

function renderOrders(rows) {
  rows.sort((a, b) => b.created_at.localeCompare(a.created_at));
  $('#orders').innerHTML = rows.length ? rows.map(o => `
    <div class="item order">
      <div><h4>${esc(o.product)}</h4>
        <small>Ordered ${fmtDate(o.created_at)} · ${money(o.amount_total, o.currency)}</small></div>
      <span class="pill ${esc(o.status)}">${esc(ORDER_STATUS[o.status] || o.status)}</span>
    </div>`).join('')
    : '<div class="none">No orders yet. <a href="/">See Koen’s books →</a></div>';
}

init();
