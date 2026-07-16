import { supabase } from '../config/supabaseClient.js';
import { createAuthService } from '../../../../shared/js/authService.js';

export const { signIn, signOut, getCurrentUser, invalidateCurrentUser, requestPasswordReset, confirmPasswordReset, acceptMyInvitation } =
  createAuthService(supabase);
