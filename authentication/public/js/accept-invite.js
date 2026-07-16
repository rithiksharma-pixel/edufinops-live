import { confirmPasswordReset, acceptMyInvitation, getCurrentUser } from './services/authService.js';
import { getHomeRouteForRole } from './config/roleRoutes.js';

const form = document.getElementById('setPasswordForm');
const errorEl = document.getElementById('authError');
const btn = document.getElementById('btnSetPassword');

// Supabase appends #access_token=...&type=invite (or type=recovery) to the
// redirect URL. supabase-js's client picks up the session from the URL hash
// automatically on load; we only need `type` to decide what to do next.
const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
const flowType = hashParams.get('type'); // 'invite' | 'recovery'

if (flowType === 'recovery') {
  document.getElementById('pageTitle').textContent = 'Reset your password';
  document.getElementById('pageSubtitle').textContent = 'Choose a new password for your account.';
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;

  const password = document.getElementById('password').value;
  const confirmPassword = document.getElementById('confirmPassword').value;

  if (password.length < 8) {
    errorEl.textContent = 'Password must be at least 8 characters.';
    errorEl.hidden = false;
    return;
  }
  if (password !== confirmPassword) {
    errorEl.textContent = 'Passwords do not match.';
    errorEl.hidden = false;
    return;
  }

  btn.disabled = true;
  btn.textContent = 'Setting password…';

  try {
    await confirmPasswordReset(password);

    if (flowType === 'invite') {
      await acceptMyInvitation();
    }

    document.getElementById('setPasswordCard').hidden = true;
    document.getElementById('doneCard').hidden = false;

    const profile = await getCurrentUser();
    const route = getHomeRouteForRole(profile.role);
    setTimeout(() => {
      if (route) window.location.href = route;
      else document.getElementById('doneMessage').textContent = `No application is set up yet for the "${profile.role}" role — contact your admin.`;
    }, 1200);
  } catch (err) {
    console.error(err);
    errorEl.textContent = err.message || 'Something went wrong. Please try again or ask your admin for a new link.';
    errorEl.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Set password and continue';
  }
});
