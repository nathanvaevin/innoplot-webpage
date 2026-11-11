// InnoPlot Library: toolkit page. Downloads unlock for signed-in visitors and are
// recorded through capture_lead, so they appear in My library and in the CRM.
// Note: this is a sign-up gate, not file protection. The PDFs are static files.
(() => {
  const cfg = window.INNOPLOT_CONFIG || {};
  if (!cfg.supabaseUrl || !cfg.supabaseAnonKey || !window.supabase) return;
  const sb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseAnonKey);
  const links = [...document.querySelectorAll('.dl')];
  const PDF = /^assets\/whitepapers\/[\w.-]+\.pdf$/;
  let email = '';

  links.forEach(a => {
    a.dataset.locked = a.getAttribute('href');
    a.addEventListener('click', () => {
      if (!email) return;
      // capture_lead only accepts PDF paths; the zip is recorded by name alone.
      sb.rpc('capture_lead', {
        p_email: email, p_resource: a.dataset.name, p_source_page: location.pathname,
        p_consent: true, p_file: PDF.test(a.dataset.file) ? a.dataset.file : null,
      }).then(() => {}, () => {});
    });
  });

  function render(session) {
    email = session?.user?.email || '';
    document.body.classList.toggle('unlocked', !!email);
    document.getElementById('gate-out').hidden = !!email;
    document.getElementById('gate-in').hidden = !email;
    document.getElementById('who').textContent = email;
    links.forEach(a => {
      a.href = email ? a.dataset.file : a.dataset.locked;
      if (email) a.setAttribute('download', ''); else a.removeAttribute('download');
    });
  }

  sb.auth.onAuthStateChange((_event, session) => render(session));
  sb.auth.getSession().then(({ data }) => render(data.session));
})();
