// 대조 에이전트: 수술기록 ↔ 청구 목록, 그리고 공지 규칙으로 청구 목록을 점검한다. 판정은 전부 규칙 기반이라 같은 입력이면 같은 결과가 나온다.

export const ALERT_LABEL = {
  missing: '청구 누락', qty_mismatch: '수량 불일치', spec_mismatch: '규격 불일치', unrecorded: '기록 없는 청구',
  non_billable: '산정 불가 품목 청구', bundled: '정액 포함 품목 별도 청구', bundle_dup: '정액 중복 산정',
  qty_limit: '수량 한도 초과', price: '단가 미갱신', discontinued: '사용 중지 품목', duplicate: '같은 품목 중복 줄',
  unmapped: '코드를 찾지 못한 표기',
};
export const RECORD_TYPES = ['missing', 'qty_mismatch', 'spec_mismatch', 'unrecorded'];
export const RULE_TYPES = ['non_billable', 'bundled', 'bundle_dup', 'qty_limit', 'price', 'discontinued', 'duplicate'];

const MIN_REL = 0.8;  // 기록에 있으면 청구에도 있는 비율이 이 이상인 품목군만 '누락'을 본다
const MIN_REL_CR = 0.7; // 청구에 있으면 기록에도 있는 비율이 이 이상인 품목군만 '기록 없는 청구'를 본다

