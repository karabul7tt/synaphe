// Vercel Serverless Function: POST /api/chat
// Synaphe AI v3 — Frontier Multimodal & Cognitive Memory Engine:
//   - Deep Reasoning with Gemini thinkingConfig + Derin / Dengeli mode
//   - Multimodal Vision & File Analysis (images + code/text attachments)
//   - Live Google Search Grounding with real clickable web source citations
//   - Elite multi-domain System Instruction + Eidetis Temporal/AGM Memory Protocol
//   - Unconstrained 8192-token Markdown + hidden <synaphe_memory> extraction

const BALANCED_MODELS = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest'
];

const DEEP_MODELS = [
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite'
];

function needsDeepReasoning(msg, mode) {
  if (mode === 'deep') return true;
  const s = msg.toLowerCase();
  if (msg.length > 260) return true;
  return /\b(kod|code|python|javascript|typescript|swift|sql|react|fastapi|mimari|algoritma|hata|bug|debug|refactor|kanıt|ispat|teorem|analiz|strateji|karşılaştır|planla|optimize|matematik|integral|türev|api|veritabanı|sistem tasarımı|neden|nasıl çalışır|detaylı|kapsamlı)\b/i.test(s);
}

function needsLiveSearch(msg) {
  const s = msg.toLowerCase();
  return /\b(bugün|güncel|son dakika|haber|hava durumu|dolar|euro|altın|bitcoin|btc|eth|kur|kaç tl|fiyatı|maç|skor|seçim|2025|2026|şimdi|canlı|borsa|bist|kim kazandı|son durum)\b/i.test(s);
}

function extractMemoryTag(rawText) {
  let reply = String(rawText || '').trim();
  let facts = [];
  const tagRegex = /<synaphe_memory>([\s\S]*?)<\/synaphe_memory>/i;
  const match = reply.match(tagRegex);
  if (match) {
    reply = reply.replace(tagRegex, '').trim();
    try {
      const parsed = JSON.parse(match[1].trim());
      if (Array.isArray(parsed)) {
        facts = parsed.filter(f => f && f.relation && f.value);
      }
    } catch (_) {
      facts = [];
    }
  }
  return { reply, facts };
}

function extractGroundingSources(data) {
  const chunks = data?.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
  const seen = new Set();
  const sources = [];
  for (const ch of chunks) {
    const uri = ch?.web?.uri;
    const title = ch?.web?.title;
    if (uri && !seen.has(uri)) {
      seen.add(uri);
      sources.push({ title: String(title || uri).slice(0, 60), url: uri });
      if (sources.length >= 4) break;
    }
  }
  return sources;
}

