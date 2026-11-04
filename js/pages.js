// Views of the single page: #/ home, #/app the wizard, #/privacy. Hash routes: static hosting, no build step.
const ROUTES = { '#/app': 'app', '#/privacy': 'privacy' };
const views = () => document.querySelectorAll('[data-view]');

function route() {
  const name = ROUTES[location.hash] ?? 'home';
  views().forEach(v => { v.hidden = v.dataset.view !== name; });
  document.querySelectorAll('[data-nav]').forEach(a => {
    const on = a.dataset.nav === name;
    a.classList.toggle('on', on);
    if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });
  document.body.classList.toggle('in-app', name === 'app');
  window.scrollTo(0, 0);
}

/** Forget everything this app keeps in the browser. Two clicks: there is no undo. */
function setupClearData(button, onLabel) {
  let armed = false, timer;
  button.onclick = () => {
    if (!armed) {
      armed = true; button.classList.add('armed'); onLabel('privacy.clear.confirm');
      timer = setTimeout(() => { armed = false; button.classList.remove('armed'); onLabel('privacy.clear'); }, 5000);
      return;
    }
    clearTimeout(timer);
    try {
      Object.keys(localStorage).filter(k => k.startsWith('bhud.')).forEach(k => localStorage.removeItem(k));
    } catch { /* storage unavailable: nothing was kept either */ }
    location.reload();
  };
}

export function initPages(t) {
  window.addEventListener('hashchange', route);
  route();
  const b = document.getElementById('btn-clear-data');
  if (b) setupClearData(b, key => { b.dataset.i18n = key; b.textContent = t(key); });
}
