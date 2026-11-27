// Vercel Serverless Function: POST /api/chat
// Uses server-side GEMINI_API_KEY (Vercel Environment Variable) so end users
// NEVER need to enter their own API key.

const MODELS = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest'
];

function parseJsonResilient(raw) {
  if (!raw) return null;
  let s = raw.trim();
  if (s.startsWith('```')) {
    s = s.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  }
  try {
    return JSON.parse(s);
  } catch (_) {
    const m = s.match(/\{[\s\S]*\}/);
    if (m) {
      try { return JSON.parse(m[0]); } catch (_) { return null; }
    }
    return null;
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const apiKey = (process.env.GEMINI_API_KEY || '').trim();

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'Synaphe Eidetis Cloud API',
      configured: Boolean(apiKey)
    });
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  if (!apiKey) {
    return res.status(503).json({
      configured: false,
      error: 'SUNUCU_API_ANAHTARI_EKSIK',
      message: 'Vercel Environment Variables içinde GEMINI_API_KEY tanımlı değil.'
    });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const message = String(body.message || '').trim().slice(0, 6000);
    const userName = String(body.userName || 'Kullanıcı').trim().slice(0, 60);
    const memoryContext = String(body.memoryContext || 'Henüz kayıtlı hafıza düğümü yok.').slice(0, 6000);
    const history = Array.isArray(body.history) ? body.history.slice(-14) : [];

    if (!message) {
      return res.status(400).json({ error: 'Boş mesaj gönderilemez.' });
    }

    const historyText = history.length
      ? history.map(m => `${m.role === 'user' ? userName : 'Synaphe'}: ${String(m.text || '').slice(0, 500)}`).join('\n')
      : 'Yeni sohbet başlangıcı.';

    const nowStr = new Date().toLocaleString('tr-TR', { timeZone: 'Europe/Istanbul' });

    const prompt = `Sen SYNAPHE'sin — modern, zeki, zarif ve kalıcı hafızaya sahip kişisel yapay zekâ asistanı.
Kullanıcı adı: ${userName === 'Kullanıcı' || userName === 'Misafir' ? 'Henüz bilinmiyor (doğal hitap et, "Misafir" deme!)' : userName}.
Güncel tarih ve saat (TR): ${nowStr}

KİŞİSEL HAFIZA (Yalnızca doğrulanmış kayıtlar):
${memoryContext}

SON SOHBET GEÇMİŞİ:
${historyText}

KULLANICININ MESAJI: "${message}"

KURALLAR:
1. Doğal, samimi, akıcı ve profesyonel bir Türkçe ile yanıt ver (Claude / ChatGPT / Gemini kalitesinde).
2. Asla "Eidetis belleğin boş bir sayfa", "hafıza grafiğine kaydedildi", "veritabanına eklendi", "Misafir" gibi robotik veya teknik/tez ifadeleri KULLANMA. Normal, üst düzey bir yapay zekâ asistanı gibi konuş.
3. Yalnızca yukarıdaki hafıza ve sohbet geçmişindeki kişisel bilgilere dayan; kişisel bilgi uydurma.
4. Kullanıcı kendisi, adı, konumu, taşınma planı, işi, hedefleri, tercihleri, projeleri, ilişkileri veya planları hakkında YENİ bir bilgi veriyorsa bunu "facts" dizisine çıkar:
   - relation: "isim" | "konum" | "gelecek_konum" | "hedef" | "tercih" | "proje" | "plan" | "arkadaşı" | "sevgilisi" | "sınav_notu" | "not"
   - value: kısa, temiz değer
   - Gelecek zamanlı taşınma için "gelecek_konum" kullan, mevcut "konum"u ezme.
5. Sadece selamlaşma, sohbet veya genel bir soru ise "facts" boş [] olsun.

Sadece geçerli JSON döndür:
{
  "intent": "QUERY_OR_ADVICE" | "FACT_STATEMENT" | "FACT_AND_QUERY",
  "facts": [
    {"relation": "konum", "value": "İzmir", "detail": "Kısa bağlam"}
  ],
  "reply": "Kullanıcıya verilecek doğal, zeki Türkçe yanıt"
}`;

    const payload = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.4,
        maxOutputTokens: 2048,
        responseMimeType: 'application/json'
      }
    };

    let lastStatus = 0;
    for (const model of MODELS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 18000);
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: controller.signal
        });
        clearTimeout(timer);
        lastStatus = resp.status;
        if (!resp.ok) continue;
        const data = await resp.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const rawText = parts.map(p => p.text || '').join('').trim();
        const parsed = parseJsonResilient(rawText);
        if (parsed && parsed.reply) {
          return res.status(200).json({
            configured: true,
            model,
            intent: parsed.intent || 'QUERY_OR_ADVICE',
            facts: Array.isArray(parsed.facts) ? parsed.facts : [],
            reply: String(parsed.reply).trim()
          });
        }
      } catch (_) {
        clearTimeout(timer);
        continue;
      }
    }

    return res.status(502).json({
      configured: true,
      lastStatus,
      error: 'Model yanıt üretemedi, lütfen tekrar deneyin.'
    });
  } catch (err) {
    return res.status(500).json({ error: 'Sunucu hatası', detail: String(err?.message || err) });
  }
}