function buildSystemInstruction(userName, memoryContext, nowStr, isDeep) {
  const knownName = userName && userName !== 'Kullanıcı' && userName !== 'Misafir';
  const nameLine = knownName
    ? `Kullanıcının adı: ${userName}. Gerektiğinde doğal biçimde adıyla hitap et.`
    : `Kullanıcının adını henüz bilmiyorsun; doğal hitap et ve asla "Misafir" veya "Kullanıcı" diye seslenme.`;

  const depthLine = isDeep
    ? `MOD: DERİN AKIL YÜRÜTME — Cevap vermeden önce problemi içten içe adım adım analiz et, kenar durumları ve varsayımları doğrula, ardından en net, eksiksiz ve üst düzey çözümü sun.`
    : `MOD: DENGELİ — Sorunun karmaşıklığına göre hız ve derinliği mükemmel dengele.`;

  return `Sen SYNAPHE'sin — en üst düzey akıl yürütme, yazılım mühendisliği, bilim, matematik, tasarım, ürün stratejisi ve kişisel rehberlik yeteneklerine sahip, kalıcı Eidetis bilişsel hafızalı yapay zekâ asistanısın.

GÜNCEL TARİH VE SAAT (Türkiye): ${nowStr}
${nameLine}
${depthLine}

DOĞRULANMIŞ KİŞİSEL HAFIZA (EİDETİS BİLİŞSEL GRAF):
${memoryContext}

ÜST DÜZEY ZEKÂ VE YANIT PROTOKOLÜN:
1. **Keskin Analiz & Sıfır Laf Kalabalığı:** Sorunun gerçek niyetini ilk bakışta kavra. "Harika bir soru!", "Elbette yardımcı olabilirim!" gibi klişe ve yapay girişler yapma. Doğrudan en yüksek değerli yanıtla başla.
2. **Mühendislik & Kod Mükemmelliği:** Kod, hata ayıklama veya mimari istendiğinde:
   - Önce kök nedeni (root cause) netçe açıkla.
   - Yarım/placeholder değil; doğrudan çalışan, modern, güvenli, kenar durumları ele alınmış tam kod yaz.
   - Her kod bloğunda dil etiketini belirt (\`\`\`python, \`\`\`js, \`\`\`swift, \`\`\`sql vb.).
3. **Matematik, Mantık & Strateji:** Hesaplamalarda ve mantık sorularında sonucu içten içe çift kontrol et; karar/karşılaştırma sorularında net tablo veya artı/eksi + somut tavsiye sun.
4. **Eidetis Zamansal & Çelişki Muhakemesi:**
   - Hafızadaki **AKTİF** kayıtları bugünkü gerçek, **[eski] ARŞİV** kayıtlarını geçmiş tarihçe, **gelecek_konum / plan** kayıtlarını yaklaşan gelecek olarak ayırt et.
   - Hafızada olmayan kişisel bilgileri asla uydurma; bilmediğin bir güncel veride uydurmak yerine açıkça belirt.
5. **Görsel & Dosya Analizi:** Kullanıcı fotoğraf, ekran görüntüsü veya kod/metin dosyası gönderirse içeriği satır satır, detay atlamadan incele ve somut çözümler üret.
6. **Doğal, Akıcı Türkçe:** Zeki, samimi, net ve akıcı Türkçe kullan. Asla "Eidetis belleğin boş", "hafıza grafiğine kaydedildi", "veritabanına eklendi" gibi robotik ifadeler kullanma.
7. **Uzunluk Kalibrasyonu:** Gündelik kısa mesajlara 1–3 cümleyle doğal yanıt ver; teknik, yaratıcı veya analitik sorularda başlıklar, maddeler ve tablolarla kapsamlı ve okunaklı yanıt üret.

GİZLİ HAFIZA ÇIKARIMI (YALNIZCA YENİ KİŞİSEL BİLGİ VARSA):
Kullanıcı bu mesajında kendisi hakkında YENİ ve kalıcı bir kişisel gerçek paylaştıysa (adı, konumu, taşınma planı, mesleği/bölümü, hedefleri, tercihleri, projeleri, ilişkileri, sınav notu, önemli planı), yanıtının EN SONUNA şu gizli etiketi ekle:
<synaphe_memory>[{"relation":"konum","value":"İzmir","detail":"Kısa bağlam"}]</synaphe_memory>
İzin verilen relation türleri: "isim", "konum", "gelecek_konum", "iş", "hedef", "tercih", "proje", "plan", "arkadaşı", "sevgilisi", "sınav_notu", "not".
- Gelecek zamanlı taşınma için "gelecek_konum" kullan, mevcut "konum"u ezme.
- Yeni bir kişisel bilgi YOKSA <synaphe_memory> etiketini HİÇ EKLEME.`;
}