export function auditOp(db, op, { claim = db.claims[op], record = db.records[op] } = {}) {
  const alerts = [];
  if (!claim) return alerts;
  const M = db.master;
  const date = claim.date;
  const cq = {}, cAmt = {}, cPrice = {}, cLines = {};
  for (const l of claim.lines) {
    cq[l.code] = (cq[l.code] || 0) + l.qty; cAmt[l.code] = (cAmt[l.code] || 0) + l.amount;
    cPrice[l.code] = l.price; cLines[l.code] = (cLines[l.code] || 0) + 1;
  }
  const add = (type, code, extra = {}) => {
    const m = M[code] || {};
    alerts.push({ id: `${op}|${type}|${code}`, op, date, type, code, name: m.name || extra.name || '', spec: m.spec || '', family: m.family || '',
      recQty: 0, claimQty: cq[code] || 0, amount: 0, ...extra });
  };

  // ── A. 수술기록 ↔ 청구 목록 ──
  if (record) {
    const rq = {}, rawOf = {};
    for (const l of record.lines) {
      if (!l.code) {
        if (l.family || l.how === 'unknown') alerts.push({ id: `${op}|unmapped|${l.alias}|${l.rawSpec}`, op, date, type: 'unmapped', code: '', name: l.rawName, spec: l.rawSpec, family: l.family || '', recQty: l.qty, claimQty: 0, amount: 0,
          why: l.how === 'ambiguous' ? `규격만으로는 ${l.cands.length}개 품목 중 하나로 좁히지 못했습니다.` : '별칭 사전에 없는 표기입니다.' });
        continue;
      }
      rq[l.code] = (rq[l.code] || 0) + l.qty;
      (rawOf[l.code] ||= []).push(`${l.rawName} ${l.rawSpec}`.trim());
    }
    const recFams = new Set(Object.keys(rq).map(c => M[c].family));
    const fams = new Set(recFams);
    for (const c of Object.keys(cq)) {
      const f = M[c]?.family; const st = db.famStat[f];
      if (f && st && st.rec >= 3 && st.pCR >= MIN_REL_CR) fams.add(f);
    }
    for (const f of fams) {
      const st = db.famStat[f] || { rec: 0, pRC: 1, pCR: 0 };
      const fam = db.families[f];
      if (fam?.nonBillable) continue; // 기록에는 적지만 청구하지 않는 품목
      const codes = fam.codes;
      const missing = [], extra = [];
      for (const c of codes) {
        const r = rq[c] || 0, q = cq[c] || 0;
        if (r > 0 && q === 0) missing.push(c);
        else if (r === 0 && q > 0) extra.push(c);
        else if (r > 0 && q > 0 && r !== q) add('qty_mismatch', c, { recQty: r, amount: (r - q) * (M[c].cap || 0), raw: rawOf[c],
          why: `기록지 ${r}${M[c].unit || '개'} · 청구 ${q}${M[c].unit || '개'}` });
      }
      // 같은 품목군에서 한쪽은 빠지고 한쪽은 남으면 규격을 잘못 고른 것으로 본다
      while (missing.length && extra.length) {
        const x = missing.shift(), y = extra.shift();
        add('spec_mismatch', x, { recQty: rq[x], claimQty: cq[y], otherCode: y, otherSpec: M[y].spec, raw: rawOf[x], amount: 0,
          why: `기록지는 ${M[x].spec}, 청구는 ${M[y].spec}` });
      }
      const reliableRC = st.rec < 3 || st.pRC >= MIN_REL;
      if (reliableRC) for (const c of missing) add('missing', c, { recQty: rq[c], amount: rq[c] * (M[c].cap || 0), raw: rawOf[c],
        why: `기록지에 ${rq[c]}${M[c].unit || '개'} 적혀 있으나 청구 목록에 없습니다.` });
      if (st.rec >= 3 && st.pCR >= MIN_REL_CR) for (const c of extra) add('unrecorded', c, { amount: -(cAmt[c] || 0),
        why: `청구 목록에 ${cq[c]}${M[c].unit || '개'} 있으나 기록지에 없습니다.` });
    }
  }

  // ── B. 공지 규칙 · 급여구분 ──
  const rules = db.rules || [];
  const inForce = r => !r.effective || !date || date >= r.effective;
  const ruleFor = (type, pred) => rules.find(r => r.type === type && pred(r));
  for (const code of Object.keys(cq)) {
    const m = M[code]; if (!m) continue;
    if (/정액\s*포함|별도\s*산정/.test(m.benefit)) {
      const r = ruleFor('bundled', r => r.bundleClass === m.cls || r.keywords.some(k => m.name.toUpperCase().includes(k.toUpperCase())));
      if (!r || inForce(r)) add('bundled', code, { amount: -(cAmt[code] || 0), rule: r?.no, why: r ? `${r.title} (${r.docNo})` : `재료 마스터 급여구분: ${m.benefit}` });
    } else if (/산정\s*불가/.test(m.benefit)) {
      const r = ruleFor('non_billable', r => r.codes.includes(code));
      if (!r || inForce(r)) add('non_billable', code, { amount: -(cAmt[code] || 0), rule: r?.no, why: r ? `${r.title} (${r.docNo})` : `재료 마스터 급여구분: ${m.benefit}` });
    }
    if (cLines[code] > 1) add('duplicate', code, { why: `같은 재료코드가 ${cLines[code]}줄에 입력되어 있습니다.` });
  }
  for (const r of rules) {
    if (!inForce(r)) continue;
    if (r.type === 'bundled' && r.oncePerOp && r.bundleCode && (cq[r.bundleCode] || 0) > 1) {
      add('bundle_dup', r.bundleCode, { amount: -((cq[r.bundleCode] - 1) * (cPrice[r.bundleCode] || 0)), rule: r.no, why: `수술 1회당 1회 산정 · 청구 ${cq[r.bundleCode]}회 (${r.docNo})` });
    }
    if (r.type === 'qty_limit' && r.maxPerOp != null) {
      const codes = Object.keys(cq).filter(c => M[c] && (r.codes.includes(c) || r.keywords.some(k => M[c].name.toUpperCase().includes(k.toUpperCase()))));
      const total = codes.reduce((s, c) => s + cq[c], 0);
      if (total > r.maxPerOp) add('qty_limit', codes[0], { claimQty: total, rule: r.no, amount: -((total - r.maxPerOp) * (M[codes[0]].cap || 0)),
        why: `수술 1회당 ${r.maxPerOp}개까지 급여 · 청구 ${total}개 (${r.docNo})` });
    }
    if (r.type === 'price_change') {
      for (const code of Object.keys(cq)) {
        const m = M[code];
        if (!m || !m.cap || !r.classCodes.includes(m.cls) || /산정\s*불가/.test(m.benefit)) continue;
        if (cPrice[code] !== m.cap) add('price', code, { rule: r.no, amount: -((cPrice[code] - m.cap) * cq[code]), price: cPrice[code], cap: m.cap,
          why: `시행일 ${r.effective} 이후 수술인데 종전 단가 ${cPrice[code].toLocaleString()}원으로 청구 (현재 상한 ${m.cap.toLocaleString()}원)` });
      }
    }
    if (r.type === 'discontinued') {
      for (const code of r.codes) if (cq[code]) add('discontinued', code, { rule: r.no, otherCode: r.replacement,
        why: `${r.effective}부터 사용 중지${r.replacement && M[r.replacement] ? ` · ${M[r.replacement].spec}로 대체` : ''} (${r.docNo})` });
    }
  }
  return alerts;
}

export function auditAll(db, ops = Object.keys(db.claims)) {
  const out = [];
  for (const op of ops) out.push(...auditOp(db, op));
  return out;
}

// 알림 요약: 유형별 건수와 추정 금액
export function tally(alerts) {
  const t = {};
  for (const a of alerts) {
    const s = (t[a.type] ||= { n: 0, missed: 0, over: 0 });
    s.n++; if (a.amount > 0) s.missed += a.amount; else s.over += -a.amount;
  }
  return t;
}
