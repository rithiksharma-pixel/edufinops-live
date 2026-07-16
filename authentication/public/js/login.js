import { signIn, getCurrentUser } from './services/authService.js';
import { getHomeRouteForRole } from './config/roleRoutes.js';

const form = document.getElementById('loginForm');
const errorEl = document.getElementById('authError');
const submitBtn = document.getElementById('btnSignIn');

function showError(message) {
  errorEl.textContent = message;
  errorEl.hidden = false;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.hidden = true;
  submitBtn.disabled = true;
  submitBtn.textContent = 'Signing in…';

  const email = document.getElementById('email').value.trim();
  const password = document.getElementById('password').value;

  try {
    await signIn(email, password);
    const profile = await getCurrentUser();
    const route = getHomeRouteForRole(profile.role);
    if (route) {
      window.location.href = route;
    } else {
      showError(`Signed in, but there's no application set up yet for the "${profile.role}" role.`);
    }
  } catch (err) {
    if (err.message === 'DEACTIVATED') {
      showError('This account has been deactivated. Contact your admin if this seems wrong.');
    } else {
      showError('Incorrect email or password.');
    }
  } finally {
    submitBtn.disabled = false;
    submitBtn.textContent = 'Sign in';
  }
});
