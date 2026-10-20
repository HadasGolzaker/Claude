/*
 * Emails the person a profile was just shared with, so they know to sign in.
 * Sends through Resend (resend.com) with the secret RESEND_API_KEY.
 * Only signed-in users can call it, and only for a share that really exists
 * in their own profile_shares rows — so it can't be used to email anyone else.
 */

const esc = s => String(s || '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

function buildEmail({ lang, ownerEmail, profileName, toEmail, siteUrl }) {
  const he = lang !== 'en';
  const subject = he
    ? `פרופיל הכתיבה "${profileName}" שותף איתך ב-Voiceprint`
    : `"${profileName}" was shared with you on Voiceprint`;
  const lines = he
    ? [
        `קיבלת גישה לפרופיל הכתיבה <b>${esc(profileName)}</b> מאת ${esc(ownerEmail)}.`,
        `עכשיו אפשר לכתוב פוסטים בקול של הפרופיל הזה.`,
        `כדי להתחיל, היכנסו לאתר עם כתובת המייל הזו (${esc(toEmail)}). הפרופיל יופיע בתפריט תחת "שותפו איתי".`,
      ]
    : [
        `${esc(ownerEmail)} shared the writing profile <b>${esc(profileName)}</b> with you.`,
        `You can now write posts in that profile's voice.`,
        `To start, sign in with this email address (${esc(toEmail)}). The profile will appear in the menu under "Shared with me".`,
      ];
  const button = he ? 'כניסה ל-Voiceprint' : 'Open Voiceprint';
  const html = `<div dir="${he ? 'rtl' : 'ltr'}" style="font-family:Arial,sans-serif;font-size:16px;line-height:1.6;color:#111;max-width:520px">
  <h2 style="margin:0 0 16px">Voiceprint</h2>
  ${lines.map(l => `<p style="margin:0 0 12px">${l}</p>`).join('')}
  <p style="margin:24px 0"><a href="${esc(siteUrl)}" style="background:#111;color:#fff;padding:12px 22px;border-radius:999px;text-decoration:none;font-weight:bold">${button}</a></p>
</div>`;
  return { subject, html };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: { message: 'Method not allowed' } });
    return;
  }

  const resendKey = process.env.RESEND_API_KEY;
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;
  if (!resendKey || !supabaseUrl || !supabaseAnonKey) {
    res.status(501).json({ error: { message: 'Email sending is not configured.' } });
    return;
  }

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!token) {
    res.status(401).json({ error: { message: 'Not authenticated.' } });
    return;
  }

  const { profileId, email, lang } = req.body || {};
  if (!profileId || !email) {
    res.status(400).json({ error: { message: 'Missing profileId or email.' } });
    return;
  }

  try {
    // 1) Who is asking?
    const userRes = await fetch(`${supabaseUrl}/auth/v1/user`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` },
    });
    if (!userRes.ok) {
      res.status(401).json({ error: { message: 'Not authenticated.' } });
      return;
    }
    const user = await userRes.json();

    // 2) The share must exist and belong to them (read with their own token, so RLS applies).
    const q = new URLSearchParams({
      select: 'profile,email',
      owner_id: `eq.${user.id}`,
      profile_id: `eq.${profileId}`,
      email: `eq.${String(email).toLowerCase()}`,
    });
    const shareRes = await fetch(`${supabaseUrl}/rest/v1/profile_shares?${q}`, {
      headers: { apikey: supabaseAnonKey, Authorization: `Bearer ${token}` },
    });
    const rows = shareRes.ok ? await shareRes.json() : [];
    if (!rows.length) {
      res.status(404).json({ error: { message: 'Share not found.' } });
      return;
    }
    let profileName = '';
    try { profileName = JSON.parse(rows[0].profile).name || ''; } catch (_) {}

    // 3) Send the email.
    const siteUrl = process.env.SITE_URL || `https://${req.headers.host}`;
    const { subject, html } = buildEmail({ lang, ownerEmail: user.email, profileName, toEmail: rows[0].email, siteUrl });
    const sendRes = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.MAIL_FROM || 'Voiceprint <noreply@voiceprint-app.com>',
        to: [rows[0].email],
        reply_to: user.email,
        subject,
        html,
      }),
    });
    if (!sendRes.ok) {
      const detail = await sendRes.text();
      res.status(502).json({ error: { message: detail || 'Email send failed.' } });
      return;
    }
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: { message: String((err && err.message) || err) } });
  }
}
