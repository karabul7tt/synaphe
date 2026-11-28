// Vercel Serverless Function: POST /api/image
// Real AI Image Generation:
//   1. Tries Gemini native image models (gemini-3.1-flash-image, gemini-2.5-flash-image, gemini-3-pro-image)
//   2. If Gemini image tier returns 429 (quota limit), translates/enhances prompt via Gemini 3 Flash
//      and generates a high-res Flux image server-side via Pollinations so users NEVER hit a 429 dead-end.

const GEMINI_IMAGE_MODELS = [
  'gemini-3.1-flash-image',
  'gemini-2.5-flash-image',
  'gemini-3-pro-image'
];

async function enhancePromptToEnglish(apiKey, rawPrompt) {
  for (const m of ['gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite']) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{
              text: `Translate this image request into a vivid, cinematic, detailed English image-generation prompt (under 45 words, no quotes, no extra commentary): ${rawPrompt}`
            }]
          }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 120 }
        })
      });
      if (!resp.ok) continue;
      const data = await resp.json();
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .filter(p => !p.thought && p.text)
        .map(p => p.text)
        .join(' ')
        .trim();
      if (text) return text;
    } catch (_) {
      continue;
    }
  }
  return rawPrompt;
}

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

    // 1. Try Gemini native image models first
    for (const model of GEMINI_IMAGE_MODELS) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 16000);
      try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{
              role: 'user',
              parts: [{ text: `Generate a high-resolution, richly detailed, visually stunning image: ${prompt}` }]
            }],
            generationConfig: { responseModalities: ['IMAGE', 'TEXT'] }
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
          return res.status(200).json({
            ok: true,
            model,
            imageUrl: `data:${mime};base64,${imgPart.inlineData.data}`,
            caption: 'Görselin hazır.'
          });
        }
      } catch (_) {
        clearTimeout(timer);
        continue;
      }
    }

    // 2. Smart Flux fallback (translates Turkish -> detailed English via Gemini 3 Flash, renders HD image)
    const englishPrompt = await enhancePromptToEnglish(apiKey, prompt);
    const seed = Math.floor(Math.random() * 999999);
    const fluxUrl = `https://image.pollinations.ai/prompt/${encodeURIComponent(englishPrompt)}?width=1024&height=1024&model=flux&nologo=true&seed=${seed}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 35000);
    try {
      const imgResp = await fetch(fluxUrl, {
        headers: { 'User-Agent': 'SynapheAI/6.0' },
        signal: controller.signal
      });
      clearTimeout(timer);
      if (imgResp.ok) {
        const buf = Buffer.from(await imgResp.arrayBuffer());
        const mime = imgResp.headers.get('content-type') || 'image/jpeg';
        if (buf.length > 2000) {
          return res.status(200).json({
            ok: true,
            model: 'synaphe-flux-hd',
            imageUrl: `data:${mime};base64,${buf.toString('base64')}`,
            caption: 'Görselin hazır.'
          });
        }
      }
    } catch (_) {
      clearTimeout(timer);
    }

    return res.status(502).json({
      error: 'Görsel şu an üretilemedi, lütfen birkaç saniye sonra tekrar dene.'
    });
  } catch (err) {
    return res.status(500).json({ error: 'Görsel üretim hatası', detail: String(err?.message || err) });
  }
}
