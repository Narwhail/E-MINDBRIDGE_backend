import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';

dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    'Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment variables. ' +
    'Copy .env.example to .env and fill in your Supabase project credentials.'
  );
}

/**
 * Admin Supabase client using the Service Role Key.
 * This bypasses RLS and should ONLY be used server-side.
 * Never expose the service role key to the frontend.
 */
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});

/**
 * Public Supabase client using the Anon Key.
 * Used for user-facing auth operations (signIn, signOut, token refresh).
 */
export const supabaseClient = createClient(supabaseUrl, supabaseAnonKey || supabaseServiceRoleKey, {
  auth: {
    autoRefreshToken: false,
    persistSession: false,
  },
});
