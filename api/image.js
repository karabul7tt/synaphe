// Vercel Serverless Function: POST /api/image
// Real AI Image Generation using Gemini / Imagen API with server-side GEMINI_API_KEY

const GEMINI_IMAGE_MODELS = [
  'gemini-2.5-flash-image-preview',
  'gemini-2.0-flash-exp-image-generation'
];

const IMAGEN_MODELS = [
  'imagen-3.0-generate-002',
  'imagen-3.0-fast-generate-001'
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

    // 1. Try Gemini native multimodal image generation models first
    for (const model of GEMINI_IMAGE_MODELS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 28000);
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: `Create a high-quality, visually stunning image: ${prompt}` }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
          }),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!resp.ok) continue;
        const data = await resp.json();
        const parts = data?.candidates?.[0]?.content?.parts || [];
        const imgPart = parts.find(p => p.inlineData && p.inlineData.data);
        if (imgPart) {
          const mime = imgPart.inlineData.mimeType || 'image/png';
          const caption = parts.filter(p => p.text).map(p => p.text).join(' ').trim();
          return res.status(200).json({
            ok: true,
            model,
            imageUrl: `data:${mime};base64,${imgPart.inlineData.data}`,
            caption: caption || 'Görsel oluşturuldu.'
          });
        }
      } catch (_) {
        clearTimeout(timer);
        continue;
      }
    }

    // 2. Fallback to Imagen 3 predict endpoint
    for (const model of IMAGEN_MODELS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 28000);
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:predict?key=${encodeURIComponent(apiKey)}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            instances: [{ prompt }],
            parameters: { sampleCount: 1 }
          }),
          signal: controller.signal
        });
        clearTimeout(timer);
        if (!resp.ok) continue;
        const data = await resp.json();
        const b64 = data?.predictions?.[0]?.bytesBase64Encoded;
        const mime = data?.predictions?.[0]?.mimeType || 'image/png';
        if (b64) {
          return res.status(200).json({
            ok: true,
            model,
            imageUrl: `data:${mime};base64,${b64}`,
            caption: 'Görsel oluşturuldu.'
          });
        }
      } catch (_) {
        clearTimeout(timer);
        continue;
      }
    }

    return res.status(502).json({
      error: 'Bu API anahtarında görsel üretim modeli şu an yanıt vermedi. Lütfen tekrar dene veya farklı bir açıklama yaz.'
    });
  } catch (err) {
    return res.status(500).json({ error: 'Görsel üretim hatası', detail: String(err?.message || err) });
  }
}
