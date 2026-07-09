/*
 * Server-side proxy to the Anthropic (Claude) API.
 * The secret ANTHROPIC_API_KEY lives here, never in the browser.
 * Requests are only forwarded for signed-in users, so nobody can
 * abuse the key by hitting this endpoint anonymously.
 */
// Allow up to 60s for a full profile generation (large JSON output) before
// Vercel times the function out. Without this, Hobby caps at ~10s and a long
// generation returns a gateway timeout instead of the profile.
export const config = { maxDuration: 60 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

  if (!apiKey || !supabaseUrl || !supabaseAnonKey) {
    res.status(500).json({ error: { message: 'Server is not configured. Missing environment variables.' } });
    return;
  }

  // 1) Verify the caller is a logged-in user (protects your API key).
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: { message: 'Not authenticated.' } });
    return;
  }
  try {
    const userResp = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { Authorization: `Bearer ${token}`, apikey: supabaseAnonKey },
    });
    if (!userResp.ok) {
      res.status(401).json({ error: { message: 'Invalid or expired session.' } });
      return;
    }
  } catch (e) {
    res.status(401).json({ error: { message: 'Could not verify session.' } });
    return;
  }

  // 2) Forward the request to Anthropic with the secret key.
  try {
    const body = typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
    const anthropicResp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
    });
    const text = await anthropicResp.text();
    res.status(anthropicResp.status);
    res.setHeader('Content-Type', 'application/json');
    res.send(text);
  } catch (e) {
    res.status(502).json({ error: { message: 'Failed to reach the Anthropic API: ' + ((e && e.message) || 'unknown error') } });
  }
}
