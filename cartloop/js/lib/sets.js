// 세트 개정 에이전트: 쌓인 사용 기록과 Case cart 세트를 비교해 개정안을 낸다.
// 기준은 공지(세트 개정 운영 기준)에서 읽은 값을 쓰고, 공지가 없으면 기본값을 쓴다.

export function setPolicy(db) {
  const r = (db.rules || []).find(r => r.type === 'set_policy');
  return {
    implant: { window: 10, min: 8, basis: 'record', ...(r?.implant || {}) },
    consumable: { window: 20, min: 17, basis: 'claim', ...(r?.consumable || {}) },
    docNo: r?.docNo || '', effective: r?.effective || '',
  };
}

const isImplantKind = k => /임플란트/.test(k || '');
const isTray = it => /트레이/.test(it.kind || '') || it.code === 'TRAY';

function usage(db, op) {
  const rec = {}, claim = {};
  for (const l of db.records[op]?.lines || []) if (l.code) rec[l.code] = (rec[l.code] || 0) + l.qty;
  for (const l of db.claims[op]?.lines || []) claim[l.code] = (claim[l.code] || 0) + l.qty;
  return { rec, claim };
}
const mode = arr => {
  const c = {}; let best = arr[0], bn = 0;
  for (const v of arr) { c[v] = (c[v] || 0) + 1; if (c[v] > bn || (c[v] === bn && v > best)) { bn = c[v]; best = v; } }
  return best;
};

export function setOps(db, setCode) {
  const s = db.sets[setCode];
  return Object.values(db.records).filter(r => r.setCode === setCode && r.date > (s.revised || ''))
    .sort((a, b) => (a.date + a.op).localeCompare(b.date + b.op)).map(r => r.op);
}

// 한 세트의 개정안 목록
export function proposeForSet(db, setCode) {
  const s = db.sets[setCode];
  const P = setPolicy(db);
  const ops = setOps(db, setCode);
  const M = db.master;
  const trays = s.items.filter(isTray);
  const trayFam = code => {
    const f = (M[code]?.family || '').toUpperCase();
    return f && trays.some(t => { const n = t.name.toUpperCase(); return n.startsWith(f) || f.startsWith(n) || n.startsWith(f.split(' (')[0]); });
  };
  const setQty = {}, setKind = {};
  for (const it of s.items) if (!isTray(it)) { setQty[it.code] = it.qty; setKind[it.code] = it.kind; }
  // 임플란트 여부: 세트 구분에 적힌 대로, 세트에 없는 품목은 기록지에 나오는 품목군이면 임플란트로 본다
  const implantFams = new Set();
  for (const r of Object.values(db.records)) for (const l of r.lines) if (l.src === 'material' && l.family) implantFams.add(l.family);
  const isImp = c => c in setKind ? isImplantKind(setKind[c]) : implantFams.has(M[c]?.family);

  const use = ops.map(op => usage(db, op));
  const seen = new Set(Object.keys(setQty));
  for (const u of use.slice(-P.consumable.window)) { Object.keys(u.claim).forEach(c => seen.add(c)); }
  for (const u of use.slice(-P.implant.window)) { Object.keys(u.rec).forEach(c => seen.add(c)); }

  const out = [];
  for (const code of seen) {
    if (!M[code]) continue;
    const imp = isImp(code);
    const pol = imp ? P.implant : P.consumable;
    const win = use.slice(-pol.window);
    if (win.length < pol.min) continue;
    const winOps = ops.slice(-pol.window);
    const series = win.map(u => (pol.basis === 'record' ? u.rec : u.claim)[code] || 0);
    const sq = setQty[code] || 0;
    const more = series.filter(v => v > sq).length, less = series.filter(v => v < sq).length;
    let action = null;
    if (more >= pol.min) action = sq === 0 ? 'add' : 'qty';
    else if (less >= pol.min) action = series.filter(v => v === 0).length >= pol.min ? 'remove' : 'qty';
    if (!action) continue;
    const dir = more >= pol.min ? 'more' : 'less';
    const hits = dir === 'more' ? more : less;
    const picked = series.filter(v => dir === 'more' ? v > sq : v < sq);
    const newQty = action === 'remove' ? 0 : mode(picked);
    const tray = trayFam(code);
    if (/산정\s*불가/.test(M[code].benefit) && action === 'add') continue;
    const id = `${setCode}@${s.version}|${action}|${code}`;
    out.push({ id, setCode, version: s.version, action, code, name: M[code].name, spec: M[code].spec, kind: imp ? '임플란트' : '소모품',
      setQty: sq, newQty, series, ops: winOps, hits, window: win.length, min: pol.min, basis: pol.basis, tray,
      amount: (M[code].cap || 0), held: !!db.held[id] });
  }
  // 사용 중지 공지가 있는 품목은 대체 품목을 함께 알려 준다
  for (const p of out) {
    const r = (db.rules || []).find(r => r.type === 'discontinued' && r.codes.includes(p.code));
    if (r) { p.rule = r.no; p.note = `${r.docNo} · ${r.effective}부터 사용 중지${r.replacement && M[r.replacement] ? `, ${M[r.replacement].spec}로 대체` : ''}`; }
  }
  return out.sort((a, b) => (a.tray - b.tray) || (b.kind > a.kind ? -1 : 1) || a.name.localeCompare(b.name));
}

export function proposeAll(db) {
  const out = [];
  for (const code of Object.keys(db.sets)) out.push(...proposeForSet(db, code));
  return out;
}

const nextVersion = v => { const m = /^(\D*)(\d+)$/.exec(v || 'v0'); return m ? m[1] + (Number(m[2]) + 1) : v + '+1'; };

// 승인: 세트를 고치고 버전을 올린다. 승인 다음 수술분부터 새 버전을 적용한다.
export function approve(db, proposals, { by = '책임 간호사', date = new Date().toISOString().slice(0, 10) } = {}) {
  const bySet = {};
  for (const p of proposals) (bySet[p.setCode] ||= []).push(p);
  const done = [];
  for (const [code, ps] of Object.entries(bySet)) {
    const s = db.sets[code];
    const from = s.version, to = nextVersion(s.version);
    for (const p of ps) {
      const it = s.items.find(i => i.code === p.code);
      if (p.action === 'remove') s.items = s.items.filter(i => i.code !== p.code);
      else if (it) it.qty = p.newQty;
      else s.items.push({ kind: p.kind, code: p.code, name: p.name, spec: p.spec, qty: p.newQty });
    }
    s.history.push({ from, to, date, by, changes: ps.map(p => ({ action: p.action, code: p.code, name: p.name, spec: p.spec, from: p.setQty, to: p.newQty, hits: p.hits, window: p.window })) });
    s.version = to; s.revised = date;
    done.push({ setCode: code, from, to, n: ps.length });
  }
  return done;
}
export function hold(db, proposal) { db.held[proposal.id] = { at: new Date().toISOString() }; }
