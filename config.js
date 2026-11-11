window.INNOPLOT_CONFIG = {
  supabaseUrl: 'https://soxdwyzkdbsowadwzdza.supabase.co',
  supabaseAnonKey: 'sb_publishable_tguoPuHch8PwnyFsajSU8g_-jJSoFdq'
};

// Show clean addresses (/resources instead of /resources.html). GitHub Pages serves both.
if (/innoplotlibrary\.com$/.test(location.hostname) && /\.html$/.test(location.pathname)) {
  history.replaceState(null, '', (location.pathname.replace(/(\/index)?\.html$/, '') || '/') + location.search + location.hash);
}
