// Vercel Serverless Function: /api/sync
// Cross-device Cloudflare D1 sync for authenticated Synaphe users (sessions + Eidetis memory graph)

import crypto from 'node:crypto';

function getSecret() {
  return (
    process.env.AUTH_SECRET ||
    process.env.GEMINI_API_KEY ||
    'synaphe-fallback-signing-key-change-in-vercel'
  );
}

function b64urlEncode(input) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(String(input), 'utf8');
  return buf.toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(str) {
  const pad = '='.repeat((4 - (str.length % 4)) % 4);
  const b64 = (str + pad).replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(b64, 'base64');
}

function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [header, body, sig] = parts;
  const expected = b64urlEncode(
    crypto.createHmac('sha256', getSecret()).update(`${header}.${body}`).digest()
  );
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const payload = JSON.parse(b64urlDecode(body).toString('utf8'));
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
    return payload;
  } catch (_) {
    return null;
  }
}

async function d1Query(sql, params = []) {
  const accountId = (process.env.CLOUDFLARE_ACCOUNT_ID || '').trim();
  const dbId = (process.env.CLOUDFLARE_D1_DATABASE_ID || '').trim();
  const apiToken = (process.env.CLOUDFLARE_API_TOKEN || '').trim();
  if (!accountId || !dbId || !apiToken) return null;

  const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${dbId}/query`;
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiToken}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ sql, params })
  });
  if (!resp.ok) return null;
  const data = await resp.json();
  return data?.result?.[0]?.results || [];
}

async function ensureSyncTable() {
  await d1Query(
    `CREATE TABLE IF NOT EXISTS web_user_state (
      user_id TEXT PRIMARY KEY,
      state_json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )`
  );
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const d1Configured = Boolean(
    process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_D1_DATABASE_ID && process.env.CLOUDFLARE_API_TOKEN
  );
  if (!d1Configured) {
    return res.status(200).json({ ok: false, synced: false, configured: false });
  }

  const authHeader = String(req.headers.authorization || '');
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
  const payload = verifyToken(token);
  if (!payload || !payload.user || !payload.user.id) {
    return res.status(401).json({ error: 'Senkronizasyon için giriş yapmalısınız.' });
  }
  const userId = String(payload.user.id);

  try {
    await ensureSyncTable();

    if (req.method === 'GET') {
      const rows = await d1Query(
        'SELECT state_json, updated_at FROM web_user_state WHERE user_id = ? LIMIT 1',
        [userId]
      );
      if (!rows || !rows.length) {
        return res.status(200).json({ ok: true, configured: true, state: null });
      }
      const parsed = JSON.parse(rows[0].state_json);
      return res.status(200).json({ ok: true, configured: true, state: parsed, updatedAt: rows[0].updated_at });
    }

    if (req.method === 'POST') {
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const state = body.state;
      if (!state || typeof state !== 'object') {
        return res.status(400).json({ error: 'Geçersiz durum verisi.' });
      }
      const serialized = JSON.stringify(state).slice(0, 900000);
      const now = new Date().toISOString();
      await d1Query(
        `INSERT INTO web_user_state (user_id, state_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET
           state_json = excluded.state_json,
           updated_at = excluded.updated_at`,
        [userId, serialized, now]
      );
      return res.status(200).json({ ok: true, synced: true, updatedAt: now });
    }

    return res.status(405).json({ error: 'Method not allowed' });
  } catch (err) {
    return res.status(500).json({ error: 'Senkronizasyon hatası', detail: String(err?.message || err) });
  }
}
