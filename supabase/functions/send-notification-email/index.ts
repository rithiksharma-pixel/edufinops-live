// =========================================================
// EDGE FUNCTION — send-notification-email
// Deploy with: supabase functions deploy send-notification-email
//
// Generic SMTP sender. Called from Postgres via notify_via_email(), which
// reads `notification_secret` from Vault and sends it as the
// x-notification-secret header; this function compares it to its own
// NOTIFICATION_SECRET env var. verify_jwt is FALSE because the caller is
// pg_net, which has no user JWT — the shared secret is the auth.
//
// Required project secrets (set via `supabase secrets set`, never in code):
//   NOTIFICATION_SECRET   must equal Vault's notification_secret
//   GMAIL_SMTP_USER       sender address
//   GMAIL_SMTP_PASSWORD   Google APP PASSWORD, not the account password
// =========================================================
import { serve } from 'https://deno.land/std@0.202.0/http/server.ts';
import { SMTPClient } from 'https://deno.land/x/denomailer@1.6.0/mod.ts';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type, x-notification-secret',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders });
  }

  const expectedSecret = Deno.env.get('NOTIFICATION_SECRET');
  const providedSecret = req.headers.get('x-notification-secret');

  // GET ?diag=1 reports which env vars are SET (names only, never values).
  // This is how the missing NOTIFICATION_SECRET was found without sending
  // anything, and it is worth keeping for the next misconfiguration.
  if (req.method === 'GET') {
    const url = new URL(req.url);
    if (url.searchParams.get('diag') === '1') {
      return new Response(JSON.stringify({
        deployMarker: 'v7-implicit-tls-465',
        envKeys: Object.keys(Deno.env.toObject()).sort(),
      }), { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
    }
  }

  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: corsHeaders });
  }

  if (!expectedSecret || providedSecret !== expectedSecret) {
    return new Response(JSON.stringify({
      error: 'Unauthorized',
      diag: { expectedSecretPresent: !!expectedSecret, expectedSecretLength: expectedSecret?.length ?? 0, providedSecretLength: providedSecret?.length ?? 0 },
    }), { status: 401, headers: corsHeaders });
  }

  let client;
  try {
    const { to, subject, html } = await req.json();
    if (!to || !subject || !html) {
      return new Response(JSON.stringify({ error: 'to, subject, and html are required' }), { status: 400, headers: corsHeaders });
    }

    const smtpUser = Deno.env.get('GMAIL_SMTP_USER');
    const smtpPassword = Deno.env.get('GMAIL_SMTP_PASSWORD');
    if (!smtpUser || !smtpPassword) {
      return new Response(JSON.stringify({ error: 'GMAIL_SMTP_USER / GMAIL_SMTP_PASSWORD not configured' }), { status: 500, headers: corsHeaders });
    }

    // Port 465 with tls:true = IMPLICIT TLS, which is what `tls: true` means.
    // This was previously port 587 with tls:true, an invalid combination: 587
    // is the STARTTLS port, where the session opens in plaintext and is
    // upgraded mid-stream. Connecting with TLS immediately made the client
    // read Gmail's plaintext SMTP greeting as a TLS record and fail with
    // "received corrupt message of type InvalidContentType" — which reads
    // like a credential problem but is purely transport configuration.
    client = new SMTPClient({
      connection: {
        hostname: 'smtp.gmail.com',
        port: 465,
        tls: true,
        auth: { username: smtpUser, password: smtpPassword },
      },
    });

    await client.send({
      from: `Zolve Tangent <${smtpUser}>`,
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
    });

    return new Response(JSON.stringify({ success: true }), {
      status: 200,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    });
  } catch (err) {
    return new Response(JSON.stringify({ error: err.message ?? 'Unexpected error' }), { status: 500, headers: corsHeaders });
  } finally {
    try { await client?.close(); } catch { /* already closed or never opened */ }
  }
});
