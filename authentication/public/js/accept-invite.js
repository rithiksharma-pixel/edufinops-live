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

    // Always try to accept a pending invitation — do NOT gate this on
    // `type=invite` in the URL. Supabase's PKCE redirect returns a ?code=
    // query param with no type fragment, so flowType is null on those
    // flows and this step was silently skipped: the password got set and
    // the person could sign in, but no public.users row was ever created.
    // That left 7 auth accounts with no profile, unable to use the CRM,
    // and made a re-invite fail with "already registered".
    // accept_my_invitation() is idempotent (on conflict do nothing) and
    // raises a recognisable error when there is genuinely no invitation,
    // which is the normal case for a real password reset.
    try {
      await acceptMyInvitation();
    } catch (inviteErr) {
      const msg = String(inviteErr?.message || '');
      const isPlainRecovery = /no pending invitation/i.test(msg);
      if (!isPlainRecovery) throw inviteErr;
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
