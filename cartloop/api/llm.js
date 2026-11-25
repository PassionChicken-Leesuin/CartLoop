// OpenRouter 프록시. 키는 서버 환경변수에만 있고 브라우저로 내려가지 않는다.
// 환경변수 Open_Router_key1..N (대소문자 무관) 또는 OPENROUTER_KEYS(쉼표 구분)를 모두 모아 돌려 쓴다.

const MODELS = new Set([
  'anthropic/claude-haiku-5.5',
  'anthropic/claude-sonnet-5.5',
]);
const DEFAULT_MODEL = 'anthropic/claude-haiku-5.5';

function loadKeys() {
  const keys = [];
  for (const [k, v] of Object.entries(process.env)) {
    if (!v) continue;
    if (/^open_?router_?key_?\d*$/i.test(k)) keys.push([Number(k.replace(/\D/g, '')) || 0, v.trim()]);
    if (/^openrouter_keys$/i.test(k)) v.split(',').forEach((s, i) => s.trim() && keys.push([1000 + i, s.trim()]));
  }
  keys.sort((a, b) => a[0] - b[0]);
  return [...new Set(keys.map(k => k[1]))];
}

let cursor = Math.floor(Math.random() * 1000);

async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') return JSON.parse(req.body);
  const chunks = [];
  let size = 0;
  for await (const c of req) { size += c.length; if (size > 400_000) throw new Error('body too large'); chunks.push(c); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function send(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

export default async function handler(req, res) {
  const keys = loadKeys();
  if (req.method === 'GET') return send(res, 200, { ok: true, keys: keys.length, models: [...MODELS] });
  if (req.method !== 'POST') return send(res, 405, { error: 'POST only' });

  // 같은 출처에서 온 요청만 받는다
  const origin = req.headers.origin;
  if (origin) {
    try {
      if (new URL(origin).host !== req.headers.host) return send(res, 403, { error: 'forbidden origin' });
    } catch { return send(res, 403, { error: 'forbidden origin' }); }
  }
  if (!keys.length) return send(res, 500, { error: 'OpenRouter 키가 서버에 설정되지 않았습니다' });

  let body;
  try { body = await readBody(req); } catch (e) { return send(res, 400, { error: String(e.message || e) }); }
  const model = MODELS.has(body.model) ? body.model : DEFAULT_MODEL;
  const messages = Array.isArray(body.messages) ? body.messages.slice(0, 12) : null;
  if (!messages) return send(res, 400, { error: 'messages 가 필요합니다' });
  if (JSON.stringify(messages).length > 300_000) return send(res, 413, { error: 'prompt too large' });

  const payload = {
    model,
    messages,
    temperature: typeof body.temperature === 'number' ? body.temperature : 0,
    max_tokens: Math.min(Number(body.max_tokens) || 2000, 6000),
  };
  // 추출·분류는 생각 토큰 없이 바로 답하게 한다 (빠르고, 출력이 잘리지 않는다)
  payload.reasoning = model === 'anthropic/claude-haiku-5.5' ? { enabled: false } : { effort: 'low', exclude: true };
  if (model !== 'anthropic/claude-haiku-5.5') payload.max_tokens = Math.min(payload.max_tokens + 2000, 8000);
  if (body.response_format) payload.response_format = body.response_format;

  const start = typeof body.slot === 'number' ? body.slot : cursor++;
  let lastErr = null;
  for (let attempt = 0; attempt < Math.min(4, keys.length); attempt++) {
    const idx = (((start + attempt) % keys.length) + keys.length) % keys.length;
    try {
      const r = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${keys[idx]}`,
          'Content-Type': 'application/json',
          'X-Title': 'CartLoop',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(50_000),
      });
      const text = await r.text();
      if (!r.ok) {
        lastErr = { status: r.status, detail: text.slice(0, 300) };
        if ([401, 402, 403, 408, 429].includes(r.status) || r.status >= 500) continue; // 다음 키로
        return send(res, 502, { error: 'upstream', ...lastErr });
      }
      const j = JSON.parse(text);
      if (j.error) { lastErr = { status: j.error.code || 500, detail: String(j.error.message || '').slice(0, 300) }; continue; }
      const content = j.choices?.[0]?.message?.content ?? '';
      return send(res, 200, { content, model: j.model || model, usage: j.usage || null, key: idx + 1, attempts: attempt + 1 });
    } catch (e) {
      lastErr = { status: 0, detail: String(e.message || e).slice(0, 300) };
    }
  }
  return send(res, 502, { error: 'upstream', ...lastErr });
}
