// Vercel Serverless Function: POST /api/chat
// Frontier-grade Synaphe AI Engine:
//   - Real multi-turn Gemini conversation (systemInstruction + role-based contents)
//   - Smart routing: Gemini 2.5 Pro for deep code/math/architecture, Gemini 2.5 Flash for fast chat
//   - Live Google Search grounding for real-time queries (weather, FX, news, current events)
//   - Unconstrained 8192-token Markdown output (zero JSON-escaping truncation on code!)
//   - Hidden <synaphe_memory> tag extraction for Eidetis AGM Memory Graph

const FAST_MODELS = [
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite',
  'gemini-flash-latest'
];

const DEEP_MODELS = [
  'gemini-2.5-pro',
  'gemini-2.5-flash',
  'gemini-3-flash-preview',
  'gemini-2.5-flash-lite'
];

function needsDeepReasoning(msg) {
  const s = msg.toLowerCase();
  if (msg.length > 320) return true;
  return /\b(kod|code|python|javascript|typescript|swift|sql|react|fastapi|mimari|algoritma|hata|bug|debug|refactor|kanıt|ispat|teorem|analiz|strateji|karşılaştır|planla|optimize|matematik|integral|türev|api|veritabanı|sistem tasarımı)\b/i.test(s);
}

function needsLiveSearch(msg) {
  const s = msg.toLowerCase();
  return /\b(bugün|güncel|son dakika|haber|hava durumu|dolar|euro|altın|bitcoin|btc|eth|kur|kaç tl|fiyatı|maç|skor|seçim|2025|2026|şimdi|canlı|borsa|bist)\b/i.test(s);
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

function buildSystemInstruction(userName, memoryContext, nowStr) {
  const knownName = userName && userName !== 'Kullanıcı' && userName !== 'Misafir';
  const nameLine = knownName
    ? `Kullanıcının adı: ${userName}. Ona gerektiğinde doğal şekilde adıyla hitap edebilirsin.`
    : `Kullanıcının adını henüz bilmiyorsun; doğal hitap et ve asla "Misafir" veya "Kullanıcı" diye seslenme.`;

  return `Sen SYNAPHE'sin — en üst düzey akıl yürütme, yazılım mühendisliği, bilim, strateji, yaratıcı yazarlık ve günlük rehberlik yeteneklerine sahip, kalıcı bilişsel hafızalı kişisel yapay zekâ asistanısın.

GÜNCEL TARİH VE SAAT (Türkiye): ${nowStr}
${nameLine}

DOĞRULANMIŞ KİŞİSEL HAFIZA (EİDETİS):
${memoryContext}

ZİHİNSEL STANDARTLARIN VE YANIT İLKELERİN:
1. **Üst Düzey Zekâ & Netlik:** Sorunun özünü hemen kavra. Gereksiz giriş cümleleri, dolgu sözler veya tekrarlar yapma. Doğrudan, derinlikli, yapılandırılmış ve uygulanabilir yanıtlar ver.
2. **Mühendislik & Kod Kalitesi:** Kod istendiğinde eksik/taslak değil; temiz, doğrudan çalışan, kenar durumları düşünülmüş modern kod yaz ve dil etiketli kod blokları (\`\`\`python, \`\`\`js vb.) kullan.
3. **Doğruluk & Dürüstlük:** Kişisel bilgilerde yalnızca yukarıdaki doğrulanmış hafızaya ve sohbet geçmişine dayan; asla kişisel bilgi uydurma. Emin olmadığın bir konuda uydurmak yerine açıkça belirt.
4. **Doğal, Zeki Türkçe:** Akıcı, modern, samimi ama profesyonel bir Türkçe kullan. Asla "Eidetis belleğin boş", "hafıza grafiğine kaydedildi", "veritabanına işlendi" gibi robotik ifadeler KULLANMA.
5. **Biçimlendirme:** Uzun yanıtlarda başlıklar, kısa maddeler ve kalın vurgular kullanarak okunabilirliği en üst düzeye çıkar; kısa sohbet mesajlarında ise doğal ve akıcı tek/iki cümleyle yanıt ver.

GİZLİ HAFIZA ÇIKARIMI (SADECE YENİ KİŞİSEL BİLGİ VARSA):
Kullanıcı bu mesajında kendisi hakkında YENİ ve kalıcı bir kişisel gerçek paylaştıysa (adı, yaşadığı yer, taşınma planı, mesleği/bölümü, hedefleri, tercihleri, projeleri, ilişkileri, önemli planları), yanıtının EN SONUNA şu gizli etiketi ekle (kullanıcıya görünmez, sistem tarafından ayrıştırılır):
<synaphe_memory>[{"relation":"konum","value":"İzmir","detail":"Kısa bağlam"}]</synaphe_memory>
İzin verilen relation türleri: "isim", "konum", "gelecek_konum", "iş", "hedef", "tercih", "proje", "plan", "arkadaşı", "sevgilisi", "sınav_notu", "not".
- Gelecek zamanlı taşınma ("1 ay sonra Antalya'ya taşınacağım") için "gelecek_konum" kullan, mevcut "konum"u ezme.
- Yeni bir kişisel bilgi YOKSA <synaphe_memory> etiketini HİÇ EKLEME.`;
}

async function callGeminiModel({ apiKey, model, systemInstruction, contents, useSearch, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = {
      systemInstruction: { parts: [{ text: systemInstruction }] },
      contents,
      generationConfig: {
        temperature: 0.45,
        topP: 0.92,
        maxOutputTokens: 8192
      }
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
    const text = parts.map(p => p.text || '').join('').trim();
    if (!text) return { ok: false, status: 502 };
    return { ok: true, text };
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
      service: 'Synaphe Eidetis Cloud AI v2',
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
    const message = String(body.message || '').trim().slice(0, 12000);
    const userName = String(body.userName || '').trim().slice(0, 60);
    const memoryContext = String(body.memoryContext || 'Henüz kayıtlı bilgi yok.').slice(0, 8000);
    const rawHistory = Array.isArray(body.history) ? body.history.slice(-24) : [];

    if (!message) {
      return res.status(400).json({ error: 'Boş mesaj gönderilemez.' });
    }

    const nowStr = new Date().toLocaleString('tr-TR', {
      timeZone: 'Europe/Istanbul',
      dateStyle: 'full',
      timeStyle: 'short'
    });
    const systemInstruction = buildSystemInstruction(userName, memoryContext, nowStr);

    // Build real Gemini multi-turn contents array (strict alternating user/model roles)
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
    // Ensure the latest user message is at the end
    if (!contents.length || contents[contents.length - 1].role !== 'user' || contents[contents.length - 1].parts[0].text !== message) {
      if (contents.length && contents[contents.length - 1].role === 'user') {
        contents[contents.length - 1].parts[0].text = message;
      } else {
        contents.push({ role: 'user', parts: [{ text: message }] });
      }
    }
    // Gemini requires first turn to be 'user'
    while (contents.length > 1 && contents[0].role !== 'user') {
      contents.shift();
    }

    const deep = needsDeepReasoning(message);
    const liveSearch = needsLiveSearch(message);
    const modelQueue = deep ? DEEP_MODELS : FAST_MODELS;

    let lastStatus = 0;
    for (const model of modelQueue) {
      const timeoutMs = model.includes('pro') ? 26000 : 18000;
      let result = await callGeminiModel({
        apiKey,
        model,
        systemInstruction,
        contents,
        useSearch: liveSearch,
        timeoutMs
      });

      // If live search tool failed on this model, retry cleanly without tool
      if (!result.ok && liveSearch) {
        result = await callGeminiModel({
          apiKey,
          model,
          systemInstruction,
          contents,
          useSearch: false,
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
