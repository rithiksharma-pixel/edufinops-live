// =========================================================
// ENVIRONMENT CONFIG — Supabase project "Sales CRM"
//
// The anon key below is SAFE to ship to the browser: it grants no
// privileges on its own. Every table is protected by Row Level
// Security, so what any user can actually read or write is decided
// by their authenticated role, not by possession of this key.
//
// NEVER put the service_role key in this file. It bypasses RLS
// entirely. It belongs only in the Edge Function's secrets.
// =========================================================
window.__ENV__ = {
  SUPABASE_URL: 'https://wgzgqbfankdbqxxcesci.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6IndnemdxYmZhbmtkYnF4eGNlc2NpIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM5MjUyMjgsImV4cCI6MjA5OTUwMTIyOH0.7d4ERVzwnyzjOPrRWXLgUsTpVgLPq1jyTnDByHZWyKc',
};

// Theme init — runs synchronously in <head> before first paint, so a saved
// dark/light preference applies with no flash. Only a user's explicit
// choice is stored; with nothing stored the OS preference wins (handled by
// the CSS @media query). Shared toggle lives in shared/js/appNav.js.
try {
  var __t = localStorage.getItem('zt-theme');
  if (__t === 'dark' || __t === 'light') document.documentElement.setAttribute('data-theme', __t);
} catch (e) { /* private mode / storage disabled — fall back to OS preference */ }
