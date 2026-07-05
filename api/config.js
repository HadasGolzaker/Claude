/*
 * Returns the PUBLIC Supabase settings to the browser.
 * These two values are safe to expose (that's how Supabase works —
 * the anon key is protected by Row Level Security). The secret
 * Claude API key is never sent here.
 */
export default function handler(req, res) {
  res.status(200).json({
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  });
}
