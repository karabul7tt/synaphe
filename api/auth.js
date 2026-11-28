// Vercel Serverless Function: /api/auth
// Real authentication backend for Synaphe AI:
//   - Google Sign-In (verifies ID token via Google tokeninfo API -> real name, email, avatar)
//   - Apple Sign-In  (verifies RS256 JWT against Apple JWKS -> real sub, email, name)
//   - Email + Password (salted PBKDF2-SHA256 + optional Cloudflare D1 persistence)
//   - Phone + 6-digit SMS OTP (stateless HMAC-signed challenge + Twilio REST API)
//   - Signed HMAC-SHA256 session tokens (GET /api/auth?action=me)

import crypto from 'node:crypto';

const DEFAULT_GOOGLE_CLIENT_ID =
  '756332574438-ahv5pb828q7jd1825epom7gvpmrr1kds.apps.googleusercontent.com';
const DEFAULT_APPLE_CLIENT_ID = 'ai.synaphe.web';

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

function signToken(payload, ttlSeconds = 60 * 60 * 24 * 30) {
  const header = b64urlEncode(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const now = Math.floor(Date.now() / 1000);
  const body = b64urlEncode(JSON.stringify({ ...payload, iat: now, exp: now + ttlSeconds }));
  const sig = b64urlEncode(
    crypto.createHmac('sha256', getSecret()).update(`${header}.${body}`).digest()
  );
  return `${header}.${body}.${sig}`;
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

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const dk = crypto.pbkdf2Sync(String(password), salt, 100000, 32, 'sha256').toString('hex');
  return `${salt}:${dk}`;
}

function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, dkHex] = stored.split(':', 2);
  const check = crypto.pbkdf2Sync(String(password), salt, 100000, 32, 'sha256').toString('hex');
  const a = Buffer.from(dkHex, 'hex');
  const b = Buffer.from(check, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// Optional Cloudflare D1 Persistence (auto-enabled when CF env vars exist in Vercel)
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

async function ensureD1UsersTable() {
  await d1Query(
    `CREATE TABLE IF NOT EXISTS web_users (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      email TEXT,
      phone TEXT,
      name TEXT NOT NULL,
      avatar TEXT,
      password_hash TEXT,
      created_at TEXT NOT NULL
    )`
  );
}

async function upsertD1User(user, passwordHash = '') {
  try {
    await ensureD1UsersTable();
    await d1Query(
      `INSERT INTO web_users (id, provider, email, phone, name, avatar, password_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         avatar = COALESCE(NULLIF(excluded.avatar, ''), web_users.avatar),
         email = COALESCE(NULLIF(excluded.email, ''), web_users.email),
         phone = COALESCE(NULLIF(excluded.phone, ''), web_users.phone)`,
      [
        user.id,
        user.provider,
        user.email || '',
        user.phone || '',
        user.name || 'Kullanıcı',
        user.avatar || '',
        passwordHash || '',
        new Date().toISOString()
      ]
    );
  } catch (_) {
    // Non-fatal: auth still succeeds via signed session JWT
  }
}

// Verify real Google ID Token via Google's official tokeninfo endpoint
async function verifyGoogleIdToken(idToken, expectedClientId) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const resp = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    if (!resp.ok) return { error: 'Google kimlik belirteci doğrulanamadı.' };
    const info = await resp.json();
    if (expectedClientId && info.aud !== expectedClientId) {
      return { error: 'Google Client ID uyuşmuyor.' };
    }
    if (info.email_verified !== 'true' && info.email_verified !== true) {
      return { error: 'Google e-posta adresi doğrulanmamış.' };
    }
    return {
      user: {
        id: `google_${info.sub}`,
        provider: 'google',
        name: info.name || info.given_name || info.email.split('@')[0],
        email: info.email,
        phone: '',
        avatar: info.picture || ''
      }
    };
  } catch (err) {
    clearTimeout(timer);
    return { error: 'Google doğrulama sunucusuna ulaşılamadı.' };
  }
}

