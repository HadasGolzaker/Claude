/*
 * Server-side proxy to the Google Gemini API (image generation, "nano banana").
 * The secret GEMINI_API_KEY lives here, never in the browser.
 * Requests are only forwarded for signed-in users.
 */

export const config = { runtime: 'nodejs', maxDuration: 45 };

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  const apiKey = process.env.GEMINI_API_KEY;
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

  const prompt = (req.body && req.body.prompt) || '';
  if (!prompt.trim()) {
    res.status(400).json({ error: { message: 'Missing prompt.' } });
    return;
  }

  // 2) Forward the request to Gemini 2.5 Flash Image ("nano banana").
  try {
    const upstream = await fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent',
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-goog-api-key': apiKey,
        },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
      }
    );

    const text = await upstream.text();
    let data;
    try { data = JSON.parse(text); }
    catch (_) { data = null; }

    if (!upstream.ok || !data) {
      const msg = (data && data.error && data.error.message) || text || 'Image generation failed';
      res.status(upstream.status || 500).json({ error: { message: msg } });
      return;
    }

    const parts = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts) || [];
    const imgPart = parts.find(p => p.inlineData && p.inlineData.data);
    if (!imgPart) {
      res.status(500).json({ error: { message: 'No image returned' } });
      return;
    }

    res.status(200).json({ media_type: imgPart.inlineData.mimeType || 'image/png', data: imgPart.inlineData.data });
  } catch (err) {
    res.status(500).json({ error: { message: String((err && err.message) || err) } });
  }
}
