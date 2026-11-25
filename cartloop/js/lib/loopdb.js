// Loop DB: 우리 병원 Knowledge Base. 올린 파일에서 만들고, 읽은 수술로 갱신한다.
// 전부 JSON 으로 저장할 수 있는 평범한 객체만 쓴다.
import { aliasKey, makerHint, matchSpec, buildFamilies, norm, nums } from './text.js';
import { proposeFamilies, mapProcedures } from './agents.js';

export function createDB() {
  return {
    schema: 1, version: 0, builtAt: null, installDate: null,
    master: {}, families: {},
    claims: {},        // op → {op,date,pid,lines:[]}
    claimKey: {},      // "pid|date" → op
    records: {},       // op → 기록 (추출 + 연결 결과)
    pending: {},       // op → 설치 후 아직 읽지 않은 수술 {op,date,rec,text,file}
    aliases: {},       // 별칭 키 → {key, family, source, conf, n, support, examples, specs}
    sets: {},          // 세트코드 → {code,surgeon,procedure,level,version,revised,items,history}
    rules: [], noticeText: '',
    procMap: {},       // 기록지 수술명 줄기 → 세트 술식
    famStat: {},       // 품목군 → {rec, claim, both, pRC, pCR}
    dismissed: {},     // 알림 id → 처리 내용
    held: {},          // 보류한 세트 개정안 id
    changelog: [],     // 버전 이력
    files: [],
  };
}

// ───────────── 파일 넣기 ─────────────
export function ingestMaster(db, rows) {
  const { master, families } = buildFamilies(rows);
  db.master = master; db.families = families;
}
export function ingestClaims(db, rows) {
  for (const r of rows) {
    const c = (db.claims[r.op] ||= { op: r.op, date: r.date, pid: r.pid, lines: [] });
    c.lines.push({ seq: r.seq || c.lines.length + 1, code: r.code, name: r.name, spec: r.spec, qty: r.qty, unit: r.unit, price: r.price, amount: r.amount, benefit: r.benefit, status: r.status });
    if (r.pid && r.date) db.claimKey[`${r.pid}|${r.date}`] = r.op;
  }
}
export function ingestSets(db, rows) {
  for (const r of rows) {
    const s = (db.sets[r.setCode] ||= { code: r.setCode, surgeon: r.surgeon, procedure: r.procedure, level: r.level, version: r.version, revised: r.revised, items: [], history: [] });
    s.items.push({ kind: r.kind, code: r.code, name: r.name, spec: r.spec, qty: r.qty });
  }
}

// ───────────── 기록 한 건을 DB 모양으로 ─────────────
export function opStem(opName) { return norm(String(opName || '').split(':')[0]); }
export function opLevels(opName) {
  const tail = String(opName || '').split(':')[1] || '';
  const n = nums(tail.split('(')[0]).length;
  return Math.max(1, n - 1);
}
export function shapeRecord(db, rec, { file = '', opHint = '' } = {}) {
  const op = db.claimKey[`${rec.pid}|${rec.date}`] || opHint || `REC-${rec.pid}-${rec.date}`;
  const lines = [];
  for (const m of rec.materials || []) lines.push({ src: 'material', rawName: m.name, rawSpec: m.spec, qty: Number(m.qty) || 1, unit: m.unit, givenCode: m.code || '' });
  for (const d of rec.drains || []) {
    const q = /(\d+)\s*개/.exec(d.note || '');
    const spec = String(d.note || '').split(',')[0].trim();
    lines.push({ src: 'drain', rawName: d.type, rawSpec: spec, qty: q ? Number(q[1]) : 1, unit: '', givenCode: '' });
  }
  for (const l of lines) { l.alias = aliasKey(l.rawName); l.maker = makerHint(l.rawName); }
  return { op, file, pid: rec.pid, date: rec.date, surgeon: rec.surgeon, dept: rec.dept, room: rec.room, site: rec.site,
    diagnosis: rec.diagnosis, opName: rec.opName, opCode: rec.opCode, note: rec.note, scrub: rec.scrub, circ: rec.circ, lines };
}

const claimCodes = (db, op) => {
  const q = {};
  for (const l of db.claims[op]?.lines || []) q[l.code] = (q[l.code] || 0) + l.qty;
  return q;
};
const famItems = (db, fam) => (db.families[fam]?.codes || []).map(c => db.master[c]);

// ───────────── 별칭 통합: LLM 이 제안하고, 기록↔청구 짝이 검증한다 ─────────────
function supportOf(db, fam, lines) {
  // lines: [{op, rawSpec, rawName}]  → 같은 수술의 청구 목록에 그 품목이 실제로 있는 비율
  let n = 0, hit = 0, parsed = 0;
  const items = famItems(db, fam);
  for (const l of lines) {
    if (!db.claims[l.op]) continue;
    n++;
    const m = matchSpec(items, l.rawSpec, l.rawName);
    if (!m.codes.length) continue;
    parsed++;
    const cq = claimCodes(db, l.op);
    if (m.codes.some(c => cq[c])) hit++;
  }
  return { n, hit, parsed, support: n ? hit / n : 0 };
}

