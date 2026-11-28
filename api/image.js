// Vercel Serverless Function: POST /api/image
// Fast, Zero-Timeout AI Image Generation:
//   1. Tries Gemini native image generation first (tight 4.5s timeout so Vercel never times out)
//   2. On 429/quota or timeout, translates/enhances prompt via Gemini 3.8 Flash (~1s)
//      and immediately returns a direct Pollinations Flux HD URL for client-side progressive rendering
//      (with turbo fallback URL), eliminating Vercel 502 timeouts completely.

async function enhancePromptToEnglish(apiKey, rawPrompt) {
  if (!apiKey) return rawPrompt;
  for (const m of ['gemini-3.8-flash', 'gemini-3-flash-preview', 'gemini-2.5-flash-lite']) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${encodeURIComponent(apiKey)}`;
      const resp = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{
            role: 'user',
            parts: [{
              text: `Translate and enhance this image request into a vivid, cinematic, ultra-detailed English image-generation prompt (under 40 words, no quotes, no commentary): ${rawPrompt}`
            }]
          }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 100 }
        }),
        signal: controller.signal
      });
      clearTimeout(timer);
      if (!resp.ok) continue;
      const data = await resp.json();
      const text = (data?.candidates?.[0]?.content?.parts || [])
        .filter(p => !p.thought && p.text)
        .map(p => p.text)
        .join(' ')
        .trim()
        .replace(/^["']|["']$/g, '');
      if (text) return text;
    } catch (_) {
      clearTimeout(timer);
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

  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
    const prompt = String(body.prompt || '').trim().slice(0, 2000);
    const alreadyEnglish = Boolean(body.alreadyEnglish);
    if (!prompt) return res.status(400).json({ error: 'Görsel açıklaması boş olamaz.' });

    // 1. Fast attempt with Gemini native image model (4.5s cap so Vercel never 502s)
    if (apiKey) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4500);
      try {
        const model = 'gemini-2.5-flash-image';
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
        if (resp.ok) {
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
        }
      } catch (_) {
        clearTimeout(timer);
      }
    }

    // 2. Instant Flux HD direct URL (browser renders directly with zero Vercel timeout!)
    const englishPrompt = alreadyEnglish ? prompt : await enhancePromptToEnglish(apiKey, prompt);
    const seed = Math.floor(Math.random() * 999999);
    const enc = encodeURIComponent(englishPrompt.slice(0, 420));
    const imageUrl = `https://image.pollinations.ai/prompt/${enc}?width=1024&height=1024&model=flux&nologo=true&seed=${seed}`;
    const fallbackUrl = `https://image.pollinations.ai/prompt/${enc}?width=768&height=768&model=turbo&nologo=true&seed=${seed}`;

    return res.status(200).json({
      ok: true,
      model: 'synaphe-flux-hd',
      imageUrl,
      fallbackUrl,
      enhancedPrompt: englishPrompt,
      caption: 'Görselin hazır.'
    });
  } catch (err) {
    return res.status(500).json({ error: 'Görsel üretim hatası', detail: String(err?.message || err) });
  }
}
