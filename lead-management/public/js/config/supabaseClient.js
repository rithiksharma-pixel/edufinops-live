// =========================================================
// DATABASE LAYER — Supabase client
// This is the ONLY module that touches the Supabase SDK directly.
// Every other module talks to the database through /services/*,
// never through this client, keeping the layers separable.
// =========================================================

// TODO: move these to environment-injected values before deploying
// (Vercel build-time env vars), never hardcode real keys in source control.
const SUPABASE_URL = window.__ENV__?.SUPABASE_URL || 'https://YOUR-PROJECT.supabase.co';
const SUPABASE_ANON_KEY = window.__ENV__?.SUPABASE_ANON_KEY || 'YOUR-ANON-KEY';

export const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});
