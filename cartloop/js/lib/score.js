// 정답지 채점: 서비스가 낸 결과를 정답지와 비교한다.
import { RECORD_TYPES, RULE_TYPES, ALERT_LABEL } from './audit.js';

const sq = s => String(s ?? '').replace(/\s+/g, '');
const pct = (a, b) => b ? a / b : null;

export function score(key, { records, alerts, proposals }) {
  const out = { extraction: {}, alias: {}, errors: {}, sets: {}, detail: { fieldMisses: [], aliasMisses: [], fn: [], fp: [] } };

  // A-1 필드 추출 정확도
  let fTot = 0, fOk = 0; const perField = {};
  const bump = (name, ok, ctx) => {
    fTot++; if (ok) fOk++;
    const p = (perField[name] ||= { n: 0, ok: 0 }); p.n++; if (ok) p.ok++;
    if (!ok && out.detail.fieldMisses.length < 60) out.detail.fieldMisses.push({ field: name, ...ctx });
  };
  let recFound = 0;
  for (const [op, k] of Object.entries(key.records)) {
    const r = records[op];
    if (r) recFound++;
    for (const f of ['pid', 'date', 'surgeon', 'dept', 'room', 'site', 'opName', 'opCode', 'note']) {
      bump(f, !!r && sq(r[f]) === sq(k[f]), { op, want: k[f], got: r?.[f] });
    }
    const mats = (r?.lines || []).filter(l => l.src === 'material');
    bump('재료 줄 수', mats.length === k.materials.length, { op, want: k.materials.length, got: mats.length });
    k.materials.forEach((m, i) => {
      const g = mats[i];
      bump('재료명', !!g && sq(g.rawName) === sq(m.name), { op, want: m.name, got: g?.rawName });
      bump('규격', !!g && sq(g.rawSpec) === sq(m.spec), { op, want: m.spec, got: g?.rawSpec });
      bump('수량', !!g && Number(g.qty) === Number(m.qty), { op, want: m.qty, got: g?.qty });
      bump('적힌 코드', !!g && sq(g.givenCode) === sq(m.code), { op, want: m.code, got: g?.givenCode });
    });
    const drs = (r?.lines || []).filter(l => l.src === 'drain');
    k.drains.forEach((d, i) => {
      const g = drs[i];
      bump('삽입관', !!g && sq(g.rawName) === sq(d.type) && Number(g.qty) === Number(d.qty), { op, want: `${d.type} ${d.note}`, got: g ? `${g.rawName} ${g.rawSpec} x${g.qty}` : '' });
    });
  }
  out.extraction = { fields: fTot, correct: fOk, accuracy: pct(fOk, fTot), records: Object.keys(key.records).length, found: recFound,
    perField: Object.fromEntries(Object.entries(perField).map(([k, v]) => [k, { ...v, accuracy: pct(v.ok, v.n) }])) };

  // A-2 별칭 통합 정확도 (줄 단위 · 표기 단위)
  let lTot = 0, lOk = 0; const nota = {};
  for (const [op, k] of Object.entries(key.records)) {
    const r = records[op];
    const mats = (r?.lines || []).filter(l => l.src === 'material');
    const drs = (r?.lines || []).filter(l => l.src === 'drain');
    const pairs = [...k.materials.map((m, i) => [m, mats[i], m.name, m.spec]), ...k.drains.map((d, i) => [d, drs[i], d.type, d.note])];
    for (const [m, g, name, spec] of pairs) {
      if (!m.trueCode) continue;
      lTot++;
      const ok = !!g && g.code === m.trueCode;
      if (ok) lOk++;
      else if (out.detail.aliasMisses.length < 80) out.detail.aliasMisses.push({ op, name, spec, want: m.trueCode, got: g?.code || null, how: g?.how, family: g?.family });
      const nk = sq(String(name).replace(/\(.*$/, '')).toLowerCase() + '|' + sq(spec).toLowerCase();
      const n = (nota[nk] ||= { n: 0, ok: 0 }); n.n++; if (ok) n.ok++;
    }
  }
  const nKeys = Object.values(nota);
  out.alias = { lines: lTot, correct: lOk, accuracy: pct(lOk, lTot), notations: nKeys.length, notationsCorrect: nKeys.filter(n => n.ok === n.n).length,
    notationAccuracy: pct(nKeys.filter(n => n.ok === n.n).length, nKeys.length) };

  // B 오류 검출: (수술, 유형, 재료코드) 가 같으면 맞힌 것으로 센다
  const kid = e => `${e.op}|${e.type}|${e.code}`;
  const truth = new Map(key.errors.map(e => [kid(e), e]));
  const mine = alerts.filter(a => a.type !== 'unmapped');
  const got = new Map(mine.map(a => [kid(a), a]));
  const byType = {};
  for (const t of [...RECORD_TYPES, ...RULE_TYPES]) byType[t] = { label: ALERT_LABEL[t], truth: 0, found: 0, alerts: 0, falsePos: 0 };
  for (const [id, e] of truth) { const b = (byType[e.type] ||= { label: e.type, truth: 0, found: 0, alerts: 0, falsePos: 0 }); b.truth++; if (got.has(id)) b.found++; else out.detail.fn.push(e); }
  for (const [id, a] of got) { const b = (byType[a.type] ||= { label: a.type, truth: 0, found: 0, alerts: 0, falsePos: 0 }); b.alerts++; if (!truth.has(id)) { b.falsePos++; out.detail.fp.push(a); } }
  for (const b of Object.values(byType)) { b.recall = pct(b.found, b.truth); b.precision = pct(b.alerts - b.falsePos, b.alerts); }
  const grp = types => {
    const g = { truth: 0, found: 0, alerts: 0, falsePos: 0 };
    for (const t of types) for (const k of Object.keys(g)) g[k] += byType[t]?.[k] || 0;
    g.recall = pct(g.found, g.truth); g.precision = pct(g.alerts - g.falsePos, g.alerts); g.falseRate = pct(g.falsePos, g.alerts);
    return g;
  };
  out.errors = { byType, record: grp(RECORD_TYPES), rule: grp(RULE_TYPES), all: grp(Object.keys(byType)), unmapped: alerts.filter(a => a.type === 'unmapped').length };

  // B-3 · A-3 세트
  const pk = p => `${p.setCode}|${p.action}|${p.code}`;
  const cmp = (want, mineP) => {
    const w = new Set(want.map(pk)), g = new Set(mineP.filter(p => !p.tray).map(pk));
    const hit = [...w].filter(x => g.has(x)).length;
    return { truth: w.size, proposed: g.size, found: hit, missed: [...w].filter(x => !g.has(x)), extra: [...g].filter(x => !w.has(x)) };
  };
  out.sets = { v1: cmp(key.setDrift.v1, proposals.v1 || []), end: cmp(key.setDrift.end, proposals.end || []) };
  return out;
}

// 100%가 아닌데 반올림으로 100.0%처럼 보이지 않게 한다
export const fmtPct = v => v == null ? '–' : (v < 1 && v * 100 >= 99.95 ? (Math.floor(v * 10000) / 100).toFixed(2) : (v * 100).toFixed(1)) + '%';
