// 전체 흐름: 파일 → 판독 → 추출 → 별칭 통합 → Loop DB v1 → 대조 · 세트 개정안
// 그리고 설치 후: EHR 화면에서 읽은 수술 한 건 → 대조 알림 → DB 갱신 (루프)
import { readFile } from './classify.js';
import { sha1 } from './readers.js';
import { extractRecord, extractRules } from './agents.js';
import { createDB, ingestMaster, ingestClaims, ingestSets, shapeRecord, learnAliases, learnProcedures, resolveRecord, linkSet, commitRecord, recomputeStats, bumpVersion, summary } from './loopdb.js';
import { auditOp, auditAll } from './audit.js';

export const STAGES = [
  ['read', '파일 판독', '파일 종류를 머리글과 내용으로 판별'],
  ['tables', '표 읽기', '재료 마스터 · 청구 목록 · 세트 목록'],
  ['rules', '공지 규칙', '기준 변경 공지를 점검 규칙으로'],
  ['extract', '기록지 추출', '수술간호기록지에서 재료 · 규격 · 수량 · 집도의 · 술식'],
  ['alias', '별칭 통합', '현장 호칭을 재료코드에 연결하고 청구 기록으로 검증'],
  ['build', 'Loop DB 구축', '세트 · 경향 · 규칙을 묶어 v1'],
  ['audit', '과거 대조', '쌓인 기록에서 확인할 항목 찾기'],
];

const fileStem = n => n.replace(/^.*[\\/]/, '').replace(/\.[^.]+$/, '');

async function pool(items, n, fn) {
  const out = new Array(items.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; out[k] = await fn(items[k], k); }
  }));
  return out;
}

// 추출 한 건: 캐시 정책에 따라 LLM 또는 저장된 결과
export async function extractWithCache(llm, cache, text, mode = 'live') {
  const h = await sha1(text);
  const cached = cache?.get(h);
  if (mode === 'cache' && cached) return { rec: cached, via: 'cache' };
  try {
    const rec = await extractRecord(llm, text);
    cache?.set(h, rec);
    return { rec, via: 'llm' };
  } catch (e) {
    if (cached) return { rec: cached, via: 'cache', error: String(e?.message || e) };
    throw e;
  }
}

