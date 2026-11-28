// Vercel Serverless Function: POST /api/image
// Real AI Image Generation using verified Gemini 3.1 / 2.5 / 3 Pro Image models

const GEMINI_IMAGE_MODELS = [
  'gemini-3.1-flash-image',
  'gemini-2.5-flash-image',
  'gemini-3-pro-image',
  'gemini-3.1-flash-lite-image',
  'gemini-3.1-flash-image-preview',
  'gemini-3-pro-image-preview'
];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) {
    return res.status(503).json({ error: 'GEMINI_API_KEY tanımlı değil.' });
  }

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const prompt = String(body.prompt || '').trim().slice(0, 2000);
    if (!prompt) return res.status(400).json({ error: 'Görsel açıklaması boş olamaz.' });

    let lastErr = '';
    for (const model of GEMINI_IMAGE_MODELS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 35000);
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [{ text: `Generate a high-resolution, richly detailed, visually stunning image based on this description (do not add watermarks): ${prompt}` }]
            }],
            generationConfig: {
              responseModalities: ['IMAGE', 'TEXT']
            }
          }),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!resp.ok) {
          lastErr = `${model}: HTTP ${resp.status}`;
          continue;
        }
        const data = await resp.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const imgPart = parts.find(p => p.inlineData && p.inlineData.data);
        if (imgPart) {
          const mime = imgPart.inlineData.mimeType || 'image/png';
          const caption = parts.filter(p => !p.thought && p.text).map(p => p.text).join(' ').trim();
          return res.status(200).json({
            ok: true,
            model,
            imageUrl: `data:${mime};base64,${imgPart.inlineData.data}`,
            caption: caption || 'Görselin hazır.'
          });
        }
      } catch (e) {
        clearTimeout(timer);
        lastErr = `${model}: ${e?.message || 'timeout'}`;
        continue;
      }
    }

    return res.status(502).json({
      error: 'Görsel şu an üretilemedi, lütfen tekrar dene.',
      detail: lastErr
    });
  } catch (err) {
    return res.status(500).json({ error: 'Görsel üretim hatası', detail: String(err?.message || err) });
  }
}
