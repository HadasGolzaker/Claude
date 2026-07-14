/*
 * Server-side proxy to the Anthropic (Claude) API.
 * The secret ANTHROPIC_API_KEY lives here, never in the browser.
 * Requests are only forwarded for signed-in users.
 * Streams the response so long generations don't hit the 60s timeout.
 *
 * Also adds two production-readiness guards:
 *  - automatic retry with backoff on transient rate-limit / overload errors,
 *    so a brief burst doesn't surface as an error to the user.
 *  - a soft per-user monthly cap on the number of Claude calls, so one user
 *    can't run up the whole bill. NOTE: the counter lives in the user's own
 *    kv_store row, so it's tamper-resistant but not tamper-proof (a determined
 *    user could reset it). For paid subscriptions, move this to a service-role
 *    key or a separate table the user can't write. Fine for beta.
 */

export const config = { runtime: 'nodejs', maxDuration: 120 };

/* per-user calls per calendar month; override in Vercel env if needed */
const MONTHLY_CALL_CAP = Number(process.env.MONTHLY_CALL_CAP || 300);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function usageKey() {
  const d = new Date();
  return `_usage_${d.getUTCFullYear()}_${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

async function readUsage(supabaseUrl, supabaseAnonKey, token, userId, key) {
  try {
    const r = await fetch(
      `${supabaseUrl}/rest/v1/kv_store?user_id=eq.${userId}&key=eq.${encodeURIComponent(key)}&select=value`,
      { headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` } }
    );
    if (!r.ok) return 0;
    const rows = await r.json();
    return rows && rows[0] ? parseInt(rows[0].value, 10) || 0 : 0;
  } catch (_) {
    return 0; /* never block a request because metering read failed */
  }
}

async function bumpUsage(supabaseUrl, supabaseAnonKey, token, userId, key, next) {
  try {
    await fetch(`${supabaseUrl}/rest/v1/kv_store`, {
      method: 'POST',
      headers: {
        apikey: supabaseAnonKey,
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        Prefer: 'resolution=merge-duplicates',
      },
      body: JSON.stringify([{ user_id: userId, key, value: String(next) }]),
    });
  } catch (_) { /* metering write failure shouldn't break the user's request */ }
}

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

  let userId = null;
  try {
    const userCheck = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` },
    });
    if (!userCheck.ok) {
      res.status(401).json({ error: { message: 'Not authenticated.' } });
      return;
    }
    const user = await userCheck.json();
    userId = user && user.id ? user.id : null;
  } catch (err) {
    res.status(401).json({ error: { message: 'Auth check failed.' } });
    return;
  }

  // 2) Enforce the per-user monthly cap (soft — see file header).
  const key = usageKey();
  const used = userId ? await readUsage(supabaseUrl, supabaseAnonKey, token, userId, key) : 0;
  if (used >= MONTHLY_CALL_CAP) {
    res.status(429).json({
      error: {
        type: 'usage_limit_reached',
        message: `Monthly usage limit reached (${MONTHLY_CALL_CAP} generations). It resets at the start of next month.`,
      },
    });
    return;
  }

  // 3) Forward to Claude WITH streaming, retrying transient rate-limit/overload.
  try {
    let upstream = null, errText = '', errStatus = 0;
    for (let attempt = 0; attempt < 3; attempt++) {
      const r = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({ ...req.body, stream: true }),
      });
      if (r.ok && r.body) { upstream = r; break; }
      errStatus = r.status;
      errText = await r.text();
      // 429 = rate limit, 529 = overloaded: wait and retry (unless last attempt)
      if ((r.status === 429 || r.status === 529) && attempt < 2) {
        const ra = parseInt(r.headers.get('retry-after') || '', 10);
        const waitMs = Math.min((Number.isFinite(ra) ? ra : Math.pow(2, attempt)) * 1000, 8000);
        await sleep(waitMs);
        continue;
      }
      break; // non-retryable, or retries exhausted
    }

    if (!upstream) {
      // Anthropic's error body is itself JSON; surface its human message.
      let message = errText || 'Claude request failed';
      try {
        const parsed = JSON.parse(errText);
        if (parsed && parsed.error && parsed.error.message) message = parsed.error.message;
      } catch (_) { /* not JSON */ }
      res.status(errStatus || 500).json({ error: { message } });
      return;
    }

    // Count this call now that Claude accepted it (failed/rate-limited calls don't count).
    if (userId) await bumpUsage(supabaseUrl, supabaseAnonKey, token, userId, key, used + 1);

    // 4) Pipe Claude's stream straight to the browser.
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