export async function buildFromFiles(files, { llm, deps, cache, mode = 'live', installDate = 'auto', onStage = () => {}, onProgress = () => {}, onFile = () => {} } = {}) {
  const db = createDB();
  const report = { files: [], extract: { llm: 0, cache: 0, failed: 0, errors: [] }, alias: null, rulesVia: '', ms: {} };
  const t = k => { report.ms[k] = Date.now(); };
  const tEnd = k => { report.ms[k] = Date.now() - report.ms[k]; };

  // 1) 판독
  onStage('read'); t('read');
  let done = 0;
  const read = await pool(files, 8, async f => {
    const r = await readFile(f.name, f.buf, deps);
    onProgress('read', ++done, files.length); onFile(r);
    return r;
  });
  report.files = read.map(r => ({ name: r.name, kind: r.kind, why: r.why, size: r.size, rows: r.rows?.length, headerRow: r.headerRow, error: r.error }));
  db.files = report.files;
  tEnd('read');

  // 2) 표
  onStage('tables'); t('tables');
  for (const r of read) if (r.kind === 'master') ingestMaster(db, r.rows);
  for (const r of read) if (r.kind === 'claims') ingestClaims(db, r.rows);
  for (const r of read) if (r.kind === 'sets') ingestSets(db, r.rows);
  if (!Object.keys(db.master).length) throw new Error('재료 마스터 파일을 찾지 못했습니다. 재료코드 · 품명 · 상한금액 열이 있는 표가 필요합니다.');
  tEnd('tables');

  // 3) 공지 → 규칙
  onStage('rules'); t('rules');
  const notice = read.filter(r => r.kind === 'notices').map(r => r.text).join('\n\n');
  db.noticeText = notice;
  if (notice) {
    const h = 'rules:' + await sha1(notice);
    const cached = cache?.get(h);
    if (mode === 'cache' && cached) { db.rules = cached; report.rulesVia = 'cache'; }
    else {
      try { db.rules = await extractRules(llm, notice); cache?.set(h, db.rules); report.rulesVia = 'llm'; }
      catch (e) { if (cached) { db.rules = cached; report.rulesVia = 'cache'; } else { db.rules = []; report.rulesVia = 'failed: ' + (e?.message || e); } }
    }
  }
  tEnd('rules');

  // 4) 기록지 추출 (LLM, 여러 키로 동시에)
  onStage('extract'); t('extract');
  const recFiles = read.filter(r => r.kind === 'record');
  done = 0;
  const extracted = await Promise.all(recFiles.map(async f => {
    let out = null;
    try {
      const { rec, via } = await extractWithCache(llm, cache, f.text, mode);
      report.extract[via]++;
      out = { file: f.name, text: f.text, rec };
    } catch (e) {
      report.extract.failed++; report.extract.errors.push({ file: f.name, error: String(e?.message || e) });
    }
    onProgress('extract', ++done, recFiles.length);
    return out;
  }));
  tEnd('extract');

  // 설치 기준일: 마지막 청구일에서 석 달 전의 1일
  const dates = Object.values(db.claims).map(c => c.date).filter(Boolean).sort();
  if (installDate === 'auto') {
    const last = dates[dates.length - 1];
    if (last) { const d = new Date(last + 'T00:00:00Z'); d.setUTCDate(1); d.setUTCMonth(d.getUTCMonth() - 2); installDate = d.toISOString().slice(0, 10); }
    else installDate = '9999-12-31';
  }
  db.installDate = installDate;

  // 설치 후 수술은 따로 떼어 둔다 (EHR 화면에서 한 건씩 읽을 대상)
  const shaped = extracted.filter(Boolean).map(x => ({ ...x, rec: shapeRecord(db, x.rec, { file: x.file, opHint: fileStem(x.file) }) }));
  for (const [op, c] of Object.entries(db.claims)) {
    if (c.date >= installDate) { db.pending[op] = { op, date: c.date, claim: c, rec: null, text: '', file: '' }; delete db.claims[op]; }
  }
  const pre = [];
  for (const x of shaped) {
    if (db.pending[x.rec.op]) Object.assign(db.pending[x.rec.op], { rec: x.rec, text: x.text, file: x.file });
    else if (x.rec.date >= installDate) db.pending[x.rec.op] = { op: x.rec.op, date: x.rec.date, claim: null, rec: x.rec, text: x.text, file: x.file };
    else pre.push(x.rec);
  }

  // 5) 별칭 통합
  onStage('alias'); t('alias');
  report.alias = await learnAliases(db, llm, pre, { onProgress: (d, n) => onProgress('alias', d, n) });
  await learnProcedures(db, llm, [...pre, ...Object.values(db.pending).map(p => p.rec).filter(Boolean)]);
  tEnd('alias');

  // 6) 구축
  onStage('build'); t('build');
  for (const r of pre) { resolveRecord(db, r); linkSet(db, r); commitRecord(db, r); }
  for (const r of pre) resolveRecord(db, r); // 쌓인 사용 이력으로 애매한 규격을 한 번 더 가린다
  recomputeStats(db);
  db.builtAt = new Date().toISOString();
  bumpVersion(db, '설치 · 파일 업로드', { addedOps: pre.length, newAliases: Object.keys(db.aliases).length });
  tEnd('build');

  // 7) 과거 대조
  onStage('audit'); t('audit');
  const alerts = auditAll(db);
  tEnd('audit');
  onStage('done');
  return { db, alerts, report, summary: summary(db) };
}

// ───────────── 설치 후 루프 ─────────────
// EHR 화면 글자(기록지 화면 + 청구 화면)를 읽어 대조한다. DB에는 아직 넣지 않는다.
export async function readScreen(db, op, { llm, cache, mode = 'live', screenText = null } = {}) {
  const p = db.pending[op];
  if (!p) throw new Error('읽을 수술이 없습니다: ' + op);
  let rec = p.rec, via = 'stored';
  const text = screenText || p.text;
  if (text && llm) {
    try {
      const r = await extractWithCache(llm, cache, text, mode);
      rec = shapeRecord(db, r.rec, { file: p.file, opHint: op }); rec.op = op; via = r.via;
    } catch { /* 저장된 추출 결과를 쓴다 */ }
  }
  if (!rec) throw new Error('수술기록을 읽지 못했습니다.');
  rec = JSON.parse(JSON.stringify(rec));
  const before = Object.keys(db.aliases).length;
  const savedClaim = db.claims[op];
  db.claims[op] = p.claim; // 같은 수술의 청구 목록으로 새 표기를 검증한다
  let learn = null;
  try {
    learn = await learnAliases(db, llm, [rec], { onlyNew: true });
    if (!db.procMap[rec.opName?.split(':')[0]?.trim()]) await learnProcedures(db, llm, [rec]);
    resolveRecord(db, rec); linkSet(db, rec);
    const alerts = auditOp(db, op, { claim: p.claim, record: rec });
    const newAliases = rec.lines.filter(l => db.aliases[l.alias]?.since === db.version + 1 && db.aliases[l.alias]?.n <= 1).map(l => l.alias);
    return { rec, alerts, via, learn, newAliasCount: Object.keys(db.aliases).length - before, newAliases };
  } finally {
    if (savedClaim) db.claims[op] = savedClaim; else delete db.claims[op];
  }
}