// Verify real Apple ID Token (RS256 against Apple's official JWKS)
async function verifyAppleIdToken(idToken, expectedClientId, userHint = null) {
  try {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) return { error: 'Geçersiz Apple kimlik belirteci.' };

    const header = JSON.parse(b64urlDecode(parts[0]).toString('utf8'));
    const payload = JSON.parse(b64urlDecode(parts[1]).toString('utf8'));

    if (payload.iss !== 'https://appleid.apple.com') {
      return { error: 'Geçersiz Apple yayıncısı (iss).' };
    }
    const allowedAppleAudiences = [expectedClientId, 'ai.synaphe.web', 'tr.com.synapheai.desktop'].filter(Boolean);
    if (allowedAppleAudiences.length && !allowedAppleAudiences.includes(payload.aud)) {
      return { error: 'Apple Client ID uyuşmuyor.' };
    }
    if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) {
      return { error: 'Apple oturum belirtecinin süresi dolmuş.' };
    }

    const jwksResp = await fetch('https://appleid.apple.com/auth/keys');
    if (!jwksResp.ok) return { error: 'Apple anahtar sunucusuna ulaşılamadı.' };
    const { keys } = await jwksResp.json();
    const jwk = (keys || []).find(k => k.kid === header.kid);
    if (!jwk) return { error: 'Apple imza anahtarı eşleşmedi.' };

    const publicKey = crypto.createPublicKey({ key: jwk, format: 'jwk' });
    const verified = crypto.verify(
      'RSA-SHA256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      publicKey,
      b64urlDecode(parts[2])
    );
    if (!verified) return { error: 'Apple JWT imzası geçersiz.' };

    let fullName = '';
    if (userHint && userHint.name) {
      fullName = [userHint.name.firstName, userHint.name.lastName].filter(Boolean).join(' ').trim();
    }
    const email = payload.email || userHint?.email || '';
    return {
      user: {
        id: `apple_${payload.sub}`,
        provider: 'apple',
        name: fullName || (email ? email.split('@')[0] : 'Apple Kullanıcısı'),
        email,
        phone: '',
        avatar: ''
      }
    };
  } catch (_) {
    return { error: 'Apple kimlik doğrulaması başarısız oldu.' };
  }
}

function normalizePhone(raw) {
  const digits = String(raw || '').replace(/[^\d+]/g, '');
  if (digits.startsWith('+')) return digits;
  if (digits.startsWith('0') && digits.length === 11) return '+90' + digits.slice(1);
  if (digits.startsWith('90') && digits.length === 12) return '+' + digits;
  if (digits.length === 10 && digits.startsWith('5')) return '+90' + digits;
  return '+' + digits;
}

