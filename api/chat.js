// Vercel Serverless Function: POST /api/chat
// Synaphe AI v4 — Frontier Agentic, Multimodal & Cognitive Memory Engine:
//   - Principal-Engineer System Architecture (code, debugging, artifacts, data analysis, strategy)
//   - Deep Mode -> Gemini 2.5 Pro + Gemini 2.5 Flash (thinkingBudget: 8192)
//   - Live URL Reader (automatically fetches & reads https:// links pasted by user)
//   - Live Google Search Grounding + clickable web source citations
//   - Multimodal Vision & Multi-File Analysis (up to 6 images/code/data files)
//   - Self-contained Live HTML Artifact generation + Eidetis AGM Memory Graph

const BALANCED_MODELS = [
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite'
];

const DEEP_MODELS = [
  'gemini-3.1-pro-preview',
  'gemini-3.8-flash',
  'gemini-3.7-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-pro',
  'gemini-2.5-flash'
];

function needsDeepReasoning(msg, mode) {
  if (mode === 'deep') return true;
  const s = msg.toLowerCase();
  if (msg.length > 260) return true;
  return /\b(kod|code|python|javascript|typescript|swift|sql|react|fastapi|html|css|oyun|web sitesi|uygulama|dashboard|mimari|algoritma|hata|bug|debug|refactor|kanıt|ispat|teorem|analiz|strateji|karşılaştır|planla|optimize|matematik|integral|türev|api|veritabanı|sistem tasarımı|neden|nasıl çalışır|detaylı|kapsamlı|incele)\b/i.test(s);
}

function needsLiveSearch(msg) {
  const s = msg.toLowerCase();
  return /\b(bugün|güncel|son dakika|haber|hava durumu|dolar|euro|altın|bitcoin|btc|eth|kur|kaç tl|fiyatı|maç|skor|seçim|2025|2026|şimdi|canlı|borsa|bist|kim kazandı|son durum|yeni sürüm|en son)\b/i.test(s);
}

