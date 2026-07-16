// =========================================================
// SHARED UI HELPER — toast notifications.
// Expects a `<div id="toast" class="toast" hidden></div>` somewhere in
// the page (every app's HTML already has one). Previously this exact
// function was reimplemented independently in 8 different app.js files.
// =========================================================

let toastTimer = null;

export function showToast(message, isError = false) {
  const el = document.getElementById('toast');
  if (!el) return;
  clearTimeout(toastTimer);
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.hidden = false;
  toastTimer = setTimeout(() => { el.hidden = true; }, 3200);
}
