// =========================================================
// EDGE FUNCTION — send-invite-email
// Deploy with: supabase functions deploy send-invite-email
// Requires these secrets set on the Supabase project (NOT the anon key):
//   supabase secrets set SUPABASE_SERVICE_ROLE_KEY=...
//   supabase secrets set SUPABASE_URL=...
//
// This is the ONLY place in the entire platform that touches the
// service_role key. It must never be sent to, or embedded in, any
// browser-facing file (supabaseClient.js in every app deliberately
// uses the anon key only).
//
// Called by authentication/public/js/services/userAdminService.js
// AFTER invite_user() has already recorded the invitation row in
// Postgres. This function's only job is: create the real auth.users
// account and let Supabase send the actual email.
// =========================================================
import { serve } from 'https://deno.land/std@0.202.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  try {
    const { invitationId, email, fullName } = await req.json();

    if (!invitationId || !email) {
      return new Response(JSON.stringify({ error: 'invitationId and email are required' }), { status: 400, headers: corsHeaders });
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
      return new Response(JSON.stringify({ error: 'No matching pending invitation found' }), { status: 404, headers: corsHeaders });
    }
    if (invitation.email !== email) {
      return new Response(JSON.stringify({ error: 'Email does not match the invitation record' }), { status: 400, headers: corsHeaders });
    }

    // This is the actual privileged call: creates the auth.users row and
    // sends Supabase's invite email with a set-password link. The redirect
    // lands them on accept-invite.html with type=invite in the URL hash.
    const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email, {
      data: { full_name: fullName },
      redirectTo: `${Deno.env.get('SITE_URL') ?? ''}/authentication/public/accept-invite.html`,
    });

    if (error) {
      // Common real-world case: this email already has an auth.users
      // account (e.g. a previous invite, or they were invited then
      // deactivated then re-invited). Surface it clearly rather than a
      // generic 500 — the Admin UI shows this message directly.
      return new Response(JSON.stringify({ error: error.message }), { status: 400, headers: corsHeaders });
    }

    return new Response(JSON.stringify({ success: true, authUserId: data.user?.id }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message ?? 'Unexpected error' }), { status: 500, headers: corsHeaders });
  }
});