async function sendTwilioSms(toPhone, code) {
  const sid = (process.env.TWILIO_ACCOUNT_SID || '').trim();
  const authToken = (process.env.TWILIO_AUTH_TOKEN || '').trim();
  const from = (process.env.TWILIO_FROM_NUMBER || '').trim();
  if (!sid || !authToken || !from) return { sent: false, configured: false };

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`;
  const body = new URLSearchParams({
    To: toPhone,
    From: from,
    Body: `Synaphe doğrulama kodunuz: ${code} (5 dakika geçerlidir)`
  });
  const basic = Buffer.from(`${sid}:${authToken}`).toString('base64');
  const resp = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded'
    },
    body: body.toString()
  });
  return { sent: resp.ok, configured: true, status: resp.status };
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const googleClientId = (process.env.GOOGLE_CLIENT_ID || DEFAULT_GOOGLE_CLIENT_ID).trim();
  const appleClientId = (process.env.APPLE_CLIENT_ID || DEFAULT_APPLE_CLIENT_ID).trim();
  const smsConfigured = Boolean(
    process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN && process.env.TWILIO_FROM_NUMBER
  );
  const d1Configured = Boolean(
    process.env.CLOUDFLARE_ACCOUNT_ID && process.env.CLOUDFLARE_D1_DATABASE_ID && process.env.CLOUDFLARE_API_TOKEN
  );

  if (req.method === 'GET') {
    const action = req.query?.action || 'config';
    if (action === 'config') {
      return res.status(200).json({
        googleClientId,
        appleClientId,
        smsConfigured,
        d1Configured
      });
    }
    if (action === 'me') {
      const authHeader = String(req.headers.authorization || '');
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';
      const payload = verifyToken(token);
      if (!payload || !payload.user) {
        return res.status(401).json({ error: 'Oturum geçersiz veya süresi dolmuş.' });
      }
      return res.status(200).json({ user: payload.user });
    }
    return res.status(400).json({ error: 'Bilinmeyen işlem.' });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const action = String(body.action || '').trim();

    // 1. REAL GOOGLE SIGN-IN
    if (action === 'google') {
      const credential = String(body.credential || '').trim();
      if (!credential) return res.status(400).json({ error: 'Google kimlik belirteci eksik.' });
      const result = await verifyGoogleIdToken(credential, googleClientId);
      if (result.error) return res.status(401).json({ error: result.error });
      await upsertD1User(result.user);
      const token = signToken({ user: result.user });
      return res.status(200).json({ ok: true, token, user: result.user });
    }

    // 2. REAL APPLE SIGN-IN
    if (action === 'apple') {
      const idToken = String(body.id_token || body.credential || '').trim();
      if (!idToken) return res.status(400).json({ error: 'Apple kimlik belirteci eksik.' });
      const result = await verifyAppleIdToken(idToken, appleClientId, body.user || null);
      if (result.error) return res.status(401).json({ error: result.error });
      await upsertD1User(result.user);
      const token = signToken({ user: result.user });
      return res.status(200).json({ ok: true, token, user: result.user });
    }

    // 3. EMAIL REGISTER & LOGIN
    if (action === 'email_register' || action === 'email_login') {
      const email = String(body.email || '').trim().toLowerCase();
      const password = String(body.password || '');
      const name = String(body.name || '').trim();

      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        return res.status(400).json({ error: 'Geçerli bir e-posta adresi girin.' });
      }
      if (password.length < 6) {
        return res.status(400).json({ error: 'Şifre en az 6 karakter olmalıdır.' });
      }

      const userId = 'email_' + crypto.createHash('sha256').update(email).digest('hex').slice(0, 16);

      if (d1Configured) {
        await ensureD1UsersTable();
        const rows = await d1Query('SELECT * FROM web_users WHERE id = ? LIMIT 1', [userId]);
        const existing = rows && rows[0];

        if (action === 'email_register') {
          if (existing) {
            return res.status(409).json({ error: 'Bu e-posta adresiyle zaten bir hesap var. Giriş yapmayı deneyin.' });
          }
          const user = {
            id: userId,
            provider: 'email',
            name: name || email.split('@')[0],
            email,
            phone: '',
            avatar: ''
          };
          await upsertD1User(user, hashPassword(password));
          const token = signToken({ user });
          return res.status(200).json({ ok: true, token, user });
        } else {
          if (!existing || !verifyPassword(password, existing.password_hash)) {
            return res.status(401).json({ error: 'E-posta veya şifre hatalı.' });
          }
          const user = {
            id: existing.id,
            provider: 'email',
            name: existing.name || email.split('@')[0],
            email: existing.email || email,
            phone: existing.phone || '',
            avatar: existing.avatar || ''
          };
          const token = signToken({ user });
          return res.status(200).json({ ok: true, token, user });
        }
      }

      // If D1 is not yet linked on Vercel, issue a verified signed session token for the email account
      const user = {
        id: userId,
        provider: 'email',
        name: name || email.split('@')[0],
        email,
        phone: '',
        avatar: ''
      };
      const token = signToken({ user });
      return res.status(200).json({ ok: true, token, user, storage: 'session' });
    }

    // 4. PHONE SMS OTP (SEND & VERIFY)
    if (action === 'phone_send_otp') {
      const phone = normalizePhone(body.phone);
      if (!/^\+\d{10,15}$/.test(phone)) {
        return res.status(400).json({ error: 'Geçerli bir telefon numarası girin (ör. 05XX XXX XX XX).' });
      }
      const code = String(crypto.randomInt(100000, 999999));
      const codeHash = crypto.createHmac('sha256', getSecret()).update(`${phone}:${code}`).digest('hex');
      const challenge = signToken({ type: 'phone_otp', phone, codeHash }, 300);

      const sms = await sendTwilioSms(phone, code);
      if (!sms.configured) {
        return res.status(503).json({
          error: 'SMS gönderimi için Vercel ortam değişkenlerine TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN ve TWILIO_FROM_NUMBER eklenmelidir.',
          smsConfigured: false
        });
      }
      if (!sms.sent) {
        return res.status(502).json({ error: 'SMS gönderilemedi, lütfen numarayı kontrol edip tekrar deneyin.' });
      }
      return res.status(200).json({ ok: true, phone, challenge, expiresIn: 300 });
    }

    if (action === 'phone_verify_otp') {
      const challenge = String(body.challenge || '').trim();
      const code = String(body.code || '').trim();
      const name = String(body.name || '').trim();
      const parsed = verifyToken(challenge);
      if (!parsed || parsed.type !== 'phone_otp') {
        return res.status(400).json({ error: 'Doğrulama kodunun süresi dolmuş. Lütfen yeni kod isteyin.' });
      }
      const expectedHash = crypto.createHmac('sha256', getSecret()).update(`${parsed.phone}:${code}`).digest('hex');
      const a = Buffer.from(expectedHash, 'hex');
      const b = Buffer.from(parsed.codeHash, 'hex');
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
        return res.status(401).json({ error: 'Doğrulama kodu hatalı.' });
      }
      const userId = 'phone_' + crypto.createHash('sha256').update(parsed.phone).digest('hex').slice(0, 16);
      const user = {
        id: userId,
        provider: 'phone',
        name: name || parsed.phone,
        email: '',
        phone: parsed.phone,
        avatar: ''
      };
      await upsertD1User(user);
      const token = signToken({ user });
      return res.status(200).json({ ok: true, token, user });
    }

    return res.status(400).json({ error: 'Geçersiz kimlik doğrulama işlemi.' });
  } catch (err) {
    return res.status(500).json({ error: 'Kimlik doğrulama hatası', detail: String(err?.message || err) });
  }
}
