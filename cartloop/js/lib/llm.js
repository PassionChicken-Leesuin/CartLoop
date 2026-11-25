// LLM 클라이언트: /api/llm 프록시를 여러 키로 동시에 호출한다.
export const MODEL_FAST = 'anthropic/claude-haiku-5.5';
export const MODEL_SMART = 'anthropic/claude-sonnet-5.5';

export function parseJSON(content) {
  let s = String(content ?? '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(s);
  if (fence) s = fence[1].trim();
  const a = s.search(/[[{]/);
  if (a > 0) s = s.slice(a);
  const end = Math.max(s.lastIndexOf('}'), s.lastIndexOf(']'));
  if (end >= 0) s = s.slice(0, end + 1);
  return JSON.parse(s);
}

export function createLLM({ endpoint = '/api/llm', concurrency = 20, fetchImpl = (...a) => fetch(...a) } = {}) {
  const stats = { calls: 0, ok: 0, failed: 0, retries: 0, inTok: 0, outTok: 0, byKey: {}, ms: 0, active: 0, peak: 0 };
  let slot = 0, running = 0;
  const waiters = [];
  const acquire = () => running < concurrency ? (running++, Promise.resolve()) : new Promise(r => waiters.push(r));
  const release = () => { const w = waiters.shift(); if (w) w(); else running--; };

  async function call({ messages, model = MODEL_FAST, max_tokens = 2000, json = false, temperature = 0 }) {
    await acquire();
    stats.calls++; stats.active++; stats.peak = Math.max(stats.peak, stats.active);
    const t0 = Date.now();
    try {
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const r = await fetchImpl(endpoint, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ messages, model, max_tokens, temperature, slot: slot++ }),
          });
          const j = await r.json();
          if (!r.ok || j.error) throw new Error(`${j.error || r.status} ${j.status || ''} ${j.detail || ''}`.trim());
          stats.inTok += j.usage?.prompt_tokens || 0; stats.outTok += j.usage?.completion_tokens || 0;
          stats.byKey[j.key] = (stats.byKey[j.key] || 0) + 1;
          const out = { content: j.content, key: j.key, model: j.model };
          if (json) out.data = parseJSON(j.content);
          stats.ok++;
          return out;
        } catch (e) { lastErr = e; stats.retries++; await new Promise(r => setTimeout(r, 400 * (attempt + 1))); }
      }
      stats.failed++;
      throw lastErr;
    } finally {
      stats.ms += Date.now() - t0; stats.active--; release();
    }
  }

  // 여러 작업을 동시에 돌리고 진행 상황을 알린다. 실패한 작업은 {error} 로 돌려준다.
  async function mapAll(items, fn, onProgress) {
    let done = 0;
    return Promise.all(items.map(async (it, i) => {
      let res;
      try { res = await fn(it, i); } catch (e) { res = { error: String(e?.message || e) }; }
      done++; onProgress?.(done, items.length, it, res);
      return res;
    }));
  }
  return { call, mapAll, stats, concurrency };
}
