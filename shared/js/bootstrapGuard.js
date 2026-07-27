// =========================================================
// SHARED — bootstrap failure guard
//
// Every app used to call `bootstrap()` bare. An async function called
// that way swallows its own failure: the promise rejects with nobody
// listening, so the page just STOPS mid-setup with whatever placeholder
// text was on screen ("Loading leads…") and no error anywhere the user
// can see. That is exactly how a single missing table (saved_views)
// silently bricked Lead Management — the list, the funnel, the New Lead
// button and the detail drawer were all dead because setup never got
// past one throwing call.
//
// Wrapping bootstrap in this guard turns that silent hang into a
// visible, actionable message, and keeps the real error in the console
// for whoever debugs it next.
// =========================================================

/**
 * Runs an app's bootstrap and renders a visible banner if it throws.
 * @param {() => Promise<void>} bootstrapFn
 * @param {string} appLabel  Shown in the message, e.g. "Lead Management".
 */
export function guardBootstrap(bootstrapFn, appLabel = 'This page') {
  Promise.resolve()
    .then(bootstrapFn)
    .catch((err) => {
      console.error(`${appLabel} failed to start:`, err);
      showBootstrapError(appLabel, err);
    });
}

function showBootstrapError(appLabel, err) {
  // Don't stack banners if something re-triggers this.
  if (document.getElementById('ztBootstrapError')) return;

  const message = err?.message || String(err);
  const banner = document.createElement('div');
  banner.id = 'ztBootstrapError';
  banner.setAttribute('role', 'alert');
  banner.style.cssText = [
    'position:fixed', 'top:0', 'left:0', 'right:0', 'z-index:9999',
    'background:var(--danger-soft, #FBEAEA)', 'color:var(--danger-soft-ink, #B91C1C)',
    'border-bottom:1px solid var(--danger, #DC2626)',
    'padding:12px 18px', 'font:500 13px/1.5 Inter, sans-serif',
    'display:flex', 'gap:10px', 'align-items:flex-start',
  ].join(';');

  const text = document.createElement('div');
  text.style.cssText = 'flex:1;min-width:0;';
  const strong = document.createElement('strong');
  strong.textContent = `${appLabel} didn't finish loading.`;
  const detail = document.createElement('div');
  detail.style.cssText = 'font-weight:400;margin-top:2px;word-break:break-word;';
  detail.textContent = message; // textContent — never inject an error string as HTML
  text.append(strong, detail);

  const reload = document.createElement('button');
  reload.type = 'button';
  reload.textContent = 'Reload';
  reload.style.cssText = 'flex-shrink:0;cursor:pointer;font:600 12px Inter,sans-serif;padding:6px 12px;border-radius:8px;border:1px solid currentColor;background:transparent;color:inherit;';
  reload.addEventListener('click', () => window.location.reload());

  banner.append(text, reload);
  (document.body || document.documentElement).appendChild(banner);
}