// Safely fetch & extract readable text from up to 2 URLs mentioned in user's message
async function fetchReferencedUrls(msg) {
  const urls = (msg.match(/https?:\/\/[^\s<>"')]+/gi) || []).slice(0, 2);
  if (!urls.length) return '';
  const blocks = [];
  for (const rawUrl of urls) {
    try {
      const u = new URL(rawUrl);
      // Block private/local hosts for SSRF safety
      if (/^(localhost|127\.|10\.|192\.168\.|169\.254\.|0\.0\.0\.0)/i.test(u.hostname)) continue;
      const controller = new AbortController();
      const t = setTimeout(() => controller.abort(), 5000);
      const resp = await fetch(u.toString(), {
        headers: { 'User-Agent': 'SynapheBot/4.0 (+https://www.synapheai.com.tr)' },
        signal: controller.signal
      });
      clearTimeout(t);
      if (!resp.ok) continue;
      const ctype = resp.headers.get('content-type') || '';
      if (!ctype.includes('text') && !ctype.includes('json') && !ctype.includes('xml')) continue;
      let html = await resp.text();
      html = html
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 5000);
      if (html) {
        blocks.push(`--- CANLI WEB SAYFASI İÇERİĞİ (${u.toString()}) ---\n${html}`);
      }
    } catch (_) {
      continue;
    }
  }
  return blocks.join('\n\n');
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

const PERSONA_PROMPTS = {
  general: '',
  architect: 'UZMAN ROLÜN: Kıdemli Yazılım Mimarı & Full-Stack Mühendis. Temiz mimari, tasarım desenleri, performans, güvenlik ve üretime hazır eksiksiz kod önceliğindir.',
  academic: 'UZMAN ROLÜN: Akademik Araştırmacı & Bilim İnsanı. Titiz metodoloji, formel terminoloji, eleştirel değerlendirme ve yapılandırılmış akademik üslup kullan.',
  english: 'UZMAN ROLÜN: Kişisel İngilizce Koçu. Kullanıcının İngilizce cümlelerini nazikçe düzelt, daha doğal (native) alternatifler öner ve gerektiğinde Türkçe kısa açıklamalarla pratik yaptır.',
  strategist: 'UZMAN ROLÜN: Ürün & İş Stratejisti. Karar çerçeveleri, pazar/rekabet analizi, risk-ödül tabloları ve somut adım adım eylem planları sun.'
};

function buildSystemInstruction(userName, memoryContext, nowStr, isDeep, persona = 'general', customInstructions = '') {
  const knownName = userName && userName !== 'Kullanıcı' && userName !== 'Misafir';
  const nameLine = knownName
    ? `Kullanıcının adı: ${userName}. Gerektiğinde doğal biçimde adıyla hitap et.`
    : `Kullanıcının adını henüz bilmiyorsun; doğal hitap et ve asla "Misafir" veya "Kullanıcı" diye seslenme.`;

  const depthLine = isDeep
    ? `MOD: DERİN MÜHENDİSLİK & AKIL YÜRÜTME — Cevap vermeden önce problemi içten içe parçala, tüm kenar durumları, güvenlik ve performans etkilerini kontrol et, sonra eksiksiz ve üst düzey çözüm sun.`
    : `MOD: DENGELİ — Hız ve derinliği sorunun doğasına göre kusursuz dengele.`;

  const personaLine = PERSONA_PROMPTS[persona] ? `\n${PERSONA_PROMPTS[persona]}` : '';
  const customLine = customInstructions ? `\nKULLANICININ ÖZEL TALİMATI (MUTLAKA UY):\n${customInstructions}` : '';

  return `Sen SYNAPHE v6'sın — kıdemli yazılım mimarı, veri bilimci, ürün tasarımcısı, araştırmacı ve kalıcı Eidetis bilişsel hafızalı en üst düzey kişisel yapay zekâ asistanısın.

GÜNCEL TARİH VE SAAT (Türkiye): ${nowStr}
${nameLine}
${depthLine}${personaLine}${customLine}

DOĞRULANMIŞ KİŞİSEL HAFIZA (EİDETİS BİLİŞSEL GRAF):
${memoryContext}

ÜST DÜZEY YETENEK VE ÇALIŞMA PROTOKOLÜN:
1. **Keskin Zekâ & Sıfır Laf Kalabalığı:** Sorunun özünü anında yakala. "Harika bir soru!", "Elbette yardımcı olabilirim!" gibi yapay kalıplar kullanma. Doğrudan yüksek değerli çözümle başla.
2. **İnteraktif Uygulama / Web / Oyun / Grafik Üretimi (Canlı Önizleme):**
   - Kullanıcı bir web sayfası, mini uygulama, oyun, hesap makinesi, dashboard, animasyon veya görselleştirme istediğinde **tek parça, eksiksiz, modern, şık ve doğrudan çalışan** tam bir \`\`\`html ... \`\`\` (CSS + JS içinde gömülü) belgesi üret!
   - Arayüz otomatik olarak \`\`\`html bloklarına **"▶ Canlı Önizle"** ve **"⬇ İndir"** butonları ekler; bu yüzden kodun sıfır harici hata ile tek dosyada kusursuz çalışmasına özen göster.
3. **Kıdemli Mühendislik, Kod & Dosya Analizi:**
   - Kullanıcı kod, ekran görüntüsü, CSV/JSON veya dosya paylaştığında satır satır incele; kök nedenleri, güvenlik açıklarını, performans darboğazlarını ve doğrudan kopyalanıp çalışacak tam çözümü ver.
   - Yarım/placeholder ("// buraya kod gelecek") bırakma; her zaman tam ve çalışan kod yaz.
4. **Matematik, Mantık & Strateji:** Karmaşık hesaplamaları ve mantık sorularını içten içe çift doğrula. Karşılaştırmalarda Markdown tabloları ve net artı/eksi + somut karar önerisi kullan.
5. **Canlı Bilgi & Web Okuma:** Kullanıcı bir URL paylaştıysa verilen canlı sayfa içeriğini temel al. Güncel haber/kur/teknoloji sorularında canlı arama verilerini kullan; bilmediğin bilgiyi asla uydurma.
6. **Eidetis Zamansal & Çelişki Muhakemesi:**
   - Hafızadaki **AKTİF** kayıtları bugünkü gerçek, **[eski] ARŞİV** kayıtlarını geçmiş tarihçe, **gelecek_konum / plan** kayıtlarını yaklaşan gelecek olarak netçe ayır.
   - Asla "Eidetis belleğin boş", "hafıza grafiğine kaydedildi", "veritabanına eklendi" gibi robotik ifadeler kullanma.
7. **Uzunluk Kalibrasyonu:** Gündelik sohbete 1–3 akıcı cümle; teknik, yaratıcı veya analitik görevlere yapılandırılmış, derinlikli ve profesyonel yanıt ver.

GİZLİ HAFIZA ÇIKARIMI (YALNIZCA YENİ KİŞİSEL BİLGİ VARSA):
Kullanıcı bu mesajında kendisi hakkında YENİ ve kalıcı bir kişisel gerçek paylaştıysa (adı, konumu, taşınma planı, mesleği/bölümü, hedefleri, tercihleri, projeleri, ilişkileri, sınav notu, önemli planı), yanıtının EN SONUNA şu gizli etiketi ekle:
<synaphe_memory>[{"relation":"konum","value":"İzmir","detail":"Kısa bağlam"}]</synaphe_memory>
İzin verilen relation türleri: "isim", "konum", "gelecek_konum", "iş", "hedef", "tercih", "proje", "plan", "arkadaşı", "sevgilisi", "sınav_notu", "not".
- Gelecek zamanlı taşınma için "gelecek_konum" kullan, mevcut "konum"u ezme.
- Yeni bir kişisel bilgi YOKSA <synaphe_memory> etiketini HİÇ EKLEME.`;
}

async function callGeminiModel({ apiKey, model, systemInstruction, contents, useSearch, useThinking, thinkingBudget, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const generationConfig = {
      temperature: useThinking ? 0.35 : 0.45,
      topP: 0.92,
      maxOutputTokens: 8192
    };
    if (useThinking && model === 'gemini-2.5-flash') {
      generationConfig.thinkingConfig = { thinkingBudget: thinkingBudget || 4096 };
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
      service: 'Synaphe Eidetis Agentic AI v4',
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
    const message = String(body.message || '').trim().slice(0, 16000);
    const userName = String(body.userName || '').trim().slice(0, 60);
    const memoryContext = String(body.memoryContext || 'Henüz kayıtlı bilgi yok.').slice(0, 8000);
    const thinkingMode = String(body.thinkingMode || 'balanced');
    const persona = String(body.persona || 'general').trim();
    const customInstructions = String(body.customInstructions || '').trim().slice(0, 1500);
    const rawHistory = Array.isArray(body.history) ? body.history.slice(-24) : [];
    const attachments = Array.isArray(body.attachments) ? body.attachments.slice(0, 6) : [];

    if (!message && !attachments.length) {
      return res.status(400).json({ error: 'Boş mesaj gönderilemez.' });
    }

    const nowStr = new Date().toLocaleString('tr-TR', {
      timeZone: 'Europe/Istanbul',
      dateStyle: 'full',
      timeStyle: 'short'
    });
    const deep = needsDeepReasoning(message, thinkingMode);
    const urlContext = await fetchReferencedUrls(message);
    const liveSearch = !attachments.length && !urlContext && needsLiveSearch(message);
    const systemInstruction = buildSystemInstruction(userName, memoryContext, nowStr, deep, persona, customInstructions);

    // Build real multi-turn contents
    const contents = [];
    for (const m of rawHistory) {
      const txt = String(m?.text || '').trim().slice(0, 3500);
      if (!txt) continue;
      const role = m.role === 'user' ? 'user' : 'model';
      if (contents.length && contents[contents.length - 1].role === role) {
        contents[contents.length - 1].parts[0].text += '\n' + txt;
      } else {
        contents.push({ role, parts: [{ text: txt }] });
      }
    }

    const userParts = [];
    let finalUserText = message || 'Bu ekli içeriği detaylıca incele ve açıkla.';
    if (urlContext) {
      finalUserText += `\n\n${urlContext}`;
    }
    for (const att of attachments) {
      if (!att || !att.data) continue;
      const mime = String(att.mimeType || '');
      if (mime.startsWith('image/') || mime === 'application/pdf') {
        userParts.push({
          inlineData: {
            mimeType: mime,
            data: String(att.data).replace(/^data:[^;]+;base64,/, '')
          }
        });
      } else if (att.textContent) {
        finalUserText += `\n\n--- EKLİ DOSYA: ${String(att.name || 'dosya').slice(0, 80)} ---\n${String(att.textContent).slice(0, 14000)}`;
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

    const modelQueue = thinkingMode === 'deep' ? DEEP_MODELS : BALANCED_MODELS;
    const thinkingBudget = thinkingMode === 'deep' ? 8192 : 3072;
    const wantStream = Boolean(body.stream);

    // REAL-TIME SSE STREAMING MODE
    if (wantStream) {
      for (const model of modelQueue) {
        const generationConfig = {
          temperature: deep ? 0.35 : 0.45,
          topP: 0.92,
          maxOutputTokens: 8192
        };
        if (deep && model === 'gemini-2.5-flash') {
          generationConfig.thinkingConfig = { thinkingBudget };
        }
        const reqBody = {
          systemInstruction: { parts: [{ text: systemInstruction }] },
          contents,
          generationConfig
        };
        if (liveSearch) reqBody.tools = [{ googleSearch: {} }];

        const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:streamGenerateContent?alt=sse&key=${encodeURIComponent(apiKey)}`;
        let resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(reqBody)
        }).catch(() => null);

        if ((!resp || !resp.ok) && (liveSearch || deep)) {
          delete reqBody.tools;
          delete reqBody.generationConfig.thinkingConfig;
          resp = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(reqBody)
          }).catch(() => null);
        }

        if (!resp || !resp.ok || !resp.body) continue;

        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache, no-transform');
        res.setHeader('Connection', 'keep-alive');

        const reader = resp.body.getReader();
        const decoder = new TextDecoder();
        let sseBuf = '';
        let fullText = '';
        let emittedLen = 0;
        let sources = [];

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          sseBuf += decoder.decode(value, { stream: true });
          const lines = sseBuf.split('\n');
          sseBuf = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data:')) continue;
            const jsonStr = line.slice(5).trim();
            if (!jsonStr || jsonStr === '[DONE]') continue;
            try {
              const chunk = JSON.parse(jsonStr);
              const sList = extractGroundingSources(chunk);
              if (sList.length) sources = sList;
              const parts = chunk?.candidates?.[0]?.content?.parts || [];
              for (const p of parts) {
                if (!p.thought && typeof p.text === 'string' && p.text) {
                  fullText += p.text;
                }
              }
              // Stream safe visible prefix (hold back if '<synaphe_memory' tag starts forming)
              const tagIdx = fullText.indexOf('<synaphe_memory');
              const safeEnd = tagIdx >= 0 ? tagIdx : Math.max(0, fullText.length - 18);
              if (safeEnd > emittedLen) {
                const delta = fullText.slice(emittedLen, safeEnd);
                emittedLen = safeEnd;
                res.write(`data: ${JSON.stringify({ type: 'delta', text: delta })}\n\n`);
              }
            } catch (_) {}
          }
        }

        const { reply, facts } = extractMemoryTag(fullText);
        if (reply.length > emittedLen) {
          res.write(`data: ${JSON.stringify({ type: 'delta', text: reply.slice(emittedLen) })}\n\n`);
        }
        res.write(`data: ${JSON.stringify({ type: 'done', reply, facts, sources, model })}\n\n`);
        return res.end();
      }
      return res.status(502).json({ error: 'Akış başlatılamadı.' });
    }

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
        thinkingBudget,
        timeoutMs
      });

      if (!result.ok && (liveSearch || deep)) {
        result = await callGeminiModel({
          apiKey,
          model,
          systemInstruction,
          contents,
          useSearch: false,
          useThinking: false,
          thinkingBudget: 0,
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
