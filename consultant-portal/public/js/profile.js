import { getCurrentUser, updateMyProfile } from './services/authService.js';
import { mountTopbar, setBreadcrumb } from '../../../shared/js/appNav.js';
import { showToast } from '../../../shared/js/toast.js';

async function bootstrap() {
  let user;
  try {
    user = await getCurrentUser();
  } catch (err) {
    document.body.innerHTML = '<div style="padding:48px;font-family:sans-serif;">Please sign in first.</div>';
    return;
  }

  mountTopbar({ app: 'consultant-portal', user });
  setBreadcrumb(['Profile']);

  const form = document.getElementById('profileForm');
  form.full_name.value = user.fullName;
  form.email.value = user.email;
  form.phone.value = user.phone || '';

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    try {
      await updateMyProfile({ fullName: form.full_name.value.trim(), phone: form.phone.value.trim() });
      showToast('Profile updated.');
    } catch (err) {
      showToast('Could not update profile.', true);
    }
  });
}

bootstrap();