async function callGeminiModel({ apiKey, model, systemInstruction, contents, useSearch, useThinking, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const generationConfig = {
      temperature: useThinking ? 0.35 : 0.45,
      topP: 0.92,
      maxOutputTokens: 8192
    };
    if (useThinking && model === 'gemini-2.5-flash') {
      generationConfig.thinkingConfig = { thinkingBudget: 3072 };
    }

    const body = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig
    };
    if (useSearch) {
      body.tools = [{ googleSearch: {} }];
    }

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey)}`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    clearTimeout(timer);
    if (!resp.ok) return { ok: false, status: resp.status };
    const data = await resp.json();
    const parts = data?.candidates?.[0]?.content?.parts || [];
    // Filter out internal thought parts if present, keep only visible answer parts
    const text = parts
      .filter(p => !p.thought && typeof p.text === 'string')
      .map(p => p.text)
      .join('')
      .trim();
    if (!text) return { ok: false, status: 502 };
    const sources = extractGroundingSources(data);
    return { ok: true, text, sources };
  } catch (_) {
    clearTimeout(timer);
    return { ok: false, status: 504 };
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const apiKey = (process.env.GEMINI_API_KEY || '').trim();

  if (req.method === 'GET') {
    return res.status(200).json({
      ok: true,
      service: 'Synaphe Eidetis Cloud AI v3',
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
    const message = String(body.message || '').trim().slice(0, 14000);
    const userName = String(body.userName || '').trim().slice(0, 60);
    const memoryContext = String(body.memoryContext || 'Henüz kayıtlı bilgi yok.').slice(0, 8000);
    const thinkingMode = String(body.thinkingMode || 'balanced');
    const rawHistory = Array.isArray(body.history) ? body.history.slice(-24) : [];
    const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 3) : [];

    if (!message && !attachments.length) {
      return res.status(400).json({ error: 'Boş mesaj gönderilemez.' });
    }

    const nowStr = new Date().toLocaleString('tr-TR', {
      timeZone: 'Europe/Istanbul',
      dateStyle: 'full',
      timeStyle: 'short'
    });
    const deep = needsDeepReasoning(message, thinkingMode);
    const liveSearch = !attachments.length && needsLiveSearch(message);
    const systemInstruction = buildSystemInstruction(userName, memoryContext, nowStr, deep);

    // Build real multi-turn contents
    const contents = [];
    for (const m of rawHistory) {
      const txt = String(m?.text || '').trim().slice(0, 3000);
      if (!txt) continue;
      const role = m.role === 'user' ? 'user' : 'model';
      if (contents.length && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts[0].text += '\n' + txt;
      } else {
        contents.push({ role, parts: [{ text: txt }] });
      }
    }

    // Build current user turn parts (text + optional image/text attachments)
    const userParts = [];
    let finalUserText = message || 'Bu ekli içeriği incele ve açıkla.';
    for (const att of attachments) {
      if (!att || !att.data) continue;
      const mime = String(att.mimeType || '');
      if (mime.startsWith('image/')) {
        userParts.push({
          inlineData: {
            mimeType: mime,
            data: String(att.data).replace(/^data:[^;]+;base64,/, '')
          }
        });
      } else if (att.textContent) {
        finalUserText += `\n\n--- EKLİ DOSYA: ${String(att.name || 'dosya').slice(0, 80)} ---\n${String(att.textContent).slice(0, 12000)}`;
      }
    }
    userParts.unshift({ text: finalUserText });

    if (contents.length && contents[contents.length - 1].role === 'user') {
      contents[contents.length - 1].parts = userParts;
    } else {
      contents.push({ role: 'user', parts: userParts });
    }
    while (contents.length > 1 && contents[0].role !== 'user') {
      contents.shift();
    }

    const modelQueue = deep ? DEEP_MODELS : BALANCED_MODELS;

    let lastStatus = 0;
    for (const model of modelQueue) {
      const timeoutMs = model.includes('pro') ? 26000 : 20000;
      let result = await callGeminiModel({
        apiKey,
        model,
        systemInstruction,
        contents,
        useSearch: liveSearch,
        useThinking: deep,
        timeoutMs
      });

      // Graceful fallback if thinkingConfig or googleSearch caused an error on a model
      if (!result.ok && (liveSearch || deep)) {
        result = await callGeminiModel({
          apiKey,
          model,
          systemInstruction,
          contents,
          useSearch: false,
          useThinking: false,
          timeoutMs
        });
      }

      lastStatus = result.status || lastStatus;
      if (result.ok && result.text) {
        const { reply, facts } = extractMemoryTag(result.text);
        if (reply) {
          return res.status(200).json({
            configured: true,
            model,
            facts,
            sources: result.sources || [],
            reply
          });
        }
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
