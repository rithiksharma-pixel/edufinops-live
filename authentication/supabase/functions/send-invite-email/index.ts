// =========================================================
// EDGE FUNCTION — send-invite-email
// Deploy with: supabase functions deploy send-invite-email
// Requires these secrets set on the Supabase project (NOT the anon key):
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
//   supabase secrets set SUPABASE_URL=...
//   supabase secrets set SITE_URL=https://your-domain
//
// This is the ONLY place in the entire platform that touches the
// service_role key. It must never be sent to, or embedded in, any
// browser-facing file (supabaseClient.js in every app deliberately
// uses the anon key only).
//
// Called by authentication/public/js/services/userAdminService.js
// AFTER invite_user() has already recorded the invitation row in
// Postgres. This function's only job is: make sure the person has an
// auth account and receives a link that lets them set a password.
// =========================================================
import { serve } from 'https://deno.land/std@0.202.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const SITE_URL = Deno.env.get('SITE_URL') ?? '';
const REDIRECT_TO = `${SITE_URL}/authentication/public/accept-invite.html`;

const supabaseAdmin = createClient(
  Deno.env.get('SUPABASE_URL'),
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { autoRefreshToken: false, persistSession: false } }
);

// supabase-js's functions.invoke() is a cross-origin call from the browser,
// so the browser sends a CORS preflight OPTIONS request before the real
// POST. Without these headers the preflight gets a bare 405 and the actual
// invite request never fires, even though nothing about the POST itself
// was wrong.
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

const json = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
  });

/** Does this Supabase error mean "that email already has an auth account"? */
function isAlreadyRegistered(err: { message?: string; code?: string; status?: number }) {
  const m = (err?.message ?? '').toLowerCase();
  return (
    err?.code === 'email_exists' ||
    err?.status === 422 ||
    m.includes('already been registered') ||
    m.includes('already registered') ||
    m.includes('already exists')
  );
}

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }
  if (req.method !== 'POST') {
    return json({ error: 'Method not allowed' }, 405);
  }

  try {
    const { invitationId, email, fullName } = await req.json();

    if (!invitationId || !email) {
      return json({ error: 'invitationId and email are required' }, 400);
    }

    // Belt-and-suspenders: confirm the invitation actually exists and is
    // still pending before sending anything. Prevents this function being
    // called directly (bypassing invite_user's is_admin() check) from
    // creating an auth account with no matching invitation record.
    const { data: invitation, error: fetchError } = await supabaseAdmin
      .from('invitations')
      .select('id, email, status')
      .eq('id', invitationId)
      .eq('status', 'pending')
      .single();

    if (fetchError || !invitation) {
      return json({ error: 'No matching pending invitation found' }, 404);
    }
    if (invitation.email.toLowerCase() !== String(email).toLowerCase()) {
      return json({ error: 'Email does not match the invitation record' }, 400);
    }

    // The privileged call: creates the auth.users row and sends Supabase's
    // invite email with a set-password link, landing on accept-invite.html.
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
      redirectTo: REDIRECT_TO,
    });

    if (!error) {
      return json({ success: true, mode: 'invited', authUserId: data.user?.id }, 200);
    }

    // Re-inviting someone who already has an auth account used to dead-end
    // here with a 400, which the Admin UI reported as "check the Edge
    // Function is deployed" — misleading, since the function was fine.
    //
    // This is a NORMAL case: a first invite creates the auth user, then
    // anything that stops them completing setup (link expired, profile row
    // never created, wrong person) leads an admin to invite again. Rather
    // than failing, send a password-recovery link. It lands on the same
    // accept-invite page, where accept_my_invitation() creates the missing
    // public.users profile.
    if (isAlreadyRegistered(error)) {
      const { error: resetError } = await supabaseAdmin.auth.resetPasswordForEmail(email, {
        redirectTo: REDIRECT_TO,
      });
      if (resetError) {
        return json({ error: `This email already has an account, and the set-password link could not be sent: ${resetError.message}` }, 400);
      }
      return json({
        success: true,
        mode: 'existing_account_reset_sent',
        message: 'This email already had an account, so we sent a set-password link instead.',
      }, 200);
    }

    return json({ error: error.message }, 400);
  } catch (err) {
    return json({ error: (err as Error)?.message ?? 'Unexpected error' }, 500);
  }
});
