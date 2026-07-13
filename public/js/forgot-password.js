import { requestPasswordReset } from './services/authService.js';

const form = document.getElementById('resetForm');
const errorEl = document.getElementById('authError');
const btn = document.getElementById('btnSend');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Sending…';

  const email = document.getElementById('email').value.trim();

  try {
    await requestPasswordReset(email);
  } catch (err) {
    // Deliberately don't distinguish "no such account" from success in the
    // UI (avoids leaking which emails are registered) — but we still log
    // real errors (network, misconfiguration) to the console for support.
    console.error(err);
  } finally {
    document.getElementById('requestCard').hidden = true;
    document.getElementById('sentCard').hidden = false;
  }
});