// 확인을 마친 수술을 DB에 더한다. 그 달의 수술을 모두 읽으면 버전이 올라간다.
export function commitOp(db, op, rec) {
  const p = db.pending[op];
  if (!p) return null;
  db.claims[op] = p.claim || { op, date: rec.date, pid: rec.pid, lines: [] };
  if (p.claim?.pid && p.claim?.date) db.claimKey[`${p.claim.pid}|${p.claim.date}`] = op;
  resolveRecord(db, rec); linkSet(db, rec); commitRecord(db, rec);
  delete db.pending[op];
  recomputeStats(db);
  const month = (rec.date || p.date || '').slice(0, 7);
  const left = Object.values(db.pending).filter(x => (x.date || '').slice(0, 7) === month).length;
  if (left === 0) {
    const prev = db.changelog[db.changelog.length - 1]?.snapshot || {};
    consolidate(db);
    const s = summary(db);
    bumpVersion(db, `${month} 수술분 반영`, { addedOps: s.records - (prev.records || 0), newAliases: s.aliasNames - (prev.aliasNames || 0), newNotations: s.notations - (prev.notations || 0) });
    return { bumped: true, version: db.version };
  }
  return { bumped: false, version: db.version };
}

// 주기적 전체 정리: 누적된 별칭의 근거를 다시 세고, 애매했던 줄을 이력으로 다시 가린다.
export function consolidate(db) {
  for (const a of Object.values(db.aliases)) { a.n = 0; a.specs = {}; }
  const recs = Object.values(db.records);
  for (const r of recs) { resolveRecord(db, r); }
  for (const r of recs) for (const l of r.lines) {
    const a = db.aliases[l.alias]; if (!a) continue;
    a.n++;
    if (l.code) { const k = String(l.rawSpec || '').toLowerCase().replace(/\s+/g, ''); const s = (a.specs[k] ||= { code: l.code, n: 0, spec: l.rawSpec }); s.n++; }
  }
  for (const r of recs) resolveRecord(db, r);
  recomputeStats(db);
}

// 설치 후 수술을 날짜순으로 모두 읽는다 (검증 · 일괄 시연용)
export async function runAllPending(db, { llm, cache, mode = 'live', onProgress = () => {} } = {}) {
  const ops = Object.values(db.pending).filter(p => p.rec || p.text).sort((a, b) => (a.date + a.op).localeCompare(b.date + b.op)).map(p => p.op);
  const alerts = [];
  // 추출은 한꺼번에(여러 키로 동시에), DB 반영은 날짜순으로
  let done = 0;
  const read = await Promise.all(ops.map(async op => {
    const p = db.pending[op]; let rec = p.rec, via = 'stored';
    if (p.text && llm) { try { const r = await extractWithCache(llm, cache, p.text, mode); rec = shapeRecord(db, r.rec, { file: p.file, opHint: op }); rec.op = op; via = r.via; } catch { /* keep stored */ } }
    onProgress(++done, ops.length);
    return { op, rec, via };
  }));
  for (const { op, rec } of read) {
    if (!rec) continue;
    const p = db.pending[op];
    const saved = db.claims[op]; db.claims[op] = p.claim;
    await learnAliases(db, llm, [rec], { onlyNew: true });
    if (saved) db.claims[op] = saved; else delete db.claims[op];
    resolveRecord(db, rec); linkSet(db, rec);
    alerts.push(...auditOp(db, op, { claim: p.claim, record: rec }));
    commitOp(db, op, rec);
  }
  return { alerts, ops: ops.length };
}