export async function learnAliases(db, llm, recs, { onProgress, onlyNew = false } = {}) {
  // 1) 별칭별 사용 예 모으기
  const info = {};
  for (const r of recs) for (const l of r.lines) {
    if (!l.alias) continue;
    if (onlyNew && db.aliases[l.alias]) continue;
    const a = (info[l.alias] ||= { alias: l.alias, lines: [], specs: new Set(), ops: new Set(), makers: new Set(), codes: {}, raw: new Set() });
    a.lines.push({ op: r.op, rawSpec: l.rawSpec, rawName: l.rawName });
    if (l.rawSpec) a.specs.add(l.rawSpec);
    if (r.opName) a.ops.add(opStem(r.opName));
    if (l.maker) a.makers.add(l.maker);
    a.raw.add(l.rawName);
    if (l.givenCode && db.master[l.givenCode]) a.codes[l.givenCode] = (a.codes[l.givenCode] || 0) + 1;
  }
  const list = Object.values(info);
  if (!list.length) return { proposed: 0, learned: 0 };

  // 2) 재료코드가 함께 적힌 줄에서 먼저 배운다
  const fromCode = {};
  for (const a of list) {
    const votes = {};
    for (const [c, n] of Object.entries(a.codes)) votes[db.master[c].family] = (votes[db.master[c].family] || 0) + n;
    const top = Object.entries(votes).sort((x, y) => y[1] - x[1])[0];
    if (top) fromCode[a.alias] = top[0];
  }

  // 3) LLM 제안 (코드로 이미 아는 별칭은 빼고 묻는다)
  const ask = list.filter(a => !fromCode[a.alias]).map(a => ({ alias: a.alias, specs: [...a.specs], ops: [...a.ops], makers: [...a.makers] }));
  let proposal = {}, llmError = null;
  if (ask.length && llm) {
    try { proposal = await proposeFamilies(llm, db, ask, onProgress); } catch (e) { llmError = String(e?.message || e); }
  }

  // 4) 데이터 검증: 제안한 품목군이 같은 수술의 청구 목록과 맞는지 본다. 안 맞으면 맞는 품목군을 찾는다.
  let learned = 0, corrected = 0;
  for (const a of list) {
    let fam = fromCode[a.alias] || proposal[a.alias]?.family || null;
    let source = fromCode[a.alias] ? 'code' : (fam ? 'llm' : 'none');
    let conf = fromCode[a.alias] ? 1 : (proposal[a.alias]?.conf ?? 0);
    let sup = fam ? supportOf(db, fam, a.lines) : { n: 0, hit: 0, support: 0 };
    const waived = fam && db.families[fam]?.nonBillable; // 산정불가 품목은 청구에 없는 것이 정상
    const weak = !fam || (!waived && sup.n >= 2 && sup.support < 0.6) || (!waived && sup.n === 1 && sup.hit === 0 && conf < 0.8);
    if (weak) {
      // 같은 수술에 청구된 품목군 가운데, 규격까지 맞아떨어지는 것을 찾는다
      const cand = new Set();
      for (const l of a.lines) for (const c of Object.keys(claimCodes(db, l.op))) if (db.master[c]) cand.add(db.master[c].family);
      let best = null;
      for (const f of cand) {
        if (db.families[f].codes.length === 1 && !a.specs.size) continue;
        const s = supportOf(db, f, a.lines);
        const exactish = s.parsed === s.n;
        if (s.n && exactish && s.support >= 0.7 && (!best || s.support > best.s.support || (s.support === best.s.support && db.families[f].codes.length > db.families[best.f].codes.length))) best = { f, s };
      }
      // 한 품목짜리 군은 우연히 맞기 쉬우므로, 여러 번 쓰였을 때만 받아들인다
      if (best && (best.s.n >= 3 || db.families[best.f].codes.length > 1) && (!fam || best.s.support > sup.support + 0.2)) {
        fam = best.f; sup = best.s; source = source === 'llm' ? 'llm→data' : 'data'; corrected++;
      } else if (fam && !waived && source === 'llm') source = 'llm?';
    } else if (source === 'llm') source = 'llm+data';
    if (!fam) { db.aliases[a.alias] = { key: a.alias, family: null, source: 'none', conf: 0, n: a.lines.length, support: 0, examples: [...a.raw].slice(0, 4), specs: {}, since: db.version + 1 }; continue; }
    const prev = db.aliases[a.alias];
    db.aliases[a.alias] = { key: a.alias, family: fam, source, conf, n: (prev?.n || 0) + a.lines.length, support: sup.support, supportN: sup.n,
      examples: [...new Set([...(prev?.examples || []), ...a.raw])].slice(0, 4), specs: prev?.specs || {}, since: prev?.since ?? db.version + 1 };
    learned++;
  }
  return { proposed: Object.keys(proposal).length, asked: ask.length, fromCode: Object.keys(fromCode).length, learned, corrected, llmError };
}

