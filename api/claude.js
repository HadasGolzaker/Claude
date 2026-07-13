/*
 * Server-side proxy to the Anthropic (Claude) API.
 * The secret ANTHROPIC_API_KEY lives here, never in the browser.
 * Requests are only forwarded for signed-in users.
 * Streams the response so long generations don't hit the 60s timeout.
 */

export const config = { runtime: 'nodejs', maxDuration: 120 };

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
    const userCheck = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` },
    });
    if (!userCheck.ok) {
      res.status(401).json({ error: { message: 'Not authenticated.' } });
      return;
    }
  } catch (err) {
    res.status(401).json({ error: { message: 'Auth check failed.' } });
    return;
  }

  // 2) Forward the request to Claude WITH streaming enabled.
  try {
    const upstream = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ...req.body, stream: true }),
    });

    if (!upstream.ok || !upstream.body) {
      const errText = await upstream.text();
      res.status(upstream.status || 500).json({ error: { message: errText || 'Claude request failed' } });
      return;
    }

    // 3) Pipe Claude's stream straight to the browser.
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      res.write(decoder.decode(value, { stream: true }));
      if (typeof res.flush === 'function') res.flush();
    }
    res.end();
  } catch (err) {
    res.status(500).json({ error: { message: String((err && err.message) || err) } });
  }
}