// 기록 한 건의 각 줄을 재료코드로 잇는다.
export function resolveRecord(db, rec) {
  const cq = claimCodes(db, rec.op);
  for (const l of rec.lines) {
    l.family = null; l.code = null; l.how = 'unknown'; l.cands = [];
    if (l.givenCode && db.master[l.givenCode]) { l.code = l.givenCode; l.family = db.master[l.code].family; l.how = 'code'; continue; }
    const a = db.aliases[l.alias];
    if (!a || !a.family) continue;
    l.family = a.family;
    const m = matchSpec(famItems(db, a.family), l.rawSpec, l.rawName);
    if (m.codes.length === 1) { l.code = m.codes[0]; l.how = m.how; continue; }
    if (m.codes.length > 1) {
      l.cands = m.codes;
      const inClaim = m.codes.filter(c => cq[c]);
      if (inClaim.length === 1) { l.code = inClaim[0]; l.how = 'context'; continue; }
      // 이 집도의가 같은 표기로 가장 자주 쓴 품목
      const seen = a.specs?.[specKeyOf(l)] ;
      if (seen && m.codes.includes(seen.code)) { l.code = seen.code; l.how = 'history'; continue; }
      l.how = 'ambiguous';
    } else l.how = 'nospec';
  }
  return rec;
}
const specKeyOf = l => String(l.rawSpec || '').toLowerCase().replace(/\s+/g, '');

// 세트 연결
export function linkSet(db, rec) {
  const stem = opStem(rec.opName);
  let proc = db.procMap[stem];
  const mine = Object.values(db.sets).filter(s => s.surgeon === rec.surgeon);
  if (!proc) {
    const hit = mine.find(s => new RegExp(`(^|[^a-z])${s.procedure.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^a-z]|$)`).test(stem.toLowerCase()));
    if (hit) proc = hit.procedure;
  }
  const cands = mine.filter(s => s.procedure === proc);
  rec.procedure = proc || null;
  if (!cands.length) { rec.setCode = null; return rec; }
  const lv = opLevels(rec.opName);
  rec.setCode = (cands.find(s => nums(s.level)[0] === lv) || cands[0]).code;
  return rec;
}

export async function learnProcedures(db, llm, recs) {
  const stems = [...new Set(recs.map(r => opStem(r.opName)).filter(s => s && !db.procMap[s]))];
  if (!stems.length) return;
  const procs = [...new Set(Object.values(db.sets).map(s => s.procedure))];
  if (!procs.length) return;
  try { Object.assign(db.procMap, await mapProcedures(llm, stems, procs)); } catch { /* 규칙 기반 연결로 대신한다 */ }
}

// 기록을 DB에 더하고 별칭 사전의 사용 횟수를 올린다.
export function commitRecord(db, rec) {
  db.records[rec.op] = rec;
  for (const l of rec.lines) {
    const a = db.aliases[l.alias];
    if (!a || !l.code) continue;
    const k = specKeyOf(l);
    const s = (a.specs[k] ||= { code: l.code, n: 0, spec: l.rawSpec });
    s.n++;
  }
}

// 품목군별로 기록과 청구가 실제로 대응하는지 센다 (대조 대상을 정하는 근거)
export function recomputeStats(db) {
  const st = {};
  for (const rec of Object.values(db.records)) {
    if (!db.claims[rec.op]) continue;
    const rf = new Set(rec.lines.filter(l => l.family).map(l => l.family));
    const cf = new Set(db.claims[rec.op].lines.map(l => db.master[l.code]?.family).filter(Boolean));
    for (const f of rf) { (st[f] ||= { rec: 0, claim: 0, both: 0 }).rec++; if (cf.has(f)) st[f].both++; }
    for (const f of cf) (st[f] ||= { rec: 0, claim: 0, both: 0 }).claim++;
  }
  for (const s of Object.values(st)) { s.pRC = s.rec ? s.both / s.rec : 0; s.pCR = s.claim ? s.both / s.claim : 0; }
  db.famStat = st;
  return st;
}

export function summary(db) {
  const aliases = Object.values(db.aliases);
  const notations = new Set(), codes = new Set();
  let lines = 0, resolved = 0;
  for (const r of Object.values(db.records)) for (const l of r.lines) {
    lines++; notations.add(l.alias + '|' + specKeyOf(l));
    if (l.code) { resolved++; codes.add(l.code); }
  }
  return {
    version: db.version, ops: Object.keys(db.claims).length, records: Object.keys(db.records).length, pending: Object.keys(db.pending).length,
    claimLines: Object.values(db.claims).reduce((s, c) => s + c.lines.length, 0),
    masterItems: Object.keys(db.master).length, families: Object.keys(db.families).length,
    aliasNames: aliases.length, aliasLinked: aliases.filter(a => a.family).length,
    notations: notations.size, codes: codes.size, recordLines: lines, resolvedLines: resolved,
    sets: Object.keys(db.sets).length, rules: db.rules.length,
  };
}

export function bumpVersion(db, reason, detail = {}) {
  db.version++;
  db.changelog.push({ version: db.version, at: new Date().toISOString(), reason, ...detail, snapshot: summary(db) });
  return db.version;
}
