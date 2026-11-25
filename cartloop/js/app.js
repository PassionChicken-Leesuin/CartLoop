// CartLoop 화면. 모든 처리는 브라우저에서 하고, LLM 호출만 /api/llm 을 거친다.
import { h, render, useState, useEffect, useRef } from './vendor/preact-htm.js';
import htm from './vendor/htm-mini.js';
// 캐시 없는 htm 을 쓴다. 기본 빌드는 정적인 조각을 캐시해 여러 창이 같은 vnode 를 공유하고, 그러면 이전 화면이 지워지지 않는다.
const html = htm.bind(h);
import { unzipSync } from './vendor/fflate.js';
import { createLLM } from './lib/llm.js';
import { buildFromFiles, STAGES, readScreen, commitOp, runAllPending } from './lib/pipeline.js';
import { KIND_LABEL, readFile } from './lib/classify.js';
import { summary } from './lib/loopdb.js';
import { auditOp, auditAll, ALERT_LABEL, RECORD_TYPES, RULE_TYPES } from './lib/audit.js';
import { proposeAll, approve, hold, setPolicy, setOps } from './lib/sets.js';
import { answerQuestion } from './lib/agents.js';
import { buildContext } from './lib/qa.js';
import { buildKB } from './lib/kb.js';
import { score, fmtPct } from './lib/score.js';
import * as store from './lib/store.js';

const won = n => Math.round(Number(n) || 0).toLocaleString('ko-KR') + '원';
const manwon = n => Math.round((Number(n) || 0) / 10000).toLocaleString('ko-KR') + '만 원';
const clone = o => JSON.parse(JSON.stringify(o));
const short = n => String(n || '').replace(/LNK SPINAL FIXATION SYSTEM /, 'LNK ').replace(/슬관절전치환용 |고관절치환용 /, '');
const item = (name, spec) => { const n = short(name).replace(/\s*\([^()]*\/\s*EA\s*\)/i, '').trim(); const sq = x => String(x).replace(/\s/g, '').toLowerCase(); return spec && spec !== '-' && !sq(n).includes(sq(spec)) && !sq(name).includes(sq(spec)) ? `${n} ${spec}` : (sq(name).includes(sq(spec)) && !sq(n).includes(sq(spec)) ? `${n} ${spec}` : n); };
const llm = createLLM({ endpoint: '/api/llm', concurrency: 20 });

const S = {
  route: location.hash.replace(/^#\/?/, '') || 'start',
  db: null, snap: null, chat: [],
  mode: 'live', stage: null, building: null, buildError: null, resultHidden: false,
  toast: null, health: null,
  ehr: { op: null, busy: false, result: null, dismissed: {}, hl: null, hlRaw: null, entry: { code: '', qty: '' } },
  dbTab: 'alias', kbFile: 'README.md', aliasQ: '', auditType: 'all', asking: false, batch: null, valid: null, validBusy: false,
  setSel: null, setPick: {},
};
let pdfjs = null;
const cacheStore = {};
const cache = { get: k => cacheStore[k], set: (k, v) => { cacheStore[k] = v; } };

const root = document.getElementById('app');
// 그리는 도중에 다시 그리라는 요청이 오면(화면 안의 효과가 상태를 바꿀 때) 겹쳐 그리지 않고 한 번 더 돌린다.
// 겹쳐 그리면 화면 전체가 두 벌로 생긴다.
let drawing = false, drawAgain = false;
function draw() {
  if (drawing) { drawAgain = true; return; }
  drawing = true;
  try { do { drawAgain = false; render(html`<${App} />`, root); } while (drawAgain); }
  finally { drawing = false; }
}
function go(r) { location.hash = '#/' + r; }
window.addEventListener('hashchange', () => { S.route = location.hash.replace(/^#\/?/, '') || 'start'; draw(); document.querySelector('.main')?.scrollTo(0, 0); });
function toast(msg, ms = 3200) { S.toast = msg; draw(); clearTimeout(toast.t); toast.t = setTimeout(() => { S.toast = null; draw(); }, ms); }
let saveT = null;
function persist() { clearTimeout(saveT); saveT = setTimeout(() => store.save('state', { db: S.db, snap: S.snap, chat: S.chat }), 400); }

async function deps() {
  if (!pdfjs) {
    pdfjs = await import('./vendor/pdf.min.mjs');
    pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.mjs', import.meta.url).href;
  }
  return { pdfjs, unzipSync };
}
async function loadSampleCache() {
  if (Object.keys(cacheStore).length) return;
  try { Object.assign(cacheStore, await (await fetch('sample/extraction-cache.json')).json()); } catch { /* 없으면 실시간 추출만 */ }
}

// ───────────────────────── 파일 올리기 → 구축 ─────────────────────────
async function fetchSample(onProgress) {
  const man = await (await fetch('sample/manifest.json')).json();
  const out = new Array(man.files.length); let i = 0, done = 0;
  await Promise.all(Array.from({ length: 12 }, async () => {
    while (i < man.files.length) {
      const k = i++; const f = man.files[k];
      const r = await fetch('sample/' + f.url);
      if (!r.ok) throw new Error('샘플 파일을 받지 못했습니다: ' + f.name);
      out[k] = { name: f.name, buf: new Uint8Array(await r.arrayBuffer()) };
      onProgress(++done, man.files.length);
    }
  }));
  return out;
}
// 올린 파일을 먼저 판별해 목록으로 보여 준다 (분석은 "분석 시작"을 눌러야 시작)
async function stageFiles(getFiles, append = false) {
  S.buildError = null;
  const prev = append && S.stage ? S.stage.files : [];
  S.stage = { files: prev, groups: append ? (S.stage?.groups || []) : [], busy: '파일을 읽는 중', prog: null };
  S.building = null; S.resultHidden = true; // 아직 분석하지 않은 파일이므로 이전 결과는 보이지 않게 한다
  draw();
  try {
    const got = await getFiles((d, n) => { S.stage.prog = [d, n]; draw(); });
    const files = [...prev, ...got];
    S.stage.busy = '파일 종류를 판별하는 중'; S.stage.prog = [0, files.length]; draw();
    const dp = await deps();
    const info = []; let i = 0, done = 0, last = 0;
    await Promise.all(Array.from({ length: 8 }, async () => {
      while (i < files.length) {
        const k = i++; const r = await readFile(files[k].name, files[k].buf, dp);
        info[k] = { name: r.name, ext: r.ext, kind: r.kind, why: r.why, headerRow: r.headerRow, cols: r.header?.filter(Boolean).length, n: r.rows?.length,
          sets: r.kind === 'sets' ? new Set(r.rows.map(x => x.setCode)).size : 0, notices: r.kind === 'notices' ? (r.text.match(/시행일|적용일/g) || []).length : 0 };
        done++; if (Date.now() - last > 150) { last = Date.now(); S.stage.prog = [done, files.length]; draw(); }
      }
    }));
    const groups = [];
    const recs = info.filter(f => f.kind === 'record');
    if (recs.length) {
      const by = {}; recs.forEach(f => by[f.ext] = (by[f.ext] || 0) + 1);
      groups.push({ ext: Object.keys(by)[0], name: recs.length === 1 ? recs[0].name.split('/').pop() : `수술간호기록지 ${recs.length}개`,
        sub: `수술간호기록지 · ${Object.entries(by).map(([e, n]) => `${e.toUpperCase()} ${n}`).join(' · ')} · 서식 항목으로 판별`, cnt: `${recs.length.toLocaleString()}건` });
    }
    for (const f of info.filter(f => f.kind !== 'record')) {
      const base = f.name.split('/').pop();
      const cnt = f.kind === 'claims' ? `${f.n.toLocaleString()}줄` : f.kind === 'master' ? `${f.n}품목` : f.kind === 'sets' ? `${f.sets}세트` : f.kind === 'notices' ? `${f.notices}건` : '';
      groups.push({ ext: f.ext, name: base, bad: f.kind === 'unknown', cnt,
        sub: f.kind === 'unknown' ? `판별 불가 · ${f.why}` : f.headerRow ? `${KIND_LABEL[f.kind]} · 머리글 ${f.headerRow}행 · 열 ${f.cols}개 인식` : KIND_LABEL[f.kind] });
    }
    S.stage = { files, groups, busy: null, prog: null };
  } catch (e) { console.error(e); S.buildError = String(e?.message || e); S.stage = null; }
  draw();
}
async function startBuild() {
  const files = S.stage?.files;
  if (!files?.length) return toast('먼저 파일을 올려 주세요.');
  S.buildError = null;
  S.building = { stage: 'read', prog: {}, t0: Date.now() };
  draw();
  try {
    await loadSampleCache();
    const before = { ...llm.stats, byKey: { ...llm.stats.byKey } };
    let lastDraw = 0;
    const res = await buildFromFiles(files, {
      llm, deps: await deps(), cache, mode: S.mode,
      onStage: s => { if (s !== 'done') { S.building.stage = s; draw(); } },
      onProgress: (s, d, n) => { S.building.prog[s] = [d, n]; if (Date.now() - lastDraw > 120 || d === n) { lastDraw = Date.now(); draw(); } },
    });
    const keys = Object.keys(llm.stats.byKey).filter(k => (llm.stats.byKey[k] || 0) > (before.byKey[k] || 0)).length;
    S.db = res.db;
    S.snap = {
      report: res.report, proposalsV1: proposeAll(res.db), setsOriginal: clone(res.db.sets), streamAlerts: {}, v1: res.summary,
      sec: (Date.now() - S.building.t0) / 1000, mode: S.mode,
      llm: { calls: llm.stats.calls - before.calls, inTok: llm.stats.inTok - before.inTok, outTok: llm.stats.outTok - before.outTok, keys, peak: llm.stats.peak },
    };
    S.chat = []; S.valid = null; S.setSel = null; S.ehr = { ...S.ehr, op: null, result: null, dismissed: {} };
    S.building.stage = 'done'; S.resultHidden = false;
    persist(); draw();
  } catch (e) {
    console.error(e);
    S.buildError = String(e?.message || e); S.building = null; draw();
  }
}
function pickFiles(fileList, append) {
  const list = [...fileList].filter(f => /\.(csv|tsv|xlsx|pdf|docx|txt)$/i.test(f.name));
  if (!list.length) return toast('읽을 수 있는 파일이 없습니다. CSV · XLSX · PDF · DOCX · TXT 를 올려 주세요.');
  stageFiles(async onProgress => {
    const out = []; let d = 0;
    for (const f of list) { out.push({ name: f.webkitRelativePath || f.name, buf: new Uint8Array(await f.arrayBuffer()) }); onProgress(++d, list.length); }
    return out;
  }, append);
}
async function dropItems(items) {
  const files = [];
  const walk = entry => new Promise(res => {
    if (entry.isFile) entry.file(f => { files.push(f); res(); }, () => res());
    else if (entry.isDirectory) {
      const rd = entry.createReader(); const all = [];
      const more = () => rd.readEntries(async es => { if (!es.length) { await Promise.all(all.map(walk)); res(); } else { all.push(...es); more(); } }, () => res());
      more();
    } else res();
  });
  await Promise.all([...items].map(i => i.webkitGetAsEntry?.()).filter(Boolean).map(walk));
  pickFiles(files, !!S.stage);
}

const pastAlerts = (() => {
  let key = null, val = [];
  return () => {
    const db = S.db; if (!db) return [];
    const k = db.builtAt + '|' + Object.keys(db.records).length + '|' + db.version;
    if (k !== key) { key = k; val = auditAll(db, Object.keys(db.claims).filter(op => db.claims[op].date < db.installDate)); }
    return val;
  };
})();
const openProposals = () => S.db ? proposeAll(S.db).filter(p => !p.tray && !p.held) : [];

// ───────────────────────── 공통 조각 ─────────────────────────
const Logo = () => html`<svg viewBox="0 0 64 40"><path d="M6 20c9-17 17-17 26 0s17 17 26 0" fill="none" stroke="#f2a93b" stroke-width="6" stroke-linecap="round"/><path d="M6 20c9 17 17 17 26 0s17-17 26 0" fill="none" stroke="#157a72" stroke-width="6" stroke-linecap="round"/></svg>`;
const TYPE_TONE = { missing: 'red', qty_mismatch: 'amber', spec_mismatch: 'amber', unrecorded: 'blue', non_billable: 'red', bundled: 'red', bundle_dup: 'amber', qty_limit: 'amber', price: 'blue', discontinued: 'blue', duplicate: 'blue', unmapped: '' };
const Pill = ({ tone = '', children }) => html`<span class=${'pill ' + tone}>${children}</span>`;
// 발표 시안과 같은 창
const Win = ({ title, sub, id, cls = '', brand = true, children }) => html`<section class=${'win ' + cls} id=${id}>
  <div class="wbar">${brand ? html`<${Logo} /><span class="cl">CartLoop</span>` : ''}<b>${title}</b><span class="wsub">${sub}</span><span class="ctl">− □ ×</span></div>${children}</section>`;
const TagHead = ({ out, children }) => html`<div class="taghead"><span class=${'tag' + (out ? ' out' : '')}>${out ? '출력 화면' : '입력 화면'}</span>${children}</div>`;

function Side() {
  const db = S.db;
  const nPast = db ? pastAlerts().length : 0;
  const nPend = db ? Object.keys(db.pending).length : 0;
  const nProp = db ? openProposals().length : 0;
  const item = (r, n, label, badge) => html`<a class=${'nav' + (S.route === r ? ' on' : '') + (!db && r !== 'start' ? ' off' : '')} href=${'#/' + r}><span class="step">${n}</span>${label}${badge ? html`<span class="badge">${badge}</span>` : ''}</a>`;
  return html`<aside class="side">
    <div class="brand"><${Logo} /><div><b>CartLoop</b><span>우리 병원을 알아가는 청구 도우미</span></div></div>
    <div class="navsep">처음 설정</div>
    ${item('start', 1, '파일 올리기')}
    ${item('db', 2, 'Loop DB')}
    ${item('audit', 3, '과거 대조', nPast)}
    <div class="navsep">설치 후</div>
    ${item('ehr', 4, '청구 대조 알림', nPend)}
    ${item('sets', 5, '세트 개정안', nProp)}
    ${item('ask', 6, '우리 병원 재료 묻기')}
    <div class="navsep">검증</div>
    ${item('validate', 7, '정답지 채점')}
    ${item('show', 8, '한 화면 시연')}
    <div class="foot">
      ${db && html`<div class="dbchip"><b>Loop DB v${db.version}</b><br />수술 ${Object.keys(db.records).length}건 · 별칭 ${Object.keys(db.aliases).length}종<br />설치 기준일 ${db.installDate}</div>`}
      <div>베타 · 가상 데이터 전용<br />환자 · 수술 · 금액은 모두 가상입니다.</div>
      ${db && html`<button class="linkbtn" onClick=${resetAll}>처음부터 다시 (DB 지우기)</button>`}
    </div>
  </aside>`;
}
async function resetAll() {
  if (!confirm('이 브라우저에 저장된 Loop DB를 지우고 처음부터 다시 시작할까요?')) return;
  await store.remove('state'); S.db = null; S.snap = null; S.chat = []; S.building = null; S.stage = null; S.valid = null; S.resultHidden = false; go('start'); draw();
}

// ───────────────────────── 1. 파일 올리기 ─────────────────────────
function UploadWin({ restored }) {
  const [over, setOver] = useState(false);
  const fileRef = useRef(), dirRef = useRef();
  useEffect(() => { if (dirRef.current) dirRef.current.setAttribute('webkitdirectory', ''); }, []);
  const st = S.stage, running = S.building && S.building.stage !== 'done';
  const groups = st?.groups?.length || st?.busy ? (st.groups || []) : (restored || []);
  const canStart = !!st?.files?.length;
  return html`<${Win} title="처음 설정" sub="1 / 2 파일 올리기" id="win-upload"><div class="wbody">
    <div class="wh">올려도 되는 파일을 <em>모두</em> 올려주세요</div>
    <div class="wsubline">형식 · 정리 상태는 상관없어요. 머리글 위치와 열의 뜻은 CartLoop가 읽어요. CSV · XLSX · PDF · DOCX · TXT 를 읽습니다.</div>
    <div class=${'dropbox' + (over ? ' over' : '')} onDragOver=${e => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
      onDrop=${e => { e.preventDefault(); setOver(false); dropItems(e.dataTransfer.items); }}>
      <div class="hint">⬆ 여기에 끌어다 놓기</div>
      ${st?.busy && html`<div class="frow"><span class="ext">···</span><div><b>${st.busy}</b><small>${st.prog ? `${st.prog[0]} / ${st.prog[1]}` : ''}</small></div><span class="bar" style="width:90px"><i style=${`width:${st.prog ? st.prog[0] / st.prog[1] * 100 : 0}%`}></i></span></div>`}
      ${groups.map(g => html`<div class="frow"><span class=${'ext ' + g.ext}>${g.ext.toUpperCase()}</span><div><b>${g.name}</b><small>${g.sub}</small></div><span class="cnt">${g.cnt} ${g.bad ? '' : html`<i>✓</i>`}</span></div>`)}
      ${!groups.length && !st?.busy && html`<div class="frow" style="border-style:dashed"><span class="ext">?</span><div><b>아직 올린 파일이 없습니다</b><small>수술간호기록지 · 청구 목록 · 재료 마스터 · Case cart 세트 · 기준 변경 공지</small></div><span></span></div>`}
    </div>
    <div class="btnrow">
      <button class="btn" id="load-sample" disabled=${running || !!st?.busy} onClick=${() => stageFiles(fetchSample)}>샘플 파일 올리기</button>
      <button class="btn" disabled=${running || !!st?.busy} onClick=${() => fileRef.current.click()}>파일 더 추가</button>
      <button class="btn pri" id="start-build" disabled=${running || !!st?.busy || !canStart} onClick=${startBuild}>${running ? '분석 중…' : restored && !canStart ? '분석 완료' : '분석 시작'}</button>
    </div>
    <div class="wfoot">EHR 연동 없음 · 파일 판독은 이 브라우저 안에서 처리 · <button class="linkbtn" style="color:var(--teal-ink)" onClick=${() => dirRef.current.click()}>폴더째 올리기</button></div>
    <label class="wfoot" style="display:flex;gap:6px;justify-content:center;align-items:center"><input id="mode-cache" type="checkbox" checked=${S.mode === 'cache'} onChange=${e => { S.mode = e.target.checked ? 'cache' : 'live'; draw(); }} />저장해 둔 추출 결과 사용 (LLM 호출 없이 빠르게)${S.health ? ` · OpenRouter 키 ${S.health.keys}개 연결` : ''}</label>
    <input ref=${fileRef} id="pick-files" type="file" multiple style="display:none" onChange=${e => pickFiles(e.target.files, !!S.stage)} />
    <input ref=${dirRef} id="pick-dir" type="file" multiple style="display:none" onChange=${e => pickFiles(e.target.files, !!S.stage)} />
  </div><//>`;
}
function aliasExample(db) {
  const by = {};
  for (const a of Object.values(db.aliases)) for (const s of Object.values(a.specs || {})) (by[s.code] ||= new Set()).add(`${(a.examples[0] || a.key).replace(/\s*\(.*$/, '')} ${s.spec}`.trim());
  const top = Object.entries(by).sort((a, b) => b[1].size - a[1].size)[0];
  if (!top) return null;
  const m = db.master[top[0]];
  return { head: `${m.name} ${m.spec}`, names: [...top[1]].slice(0, 3), n: top[1].size };
}
function ResultWin() {
  const b = S.building, db = S.db, sn = S.snap;
  const running = b && b.stage !== 'done';
  const order = STAGES.map(s => s[0]);
  const cur = running ? order.indexOf(b.stage) : 99;
  const st = id => { const i = order.indexOf(id); return i < cur ? '' : i === cur ? 'run' : 'wait'; };
  const mark = id => st(id) ? '' : '✓';
  const prog = id => b?.prog[id] ? ` ${b.prog[id][0]} / ${b.prog[id][1]}` : '';
  const v1 = sn?.v1, alerts = db && !running ? pastAlerts() : [];
  const cnt = t => alerts.filter(a => t.includes(a.type)).length;
  const missed = alerts.filter(a => a.amount > 0).reduce((s, a) => s + a.amount, 0);
  const ex = db && !running ? aliasExample(db) : null;
  const surgeons = db ? new Set(Object.values(db.sets).map(s => s.surgeon)).size : 0;
  const files = sn?.report.files || [];
  const hdr = k => files.find(f => f.kind === k)?.headerRow || 1;
  const nRule = db ? db.rules.filter(r => r.type !== 'info').length : 0;
  return html`<${Win} title="처음 설정" sub="2 / 2 분석 결과" id="win-result"><div class="wbody">
    <div class="wh">${running ? html`파일 내용과 구조를 <em>읽고 있어요</em>` : html`파일 내용과 구조를 읽어 <em>DB를 만들었어요</em>`}</div>
    <div class="underline" style=${running ? `width:${Math.max(6, (cur + 1) / order.length * 100)}%` : ''}></div>
    ${running ? html`<div class="strip busy">에이전트 처리 중 · LLM 동시 호출 ${llm.stats.active}건 (키 20개로 나눠 처리)</div>` : html`
    <div class="tiles">
      <div class="tile"><b>${v1.ops.toLocaleString()}</b><span>수술 건 · 집도의 ${surgeons}명</span></div>
      <div class="tile"><b>${v1.masterItems}</b><span>재료 품목 · 호칭 ${v1.aliasNames}종 묶음</span></div>
      <div class="tile"><b>${v1.sets}</b><span>술식 · 집도의별 세트</span></div>
      <div class="tile"><b>${v1.rules}</b><span>기준 변경 공지 → 규칙 ${nRule}개</span></div>
    </div>
    ${ex && html`<div class="ambox"><b>같은 재료, 다른 이름을 하나로 묶었어요</b>${ex.head} ≡ ${ex.names.join(' ≡ ')}${ex.n > 3 ? ` 외 ${ex.n - 3}가지` : ''}</div>`}
    <div class="tealbar"><i></i>우리 병원 재료 DB <span>v1</span> 생성 완료 <span style="margin-left:auto">${sn.sec.toFixed(1)}초 · LLM ${sn.llm.calls}회</span></div>
    <div class="wtabs"><a class="on">요약</a><a href="#/db" onClick=${() => { S.dbTab = 'alias'; }}>별칭 ${v1.codes}</a><a href="#/db" onClick=${() => { S.dbTab = 'pref'; }}>세트 ${v1.sets}</a><a href="#/db" onClick=${() => { S.dbTab = 'rules'; }}>기준 ${v1.rules}</a><a href="#/audit">과거 대조 ${alerts.length}</a></div>`}
    <div class="checks">
      <div><span class=${'ck ' + st('read')}>${mark('read')}</span><b>구조 판독</b><span>${running ? '파일 종류를 머리글과 내용으로 판별' + prog('read') : `수술간호기록지 ${files.filter(f => f.kind === 'record').length}건 서식 인식 · 청구 목록 ${hdr('claims')}행 머리글 · 재료 마스터 ${hdr('master')}행 머리글 · Case cart 세트 ${hdr('sets')}행 머리글 · 기준 변경 공지 ${v1.rules}개 블록`}</span></div>
      <div><span class=${'ck ' + st('extract')}>${mark('extract')}</span><b>정보 추출</b><span>${running ? '기록지에서 재료 · 규격 · 수량 · 집도의 · 술식' + prog('extract') : `수술 ${v1.ops.toLocaleString()}건 · 기록 ${v1.recordLines.toLocaleString()}줄 · 청구 ${v1.claimLines.toLocaleString()}줄`}</span></div>
      <div><span class=${'ck ' + st('alias')}>${mark('alias')}</span><b>별칭 통합</b><span>${running ? '현장 호칭을 재료코드에 연결하고 청구 기록으로 검증' : `기록지 표기 ${v1.notations}종 → 재료코드 ${v1.codes}개로 통합`}</span></div>
      <div><span class=${'ck ' + st('build')}>${mark('build')}</span><b>세트 · 경향</b><span>${running ? '집도의 · 술식별 세트와 사용 경향' : `세트 ${v1.sets}개 · 집도의 ${surgeons}명`}</span></div>
      <div><span class=${'ck ' + st('rules')}>${mark('rules')}</span><b>기준 규칙화</b><span>${running ? '기준 변경 공지를 점검 규칙으로' : `공지 ${v1.rules}건 → 규칙 ${nRule}개`}</span></div>
      <div><span class=${'ck ' + st('audit')}>${mark('audit')}</span><b>과거 기록 대조</b><span>${running ? '쌓인 기록에서 확인할 항목 찾기' : `수술 ${new Set(alerts.map(a => a.op)).size}건에서 확인할 항목 ${alerts.length}개`}</span></div>
    </div>
    ${!running && html`<div class="ambox"><b>과거 기록을 서로 대조한 결과 (가상 금액)</b>누락 ${cnt(['missing'])} · 수량 ${cnt(['qty_mismatch'])} · 규격 ${cnt(['spec_mismatch'])} · 급여 기준 ${cnt(RULE_TYPES)} · 참고 ${cnt(['unrecorded'])}건 — 청구에서 빠진 금액 추정 ${manwon(missed)}</div>
    <div class="wfoot">판정은 규칙 · 통계 기반 · 사람이 입력한 것 없음</div>`}
  </div><//>`;
}
// 저장된 DB를 불러왔을 때, 그 DB를 만든 파일 목록을 다시 보여 준다
function groupsFromDB(db) {
  const by = {};
  for (const f of db.files || []) (by[f.kind] ||= []).push(f);
  const out = [];
  if (by.record) { const e = {}; by.record.forEach(f => { const x = f.name.split('.').pop().toLowerCase(); e[x] = (e[x] || 0) + 1; });
    out.push({ ext: Object.keys(e)[0], name: `수술간호기록지 ${by.record.length}개`, sub: `수술간호기록지 · ${Object.entries(e).map(([k, n]) => `${k.toUpperCase()} ${n}`).join(' · ')}`, cnt: `${by.record.length}건` }); }
  for (const k of ['claims', 'master', 'sets', 'notices']) for (const f of by[k] || [])
    out.push({ ext: f.name.split('.').pop().toLowerCase(), name: f.name.split('/').pop(), sub: KIND_LABEL[k] + (f.headerRow ? ` · 머리글 ${f.headerRow}행` : ''), cnt: f.rows ? `${f.rows.toLocaleString()}행` : '' });
  return out;
}
function StartPage() {
  const running = S.building && S.building.stage !== 'done';
  // 출력 화면은 분석을 시작한 뒤에만 보인다. 새 파일을 올려 두고 아직 분석하지 않았으면 이전 결과도 감춘다.
  const showResult = running || (S.db && !S.resultHidden);
  const restored = S.db && !S.stage && !S.building; // 이 브라우저에 저장돼 있던 DB
  return html`<div class="page">
    <div class="head"><div><h1>파일을 올리면 Loop DB v1이 만들어집니다</h1><p class="sub">병원에 이미 있는 파일을 그대로 올립니다. 파일 이름이나 서식을 맞출 필요가 없고, EHR에는 연결하지 않습니다.</p></div></div>
    ${S.buildError && html`<div class="notice amber"><b>마치지 못했습니다.</b> ${S.buildError}</div>`}
    ${restored && html`<div class="notice">이 브라우저에 저장해 둔 Loop DB v${S.db.version}을 불러왔습니다 (${new Date(S.db.builtAt).toLocaleString('ko-KR')}에 분석). 처음부터 다시 보려면 왼쪽 아래 "처음부터 다시"를 누르거나, 파일을 새로 올려 분석하세요.</div>`}
    <div class="pair">
      <div class="col"><${TagHead}>병원에 이미 있는 파일<//><${UploadWin} restored=${restored ? groupsFromDB(S.db) : null} /></div>
      ${showResult ? html`<div class="arrow">→</div>
      <div class="col"><${TagHead} out=${true}>우리 병원 Loop DB v1<//><${ResultWin} /></div>` : html`<div></div><div></div>`}
    </div>
    ${showResult && !running && html`<div class="row"><a class="btn pri" href="#/audit">과거 대조 결과 보기</a><a class="btn" href="#/db">Loop DB 열어 보기</a><a class="btn" href="#/ehr">설치 후 수술 ${Object.keys(S.db.pending).length}건 읽기</a></div>`}
  </div>`;
}

// ───────────────────────── 2. Loop DB ─────────────────────────
const SRC_LABEL = { code: ['코드가 적힌 줄', 'teal'], 'llm+data': ['LLM 제안 · 청구로 확인', 'teal'], 'llm→data': ['청구 기록으로 교정', 'amber'], data: ['청구 기록에서 추정', 'amber'], llm: ['LLM 제안', 'blue'], 'llm?': ['LLM 제안 · 확인 필요', 'red'], none: ['미연결', 'red'] };
function UpdateWin({ id = 'win-update' }) {
  const db = S.db, log = db.changelog, v1 = log[0]?.snapshot || summary(db), now = summary(db);
  const added = log.map(c => c.snapshot.records - v1.records);
  const max = Math.max(1, ...added);
  const revised = Object.values(db.sets).reduce((n, s) => n + s.history.length, 0);
  const lab = i => i === 0 ? '설치 때' : `${i}개월`;
  return html`<${Win} title="Loop DB" sub="갱신" id=${id}><div class="wbody">
    <div class="wh">화면에서 읽은 기록이 <em>DB에 더해져요</em></div>
    <div><div class="bars">${log.map((c, i) => html`<div class=${i === log.length - 1 ? 'last' : ''}><b>+${added[i]}</b><i style=${`height:${Math.round(added[i] / max * 100)}px`}></i></div>`)}</div>
      <div class="barlab">${log.map((c, i) => html`<div><b>v${c.version}</b>${lab(i)}</div>`)}</div></div>
    <div class="wfoot" style="text-align:left">막대: 파일로 만든 수술 ${v1.ops.toLocaleString()}건 위에 화면에서 읽어 더한 수술 건수 · 지금 v${db.version}</div>
    <div class="tiles t3">
      <div class="tile"><b>${(v1.ops + now.records - v1.records).toLocaleString()}</b><span>수술 건 <em>+${now.records - v1.records}</em></span></div>
      <div class="tile"><b>${now.notations}</b><span>현장 표기 <em>+${now.notations - v1.notations}</em></span></div>
      <div class="tile"><b>${revised}</b><span>세트 개정</span></div>
    </div>
    <div class="ambox"><b>더해지는 것</b>화면에서 읽은 새 수술기록 · 새 표기 · 확인을 마친 알림 · 승인된 세트 개정 · 기준 공지</div>
    <div class="plist">${log.slice().reverse().map(c => html`<div>${c.version === 1 ? `파일 ${db.files.length}개로 DB v1 생성 — 수술 ${v1.ops.toLocaleString()}건 · 기록지 ${v1.records}건` : `EHR 화면에서 읽은 수술 ${c.addedOps}건 반영 (${c.reason.replace(' 수술분 반영', '')}) · 새 호칭 ${c.newAliases ?? 0}종 → v${c.version}`}</div>`)}
      ${Object.values(db.sets).flatMap(s => s.history.map(h => html`<div>${s.surgeon} ${s.procedure} ${s.level} 세트 ${h.from} → ${h.to} 개정 (${h.date})</div>`))}</div>
    <div class="wfoot">기준 · 경향은 사람이 다시 쓰지 않아도 최신 기록에서 매번 다시 읽음</div>
  </div><//>`;
}
function DBPage() {
  const db = S.db, s = summary(db);
  const tabs = [['alias', '별칭 사전', s.aliasNames], ['pref', '집도의 · 세트', s.sets], ['rules', '공지 규칙', s.rules], ['kb', 'KB 파일'], ['log', '버전 이력', db.changelog.length]];
  return html`<div class="page wide">
    <div class="head"><div><h1>우리 병원 Loop DB <span class="muted">v${db.version}</span></h1>
      <p class="sub">올린 파일과 읽은 수술에서만 만든 병원 고유 지식입니다. 사람이 입력한 것은 없습니다.</p></div></div>
    <div class="grid" style="grid-template-columns:minmax(0,430px) minmax(0,1fr);align-items:start">
      <${UpdateWin} />
      <${Win} title="Loop DB" sub="우리 병원 Knowledge Base" id="win-db"><div>
        <div class="tabs" style="padding:0 10px">${tabs.map(([id, label, n]) => html`<button class=${'tab' + (S.dbTab === id ? ' on' : '')} onClick=${() => { S.dbTab = id; draw(); }}>${label}${n != null ? html`<span class="n">${n}</span>` : ''}</button>`)}</div>
        ${S.dbTab === 'alias' && html`<${AliasTab} />`}
        ${S.dbTab === 'pref' && html`<${PrefTab} />`}
        ${S.dbTab === 'rules' && html`<${RulesTab} />`}
        ${S.dbTab === 'kb' && html`<${KBTab} />`}
        ${S.dbTab === 'log' && html`<${LogTab} />`}
      </div><//>
    </div>
  </div>`;
}
function AliasTab() {
  const db = S.db, q = S.aliasQ.toLowerCase();
  const byFam = {};
  for (const a of Object.values(db.aliases)) (byFam[a.family || '(미연결)'] ||= []).push(a);
  let fams = Object.entries(byFam).sort((a, b) => b[1].reduce((s, x) => s + x.n, 0) - a[1].reduce((s, x) => s + x.n, 0));
  if (q) fams = fams.filter(([f, al]) => f.toLowerCase().includes(q) || al.some(a => a.key.includes(q) || a.examples.some(e => e.toLowerCase().includes(q))));
  return html`<div>
    <div class="row" style="padding:12px 16px"><input id="alias-q" type="text" placeholder="호칭이나 품목으로 찾기 (예: 케이지, screw)" style="width:300px" value=${S.aliasQ} onInput=${e => { S.aliasQ = e.target.value; draw(); }} />
      <span class="small muted">LLM이 제안하고, 같은 수술의 청구 목록이 확인합니다.</span></div>
    <div class="tablewrap" style="max-height:600px;overflow-y:auto"><table class="t"><thead><tr><th>병원 품목군 (재료 마스터)</th><th>현장에서 부르는 이름</th><th class="r">사용</th><th>연결 근거</th></tr></thead><tbody>
      ${fams.map(([f, al]) => { al.sort((a, b) => b.n - a.n); const src = {}; al.forEach(a => src[a.source] = (src[a.source] || 0) + 1);
        return html`<tr><td style="min-width:200px"><b>${f}</b><div class="small muted">${db.families[f] ? `${db.families[f].maker || ''} · ${db.families[f].codes.length}규격 · ${db.families[f].benefits.join('/')}` : ''}</div></td>
          <td>${al.map(a => html`<span class="code" style="margin:0 4px 4px 0;display:inline-block" title=${a.examples.join(' / ')}>${a.examples[0]?.replace(/\s*\(.*$/, '') || a.key} <span class="muted">${a.n}</span></span>`)}</td>
          <td class="r">${al.reduce((s, a) => s + a.n, 0)}</td>
          <td>${Object.entries(src).map(([k, n]) => html`<${Pill} tone=${(SRC_LABEL[k] || [k, ''])[1]}>${(SRC_LABEL[k] || [k])[0]} ${n}<//> `)}</td></tr>`; })}
    </tbody></table></div></div>`;
}
const mode = a => { const c = {}; let b = a[0]; a.forEach(v => { c[v] = (c[v] || 0) + 1; if (c[v] > c[b]) b = v; }); return b; };
function PrefTab() {
  const db = S.db, M = db.master;
  return html`<div class="tablewrap" style="max-height:640px;overflow-y:auto"><table class="t"><thead><tr><th>세트</th><th>집도의 · 술식</th><th class="r">수술</th><th>세트 임플란트</th><th>최근 10건에서 실제로 쓴 임플란트</th></tr></thead><tbody>
    ${Object.values(db.sets).map(s => {
      const recs = Object.values(db.records).filter(r => r.setCode === s.code).sort((a, b) => (a.date + a.op).localeCompare(b.date + b.op));
      const last = recs.slice(-10); const use = {};
      for (const r of last) { const seen = {}; r.lines.forEach(l => { if (l.code && l.src === 'material') seen[l.code] = (seen[l.code] || 0) + l.qty; }); Object.entries(seen).forEach(([c, q]) => (use[c] ||= []).push(q)); }
      return html`<tr><td><span class="code">${s.code}</span><div class="small muted">${s.version} · ${s.revised}</div></td><td><b>${s.surgeon}</b> ${s.procedure} ${s.level}</td><td class="r">${recs.length}</td>
        <td class="small">${s.items.filter(i => /임플란트/.test(i.kind)).map(i => html`<div>${i.code === 'TRAY' ? html`<${Pill}>트레이<//> ` : ''}${short(i.name)} ${i.spec} × ${i.qty}</div>`)}</td>
        <td class="small">${Object.entries(use).sort((a, b) => b[1].length - a[1].length).slice(0, 7).map(([c, qs]) => html`<div>${short(M[c].name)} ${M[c].spec} <span class="muted">· ${last.length}건 중 ${qs.length}건 · 보통 ${mode(qs)}개</span></div>`)}</td></tr>`; })}
  </tbody></table></div>`;
}
const RULE_KO = { non_billable: '산정 불가', bundled: '정액 포함', qty_limit: '수량 한도', price_change: '단가 변경', discontinued: '사용 중지', set_policy: '세트 개정 기준', info: '안내' };
function RulesTab() {
  const db = S.db;
  if (!db.rules.length) return html`<div class="empty">공지 파일이 없거나 규칙을 읽지 못했습니다.</div>`;
  return html`<div class="tablewrap"><table class="t"><thead><tr><th>공지</th><th>시행일</th><th>규칙 유형</th><th>청구 점검에 쓰는 내용</th><th>대상</th></tr></thead><tbody>
    ${db.rules.map(r => html`<tr><td><b>${r.no}. ${r.title}</b><div class="small muted">${r.docNo}</div></td><td class="num">${r.effective}</td><td><${Pill} tone=${r.type === 'info' ? '' : 'teal'}>${RULE_KO[r.type] || r.type}<//></td>
      <td class="small" style="max-width:380px">${r.summary}</td>
      <td class="small">${[...r.codes, ...r.keywords, ...r.classCodes.map(c => '중분류 ' + c)].map(x => html`<span class="code" style="margin-right:4px">${x}</span>`)}${r.maxPerOp != null ? ` 한도 ${r.maxPerOp}` : ''}${r.pct != null ? ` ${r.pct}%` : ''}</td></tr>`)}
  </tbody></table></div>`;
}
function LogTab() {
  const db = S.db;
  return html`<div class="tablewrap"><table class="t"><thead><tr><th>버전</th><th>갱신 사유</th><th class="r">더해진 수술</th><th class="r">새 호칭</th><th class="r">누적 수술기록</th><th class="r">누적 표기</th><th>시각</th></tr></thead><tbody>
    ${db.changelog.map(c => html`<tr><td><b>v${c.version}</b></td><td>${c.reason}</td><td class="r">+${c.addedOps ?? 0}</td><td class="r">+${c.newAliases ?? 0}</td><td class="r">${c.snapshot.records}</td><td class="r">${c.snapshot.notations}</td><td class="small muted">${new Date(c.at).toLocaleString('ko-KR')}</td></tr>`)}
  </tbody></table><p class="small muted" style="padding:10px 16px">수술 한 건을 읽을 때마다 바뀐 부분만 반영하고(증분 갱신), 한 달치를 다 읽으면 전체를 정리해 버전을 올립니다(주기적 전체 정리).</p></div>`;
}
function KBTab() {
  const [files] = useState(() => buildKB(S.db));
  const [open, setOpen] = useState({ '재료': true, '세트': true, '집도의': true, '기준': true });
  const paths = Object.keys(files).sort((a, b) => a.localeCompare(b, 'ko'));
  const dirs = {};
  for (const p of paths) { const d = p.includes('/') ? p.split('/')[0] : ''; (dirs[d] ||= []).push(p); }
  const cur = files[S.kbFile] != null ? S.kbFile : 'README.md';
  const openFile = p => { if (files[p] != null) { S.kbFile = p; draw(); } };
  const renderDoc = text => text.split('\n').map(line => {
    const parts = line.split(/(\[\[[^\]]+\]\])/).map(seg => { const m = /^\[\[([^\]]+)\]\]$/.exec(seg); return m ? html`<span class="lnk" onClick=${() => openFile(m[1])}>${m[1].replace(/\.md$/, '')}</span>` : seg; });
    if (line.startsWith('# ')) return html`<div class="h1">${line.slice(2)}</div>`;
    if (line.startsWith('## ')) return html`<h4>${line.slice(3)}</h4>`;
    return html`<div>${parts}${line === '' ? html`<br />` : ''}</div>`;
  });
  return html`<div class="kb">
    <div class="tree">
      ${(dirs[''] || []).map(p => html`<div class=${'file' + (p === cur ? ' on' : '')} style="padding-left:14px" onClick=${() => openFile(p)}>${p}</div>`)}
      ${Object.entries(dirs).filter(([d]) => d).map(([d, ps]) => html`<div><div class="dir" onClick=${() => setOpen({ ...open, [d]: !open[d] })}>${open[d] ? '▾' : '▸'} ${d}/ <span class="muted small">${ps.length}</span></div>
        ${open[d] && ps.slice(0, 400).map(p => html`<div class=${'file' + (p === cur ? ' on' : '')} title=${p} onClick=${() => openFile(p)}>${p.split('/').slice(1).join('/')}</div>`)}</div>`)}
    </div>
    <div class="doc"><div class="small muted mono" style="margin-bottom:8px">${cur}</div>${renderDoc(files[cur])}</div>
  </div>`;
}

// ───────────────────────── 3. 과거 대조 ─────────────────────────
function AuditPage() {
  const db = S.db, M = db.master, alerts = pastAlerts();
  const types = [...RECORD_TYPES, ...RULE_TYPES].filter(t => alerts.some(a => a.type === t));
  const shown = alerts.filter(a => S.auditType === 'all' || a.type === S.auditType).sort((a, b) => b.date.localeCompare(a.date));
  const missed = alerts.filter(a => a.amount > 0).reduce((s, a) => s + a.amount, 0);
  const over = alerts.filter(a => a.amount < 0).reduce((s, a) => s - a.amount, 0);
  const nRec = alerts.filter(a => RECORD_TYPES.includes(a.type)).length;
  const dates = Object.values(db.claims).map(c => c.date).sort();
  return html`<div class="page">
    <div class="head"><div><h1>만들자마자 과거 기록을 대조합니다</h1><p class="sub">쌓여 있던 ${dates[0]?.slice(0, 7)}부터 설치 전까지의 기록에서 확인할 항목을 찾았습니다. 자동으로 고치거나 전송하지 않습니다.</p></div></div>
    <${Win} title="청구 도우미" sub="과거 기록 대조 결과" id="win-audit"><div class="wbody">
      <div class="tiles" style="grid-template-columns:repeat(4,minmax(0,1fr))">
        <div class="tile"><b>${alerts.length}</b><span>확인할 항목 · 수술 ${new Set(alerts.map(a => a.op)).size}건</span></div>
        <div class="tile"><b>${nRec}</b><span>기록지 ↔ 청구 목록</span></div>
        <div class="tile"><b>${alerts.length - nRec}</b><span>공지 규칙 위반</span></div>
        <div class="tile"><b>${manwon(missed)}</b><span>빠진 금액 추정 · 삭감 위험 ${manwon(over)}</span></div>
      </div>
      <div class="wtabs"><button class=${S.auditType === 'all' ? 'on' : ''} onClick=${() => { S.auditType = 'all'; draw(); }}>전체 ${alerts.length}</button>
        ${types.map(t => html`<button class=${S.auditType === t ? 'on' : ''} onClick=${() => { S.auditType = t; draw(); }}>${ALERT_LABEL[t]} ${alerts.filter(a => a.type === t).length}</button>`)}</div>
      <div class="tablewrap"><table class="t"><thead><tr><th>수술</th><th>유형</th><th>재료</th><th>근거</th><th class="r">추정 금액</th></tr></thead><tbody>
        ${shown.map(a => html`<tr key=${a.id}>
          <td><span class="mono">${a.op}</span><div class="small muted num">${a.date}</div></td>
          <td><${Pill} tone=${TYPE_TONE[a.type]}>${ALERT_LABEL[a.type]}<//></td>
          <td><b>${a.name}</b> ${a.spec} ${a.code && html`<span class="code">${a.code}</span>`}${a.otherCode && M[a.otherCode] ? html`<div class="small muted">청구된 품목: ${M[a.otherCode].spec} <span class="code">${a.otherCode}</span></div>` : ''}
            ${a.raw ? html`<div class="small muted">기록지 표기: ${[...new Set(a.raw)].map(r => `"${r}"`).join(', ')}</div>` : ''}</td>
          <td class="small">${a.why}</td>
          <td class="r">${a.amount > 0 ? html`<b style="color:var(--red)">+${won(a.amount)}</b><div class="small muted">못 받은 금액</div>` : a.amount < 0 ? html`${won(-a.amount)}<div class="small muted">삭감 · 환수 위험</div>` : '–'}</td></tr>`)}
      </tbody></table></div>
      <div class="wfoot">기록지가 있는 수술은 기록지와 청구 목록을 대조하고, 기록지가 없는 기간은 공지 규칙으로만 점검했습니다 (가상 금액)</div>
    </div><//>
  </div>`;
}

// ───────────────────────── 4. 청구 대조 알림 (EHR 화면 옆) ─────────────────────────
const pendingList = () => Object.values(S.db.pending).sort((a, b) => (a.date + a.op).localeCompare(b.date + b.op));
function selectOp(op) { S.ehr = { ...S.ehr, op, result: null, dismissed: {}, hl: null, hlRaw: null, entry: { code: '', qty: '' }, busy: false }; draw(); if (op) doRead(); }
async function doRead() {
  const E = S.ehr, db = S.db, op = E.op;
  if (!op || !db.pending[op] || E.busy) return;
  E.busy = true; draw();
  try {
    const p = db.pending[op];
    const r = await readScreen(db, op, { llm, cache, mode: S.mode === 'cache' ? 'cache' : 'live', screenText: p.text });
    if (S.ehr !== E) return; // 그사이 다른 수술을 골랐다
    E.result = r;
    if (!S.snap.streamAlerts[op]) S.snap.streamAlerts[op] = clone(r.alerts); // 채점용: 처음 읽었을 때의 알림
    persist();
  } catch (e) { toast('화면을 읽지 못했습니다: ' + (e?.message || e)); }
  E.busy = false; draw();
}
function reaudit() {
  const E = S.ehr, db = S.db, p = db.pending[E.op];
  if (!E.result) return draw();
  const saved = db.claims[E.op]; db.claims[E.op] = p.claim;
  E.result.alerts = auditOp(db, E.op, { claim: p.claim, record: E.result.rec });
  if (saved) db.claims[E.op] = saved; else delete db.claims[E.op];
  persist(); draw();
}
function claimAdd() {
  const E = S.ehr, db = S.db, p = db.pending[E.op];
  const code = E.entry.code.trim().toUpperCase(), qty = Number(E.entry.qty) || 1;
  const m = db.master[code];
  if (!m) return toast('재료 마스터에 없는 코드입니다: ' + (code || '(빈 칸)'));
  p.claim.lines.push({ seq: p.claim.lines.length + 1, code, name: m.name, spec: m.spec, qty, unit: m.unit, price: m.cap, amount: m.cap * qty, benefit: m.benefit, status: '입력' });
  E.entry = { code: '', qty: '' }; E.hl = code; reaudit();
}
function claimQty(i, v) { const l = S.db.pending[S.ehr.op].claim.lines[i]; l.qty = Math.max(0, Number(v) || 0); l.amount = l.qty * l.price; reaudit(); }
function claimDel(i) { S.db.pending[S.ehr.op].claim.lines.splice(i, 1); reaudit(); }
function doCommit() {
  const E = S.ehr, db = S.db;
  const list = pendingList(); const idx = list.findIndex(p => p.op === E.op);
  const r = commitOp(db, E.op, E.result.rec);
  persist();
  toast(r.bumped ? `Loop DB v${r.version} 로 갱신했습니다. 이번 달 수술을 모두 반영했습니다.` : `${E.op} 기록을 Loop DB에 더했습니다.`);
  const next = list[idx + 1] || list[idx - 1];
  selectOp(next && db.pending[next.op] ? next.op : null);
}
function nextOp() { const list = pendingList(); const i = list.findIndex(p => p.op === S.ehr.op); selectOp((list[i + 1] || list[0]).op); }
async function runBatch(skipConfirm) {
  const db = S.db;
  if (skipConfirm !== true && !confirm(`남은 수술 ${Object.keys(db.pending).length}건을 날짜순으로 모두 읽어 Loop DB에 반영할까요? 청구 목록은 고치지 않고 알림만 남깁니다.`)) return;
  S.batch = { d: 0, n: Object.keys(db.pending).length }; draw();
  try {
    const r = await runAllPending(db, { llm, cache, mode: S.mode === 'cache' ? 'cache' : 'live', onProgress: (d, n) => { S.batch = { d, n }; draw(); } });
    const by = {}; for (const a of r.alerts) (by[a.op] ||= []).push(a);
    for (const [op, al] of Object.entries(by)) if (!S.snap.streamAlerts[op]) S.snap.streamAlerts[op] = al;
    S.ehr = { ...S.ehr, op: null, result: null };
    toast(`수술 ${r.ops}건을 읽었습니다. Loop DB v${db.version} · 알림 ${r.alerts.length}건`);
  } catch (e) { toast('일괄 읽기를 마치지 못했습니다: ' + (e?.message || e)); }
  S.batch = null; persist(); draw();
}
const rawMatch = (raw, l) => raw && raw.some(r => r.replace(/\s/g, '') === `${l.rawName} ${l.rawSpec}`.replace(/\s/g, ''));
function showRow(code, raw) { S.ehr.hl = code; S.ehr.hlRaw = raw || null; draw(); setTimeout(() => document.getElementById('cl-' + code)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 30); }
function fillEntry(code, qty, raw) { S.ehr.entry = { code, qty: String(qty) }; S.ehr.hl = null; S.ehr.hlRaw = raw || null; draw(); setTimeout(() => document.getElementById('entry-code')?.focus(), 30); }

function EHRRecordWin({ p, id = 'win-ehr-record' }) {
  const E = S.ehr, r = p.rec;
  if (!r) return html`<${Win} brand=${false} cls="ehr2" title="OO병원 | 수술간호기록" sub="HIS-APP07" id=${id}><div class="empty">이 수술은 기록지가 없습니다.</div><//>`;
  const mats = r.lines.filter(l => l.src === 'material'), drains = r.lines.filter(l => l.src === 'drain');
  const dept = /신경/.test(r.dept) ? 'NS' : /정형/.test(r.dept) ? 'OS' : r.dept;
  return html`<${Win} brand=${false} cls="ehr2" title="OO병원 | 수술간호기록" sub=${html`HIS-APP07 <span class="chip" style="margin-left:6px">가상 데이터</span>`} id=${id}>
    <div class="meta"><span>수술번호<b>${p.op}</b></span><span>수술일<b>${r.date}</b></span><span>환자<b>${r.pid}</b></span><span>진료과<b>${r.dept}</b></span><span>집도의<b>${r.surgeon}</b></span><span>수술실<b>${r.room}</b></span></div>
    <div class="meta"><span>진단명<b>${r.diagnosis || r.site}</b></span><span>수술명<b>${r.opName}</b></span></div>
    <div class="sect">Implants</div>
    <table><thead><tr><th>진료과</th><th>부위</th><th>종류</th><th>Manufacturer</th><th>수량</th><th>재료코드</th><th>규격</th></tr></thead><tbody>
      ${mats.map(l => html`<tr class=${rawMatch(E.hlRaw, l) ? 'hl' : ''}><td>${dept}</td><td>OP site</td><td>${l.rawName.replace(/\s*\(.*$/, '')}</td><td>${(/\(([^)]*)\)/.exec(l.rawName) || [])[1] || ''}</td><td>${l.qty}</td><td>${l.givenCode}</td><td>${l.rawSpec}</td></tr>`)}
      ${!mats.length && html`<tr><td colspan="7" class="muted">기록된 치료재료 없음</td></tr>`}
    </tbody></table>
    <div class="sect">Drain and Catheter</div>
    <table><thead><tr><th>종류</th><th>수량</th><th>규격</th></tr></thead><tbody>
      ${drains.map(l => html`<tr class=${rawMatch(E.hlRaw, l) ? 'hl' : ''}><td>${l.rawName}</td><td>${l.qty}</td><td>${l.rawSpec}</td></tr>`)}
      ${!drains.length && html`<tr><td colspan="3" class="muted">없음</td></tr>`}
    </tbody></table>
  <//>`;
}
function EHRClaimWin({ p, id = 'win-ehr-claim', readonly }) {
  const E = S.ehr, db = S.db;
  const ec = E.entry.code?.trim().toUpperCase();
  return html`<${Win} brand=${false} cls="ehr2" title="수술 재료 청구 목록" sub="Case Cart 전송 재료 · 원무 전송 전" id=${id}>
    <div class="scroll" id=${id + '-scroll'}><table style="margin-top:0"><thead><tr><th>순번</th><th>재료명</th><th>코드</th><th>규격</th><th>수량</th><th>급여</th><th></th></tr></thead><tbody>
      ${p.claim.lines.map((l, i) => html`<tr class=${E.hl === l.code ? 'hl' : ''} id=${readonly ? null : 'cl-' + l.code}><td>${i + 1}</td><td>${l.name}</td><td class="mono">${l.code}</td><td>${l.spec}</td>
        <td><input type="number" min="0" style="width:48px" value=${l.qty} disabled=${readonly} onChange=${e => claimQty(i, e.target.value)} /></td><td>${l.benefit}</td>
        <td><button class="del" title="이 줄 삭제" disabled=${readonly} onClick=${() => claimDel(i)}>🗑</button></td></tr>`)}
    </tbody></table></div>
    <div class=${'entry' + (E.entry.code ? ' hl' : '')}><b>재료 추가</b>
      <input id=${readonly ? null : 'entry-code'} type="text" placeholder="재료코드" style="width:110px" value=${E.entry.code} disabled=${readonly} onInput=${e => { E.entry.code = e.target.value; draw(); }} />
      <input id=${readonly ? null : 'entry-qty'} type="number" min="1" placeholder="1" style="width:54px" value=${E.entry.qty} disabled=${readonly} onInput=${e => { E.entry.qty = e.target.value; draw(); }} />
      <button class="mini" disabled=${readonly} onClick=${claimAdd}>추가</button>
      <span class="small muted">${db.master[ec] ? `${db.master[ec].name} ${db.master[ec].spec}` : ''}</span></div>
  <//>`;
}
const ICON = { missing: ['!', ''], non_billable: ['!', ''], bundled: ['!', ''], qty_mismatch: ['≠', 'neq'], spec_mismatch: ['≠', 'neq'], qty_limit: ['≠', 'neq'], bundle_dup: ['≠', 'neq'], unrecorded: ['?', 'q'], price: ['₩', 'q'], discontinued: ['×', 'q'], duplicate: ['2', 'q'], unmapped: ['?', 'q'] };
function AlertCards({ alerts, actions = true }) {
  const E = S.ehr;
  return alerts.map(a => html`<div class=${'acard' + (['missing', 'non_billable', 'bundled'].includes(a.type) ? ' red' : '')} key=${a.id}>
    <span class=${'ic ' + ICON[a.type][1]}>${ICON[a.type][0]}</span>
    <div><h4>${item(a.name, a.spec)}</h4>
      <p>${a.type === 'missing' ? html`수술기록 ${a.recQty}개 · <b>청구 목록 없음</b>` : a.type === 'qty_mismatch' ? html`수술기록 ${a.recQty}개 · <b>청구 목록 ${a.claimQty}개</b>` : html`<b>${ALERT_LABEL[a.type]}</b> · ${a.why}`}</p>
      ${a.raw ? html`<p>기록지 "${[...new Set(a.raw)][0]}" → ${a.code} (별칭 사전)${a.amount > 0 ? ` · 빠진 금액 약 ${manwon(a.amount)}` : a.amount < 0 ? ` · 더 청구된 금액 약 ${manwon(-a.amount)}` : ''}</p>` : a.amount ? html`<p>${a.amount > 0 ? '빠진 금액' : '삭감 · 환수 위험'} 약 ${manwon(Math.abs(a.amount))}</p>` : ''}</div>
    <span class="rc">${RECORD_TYPES.includes(a.type) ? `${a.recQty} / ${a.claimQty}` : ''}</span>
    ${actions && html`<div class="acts">
      ${a.type === 'missing' && html`<button class="mini pri" onClick=${() => fillEntry(a.code, a.recQty, a.raw)}>코드를 청구 화면 입력칸에 넣기</button>`}
      ${a.type === 'spec_mismatch' && html`<button class="mini pri" onClick=${() => fillEntry(a.code, a.recQty, a.raw)}>맞는 규격을 입력칸에 넣기</button><button class="mini" onClick=${() => showRow(a.otherCode, a.raw)}>청구된 줄 보기</button>`}
      ${!['missing', 'spec_mismatch', 'unmapped'].includes(a.type) && html`<button class="mini pri" onClick=${() => showRow(a.code, a.raw)}>청구 화면 수량 칸 보기</button>`}
      <button class="mini" onClick=${() => { E.dismissed[a.id] = true; draw(); }}>이번엔 해당 없음</button></div>`}
  </div>`);
}
function matchedLines(db, r, claim) {
  const cq = {}; for (const l of claim.lines) cq[l.code] = (cq[l.code] || 0) + l.qty;
  const rq = {}, nm = {};
  for (const l of r.rec.lines) if (l.code && !db.families[l.family]?.nonBillable) { rq[l.code] = (rq[l.code] || 0) + l.qty; nm[l.code] ||= `${l.rawName.replace(/\s*\(.*$/, '')} ${l.rawSpec}`; }
  return Object.keys(rq).filter(c => rq[c] === cq[c]).map(c => `${nm[c]} ${rq[c]}/${cq[c]}`);
}
function AssistWin({ p, id = 'win-assist', actions = true }) {
  const E = S.ehr, db = S.db, r = E.result;
  if (!r) return html`<${Win} key="reading" title="청구 도우미" sub="청구 대조 알림" id=${id}><div class="wbody">
    <div class=${'strip' + (E.busy ? ' busy' : '')}>${E.busy ? 'EHR 화면 인식 중 — 기록지 화면과 청구 화면의 글자를 읽고 있어요' : 'EHR 화면 인식 대기'}</div>
    <div class="hero"><div><div class="wh">화면을 <em>읽고 있어요</em></div><p>수술기록지와 청구 목록을 대조합니다. EHR DB에는 접근하지 않습니다.</p></div><img src="img/mascot.png" alt="" /></div>
    ${!E.busy && html`<button class="btn pri" id="read-screen" onClick=${doRead}>이 화면 읽기</button>`}</div><//>`;
  const live = r.alerts.filter(a => !E.dismissed[a.id]);
  const ok = matchedLines(db, r, p.claim);
  const opn = r.rec.opName || '';
  return html`<${Win} key=${"result-" + E.op} title="청구 도우미" sub="청구 대조 알림" id=${id}><div class="wbody">
    <div class="strip">EHR 화면 인식 · 자동 — 기록 ${r.rec.lines.length}줄 · 청구 ${p.claim.lines.length}줄을 방금 읽었어요</div>
    <div class="chips"><span class="chip">검토 결과</span><span class="chip t">현재 수술</span><span class="chip g">Loop DB v${db.version}</span>${r.newAliases?.length ? html`<span class="chip g">새 표기 ${r.newAliases.length}</span>` : ''}</div>
    <div class="hero"><div><div class="wh">${live.length ? html`확인할 항목 <em>${live.length}건</em>이 있어요` : html`확인할 항목이 <em>없어요</em>`}</div>
      <p>수술기록지와 청구 목록을 대조했어요.<br />${r.rec.pid} · ${opn.split('(')[0].trim()} ${opn.split(':')[1]?.split('(')[0].trim() || ''} · ${r.rec.surgeon}</p></div><img src="img/mascot.png" alt="" /></div>
    <${AlertCards} alerts=${live} actions=${actions} />
    <div class="acard dashed"><span class="ic ok">✓</span><div><h4 style="font-size:13px">일치 ${ok.length}건</h4><p>${ok.join(' · ') || '대조할 임플란트 기록이 없습니다'}</p></div><span></span></div>
    ${actions && html`<div class="btnrow"><button class="btn" onClick=${nextOp}>나중에 확인</button>
      <button class="btn pri" id="commit-op" onClick=${doCommit}>${live.length ? '이대로 두고 기록만 반영' : '확인 완료 · 기록 반영'}</button></div>`}
    <div class="wfoot">기록지 값을 그대로 연결 · 수정은 기존 청구 화면에서 · 자동 전송 없음</div>
    ${actions && html`<details><summary class="evlink">화면에서 읽은 텍스트 보기 (${r.via === 'llm' ? 'LLM으로 읽음' : '저장 결과'})</summary><pre class="mono" style="white-space:pre-wrap;max-height:200px;overflow:auto;margin:6px 0 0;font-size:11.5px">${p.text}</pre></details>`}
  </div><//>`;
}
function EHRPage() {
  const db = S.db, E = S.ehr;
  const list = pendingList();
  const p = E.op ? db.pending[E.op] : null;
  useEffect(() => { if (!S.ehr.op && list.length) selectOp(list[0].op); else if (S.ehr.op && db.pending[S.ehr.op] && !S.ehr.result && !S.ehr.busy) doRead(); }, [E.op]);
  const doneN = Object.values(db.records).filter(r => r.date >= db.installDate).length;
  return html`<div class="page wide">
    <div class="head"><div><h1>EHR 화면을 읽어 청구 대조 알림을 띄웁니다</h1><p class="sub">설치 후에는 파일을 올리지 않습니다. 간호사가 쓰는 EHR 화면 옆에서 화면의 글자만 읽고, 원무 전송 전에 알려 줍니다.</p></div>
      <div class="right">${S.batch ? html`<span class="small num">읽는 중 ${S.batch.d} / ${S.batch.n}</span><span class="bar" style="width:160px"><i style=${`width:${S.batch.d / S.batch.n * 100}%`}></i></span>`
        : list.length ? html`<button class="btn" onClick=${() => runBatch()}>남은 ${list.length}건 모두 읽기</button>` : ''}</div></div>
    ${!list.length ? html`<div class="card empty"><b>설치 후 수술 ${doneN}건을 모두 읽었습니다.</b><br />Loop DB v${db.version} · <a href="#/db">갱신 내역 보기</a> · <a href="#/sets">세트 개정안 보기</a> · <a href="#/validate">정답지 채점</a></div>` : html`
    <div class="ehrgrid">
      <div class="col"><div class="taghead" style="visibility:hidden"><span class="tag">.</span></div><${Win} brand=${false} title="오늘의 수술" sub=${`${list.length}건`}><div class="oplist2">${list.map(x => html`<div class=${'opitem' + (x.op === E.op ? ' on' : '')} onClick=${() => selectOp(x.op)}>
        <div class="row" style="gap:6px"><b class="mono">${x.op}</b><span class="small muted num">${x.date.slice(5)}</span></div>
        <div class="small">${x.rec ? `${x.rec.surgeon} · ${(x.rec.opName || '').split('(')[0].split(':')[0].trim().slice(0, 22)}` : '기록지 없음'}</div></div>`)}</div><//></div>
      <div class="col"><${TagHead}>기존 EHR 두 화면 (기록지 · 청구 목록)<//>
        ${p && p.claim ? html`<div class="stack" id="ehr-pair"><${EHRRecordWin} p=${p} /><${EHRClaimWin} p=${p} /></div>` : html`<div class="card empty">수술을 고르세요.</div>`}</div>
      <div class="arrow">→</div>
      <div class="col"><${TagHead} out=${true}>CartLoop 청구 도우미<//>${p && p.claim && html`<${AssistWin} p=${p} />`}</div>
    </div>`}
  </div>`;
}

// ───────────────────────── 5. 세트 개정안 ─────────────────────────
const fmtAct = p => p.action === 'remove' ? `${item(p.name, p.spec)} 삭제` : p.action === 'add' ? `${item(p.name, p.spec)} ×${p.newQty} 추가` : `${item(p.name, p.spec)} ${p.setQty} → ${p.newQty}`;
const fmtWhy = p => p.action === 'remove' ? `최근 ${p.window}건 중 ${p.hits}건에서 사용 0건` : p.action === 'add' ? `최근 ${p.window}건 중 ${p.hits}건 사용` : `최근 ${p.window}건 중 ${p.hits}건이 ${p.newQty}개`;
function EvidenceWin({ sel, props, id = 'win-set-evidence' }) {
  const db = S.db, M = db.master;
  const all = proposeAll(db).filter(p => !p.tray && !p.held);
  const nBy = {}; all.forEach(p => nBy[p.setCode] = (nBy[p.setCode] || 0) + 1);
  const nOps = {}; Object.values(db.records).forEach(r => { if (r.setCode) nOps[r.setCode] = (nOps[r.setCode] || 0) + 1; });
  const sets = Object.values(db.sets).sort((a, b) => (nBy[b.code] || 0) - (nBy[a.code] || 0) || a.code.localeCompare(b.code));
  const s = db.sets[sel];
  const ops = setOps(db, sel).slice(-10);
  const use = ops.map(op => { const rec = {}, cl = {}; (db.records[op]?.lines || []).forEach(l => { if (l.code) rec[l.code] = (rec[l.code] || 0) + l.qty; }); (db.claims[op]?.lines || []).forEach(l => { cl[l.code] = (cl[l.code] || 0) + l.qty; }); return { rec, cl }; });
  const rows = [...props.map(p => ({ code: p.code, basis: p.basis, set: p.setQty })),
    ...s.items.filter(i => /임플란트/.test(i.kind) && i.code !== 'TRAY' && !props.some(p => p.code === i.code)).map(i => ({ code: i.code, basis: 'record', set: i.qty }))].slice(0, 6);
  return html`<${Win} title="근거 자료" sub="세트와 실제 사용 기록" id=${id}><div class="wbody tight">
    <div style="display:grid;gap:6px;max-height:262px;overflow-y:auto" id="set-list">${sets.map(x => html`<div class=${'setrow' + (x.code === sel ? ' on' : '')} onClick=${() => { S.setSel = x.code; S.setPick = {}; draw(); }}>
      <b>${x.surgeon} · ${x.procedure} ${x.level === '편측' ? '' : x.level}</b><small>세트 ${x.version} · 수술 ${nOps[x.code] || 0}건</small>
      ${nBy[x.code] ? html`<span class="chip">개정안 ${nBy[x.code]}</span>` : ''}</div>`)}</div>
    ${ops.length ? html`<div class="tablewrap"><table class="use"><thead><tr><th>최근 ${ops.length}건 사용 수량</th>${ops.map(op => html`<th>${db.records[op].date.slice(5)}</th>`)}<th>세트</th></tr></thead><tbody>
      ${rows.map(r => html`<tr><td>${item(M[r.code].name, M[r.code].spec)}</td>${use.map(u => { const v = (r.basis === 'record' ? u.rec : u.cl)[r.code] || 0; return html`<td class=${v !== r.set ? 'hit' : v === 0 ? 'zero' : ''}>${v || '·'}</td>`; })}<td><b>${r.set || '–'}</b></td></tr>`)}
    </tbody></table></div>` : html`<div class="empty">개정일 뒤 이 세트로 한 수술이 아직 없습니다.</div>`}
    <div class="wfoot" style="text-align:left">임플란트는 수술기록지 수량, 소모품은 청구 수량을 봅니다. 소모품은 최근 20건까지 넓혀 판단해요.<br />${s.code} · 개정일 ${s.revised} 뒤 수술 ${setOps(db, sel).length}건 · 개정안 없는 세트 ${sets.length - Object.keys(nBy).length}개 · 전체 ${sets.length}개</div>
  </div><//>`;
}
function ProposalWin({ sel, props, trays, id = 'win-set-proposal', actions = true }) {
  const db = S.db, s = db.sets[sel], P = setPolicy(db);
  const picked = props.filter(p => S.setPick[p.id] !== false);
  const next = s.version.replace(/\d+$/, n => Number(n) + 1);
  const doApprove = () => { if (!picked.length) return toast('승인할 항목을 고르세요.'); const r = approve(db, picked); S.setPick = {}; persist(); toast(r.map(x => `${x.setCode} ${x.from} → ${x.to}`).join(', ') + ' 로 개정했습니다. 다음 수술분부터 적용합니다.'); draw(); };
  const doHold = () => { picked.forEach(p => hold(db, p)); S.setPick = {}; persist(); draw(); };
  const ic = { add: ['+', 'plus'], qty: ['↑', 'neq'], remove: ['−', ''] };
  return html`<${Win} title="청구 도우미" sub="세트 개정안 승인" id=${id}><div class="wbody">
    <div class="chips"><span class="chip">개정 제안</span><span class="chip t">${s.procedure} ${s.level === '편측' ? '' : s.level} · ${s.surgeon} 세트</span></div>
    ${props.length ? html`<div class="wh">세트 <em>${s.version} → ${next}</em> 개정안이에요</div>
      <div class="wsubline">근거: 개정일(${s.revised}) 뒤 수술 ${setOps(db, sel).length}건의 사용 기록 · 임플란트 ${P.implant.window}건 중 ${P.implant.min}건, 소모품 ${P.consumable.window}건 중 ${P.consumable.min}건 이상일 때만</div>
      ${props.map(p => html`<div class="acard" key=${p.id}><span class=${'ic ' + ic[p.action][1]}>${ic[p.action][0]}</span>
        <div><h4>${fmtAct(p)}</h4><p>${fmtWhy(p)} · ${p.kind}${p.note ? ` · ${p.note.split(' · ')[0]}` : ''}</p></div>
        <input type="checkbox" id=${actions ? 'pick-' + p.code : null} checked=${S.setPick[p.id] !== false} disabled=${!actions} onChange=${e => { S.setPick[p.id] = e.target.checked; draw(); }} /></div>`)}
      ${actions && html`<div class="btnrow"><button class="btn pri" id="approve-set" onClick=${doApprove}>승인</button><button class="btn" onClick=${doHold}>보류</button></div>`}
      <div class="wfoot">승인하면 다음 수술부터 개정 세트로 전송 · 자동 변경 없음 · 보류하면 다시 올라오지 않음</div>`
      : html`<div class="wh">지금은 <em>개정할 것이 없어요</em></div><div class="wsubline">이 세트는 최근 사용 기록과 맞습니다. 현재 ${s.version} (개정일 ${s.revised}).</div>`}
    ${s.history.length > 0 && html`<div class="plist">${s.history.slice().reverse().map(h => html`<div>${h.date} ${h.from} → ${h.to} · ${h.changes.map(c => `${short(c.name)} ${c.spec} ${c.from}→${c.to}`).join(', ')} · ${h.by} 승인</div>`)}</div>`}
    ${trays.length > 0 && html`<div class="ambox"><b>트레이(업체 대여) 품목은 개정안으로 올리지 않아요</b>자주 쓴 규격: ${trays.map(t => `${short(t.name)} ${t.spec}`).join(' · ')}</div>`}
  </div><//>`;
}
function pickSet(db, open) { return open[0]?.setCode || Object.values(db.sets).find(s => s.history.length)?.code || Object.keys(db.sets)[0]; }
function SetsPage() {
  const db = S.db;
  const all = proposeAll(db);
  const open = all.filter(p => !p.tray && !p.held);
  if (!S.setSel || !db.sets[S.setSel]) S.setSel = pickSet(db, open);
  const sel = S.setSel;
  const props = open.filter(p => p.setCode === sel), trays = all.filter(p => p.tray && p.setCode === sel);
  return html`<div class="page">
    <div class="head"><div><h1>쌓인 사용 기록에서 세트 개정안을 냅니다</h1><p class="sub">근거를 먼저 보여 주고, 책임 간호사가 승인해야 세트가 바뀝니다.</p></div></div>
    <div class="pair">
      <div class="col"><${TagHead}>쌓인 사용 기록<//><${EvidenceWin} sel=${sel} props=${props} /></div>
      <div class="arrow">→</div>
      <div class="col"><${TagHead} out=${true}>CartLoop 세트 개정안<//><${ProposalWin} sel=${sel} props=${props} trays=${trays} /></div>
    </div>
  </div>`;
}

// ───────────────────────── 6. 재료 묻기 ─────────────────────────
const ASK_EXAMPLES = ['A교수님 TLIF 2레벨 때 implant 뭐 써요?', 'B교수 PLIF 나사는 보통 어떤 규격을 몇 개 써요?', '콜라스탯은 몇 개까지 청구돼요?', 'set screw는 청구 목록에 넣어도 되나요?'];
async function ask(q) {
  q = q.trim(); if (!q || S.asking) return;
  const db = S.db;
  const { context, sets, mentions } = buildContext(db, q);
  const history = S.chat.slice(-4).map(m => ({ role: m.role === 'q' ? 'user' : 'assistant', content: m.text }));
  S.chat.push({ role: 'q', text: q }); S.asking = true; draw();
  try {
    const a = await answerQuestion(llm, q, context, history);
    S.chat.push({ role: 'a', text: a, sets, fams: mentions.fams.slice(0, 3), context, version: db.version });
  } catch (e) { S.chat.push({ role: 'a', text: '답을 만들지 못했습니다. 잠시 뒤 다시 물어봐 주세요. (' + (e?.message || e) + ')', sets: [], fams: [] }); }
  S.asking = false; persist(); draw();
}
function EvidenceTable({ setCode, max = 8 }) {
  const db = S.db, M = db.master;
  if (!db.sets[setCode]) return null;
  const recs = Object.values(db.records).filter(r => r.setCode === setCode).sort((a, b) => (a.date + a.op).localeCompare(b.date + b.op)).slice(-10);
  if (!recs.length) return null;
  const use = recs.map(r => { const u = {}; r.lines.forEach(l => { if (l.code) u[l.code] = (u[l.code] || 0) + l.qty; }); return u; });
  const cnt = {}; use.forEach(u => Object.keys(u).forEach(c => cnt[c] = (cnt[c] || 0) + 1));
  const codes = Object.keys(cnt).sort((a, b) => cnt[b] - cnt[a]).slice(0, max);
  return html`<div class="tablewrap"><table class="use"><thead><tr><th>재료 · ${db.sets[setCode].surgeon} ${db.sets[setCode].procedure} ${db.sets[setCode].level}</th>${recs.map(r => html`<th title=${r.op}>${r.date.slice(5)}</th>`)}</tr></thead><tbody>
    ${codes.map(c => html`<tr><td>${item(M[c].name, M[c].spec)}</td>${use.map(u => html`<td class=${u[c] ? '' : 'zero'}>${u[c] || '·'}</td>`)}</tr>`)}</tbody></table></div>`;
}
function AskWin({ id = 'win-ask', input = true, limit = 0, evidence = true }) {
  const [q, setQ] = useState('');
  const [openEv, setOpenEv] = useState(true);
  const chat = limit ? S.chat.slice(-limit) : S.chat;
  const lastA = [...chat].reverse().find(m => m.role === 'a' && m.sets?.length);
  return html`<${Win} title="청구 도우미" sub=${input ? '우리 병원 재료 묻기' : '답변'} id=${id}><div class="wbody">
    <div class="chips"><span class="chip">내부 기록 검색</span><span class="chip t">진단 · 추천 안 함</span><span class="chip g">Loop DB v${S.db.version}</span></div>
    ${!chat.length && html`<div class="hero"><div><div class="wh">우리 병원 기록으로 <em>답해요</em></div><p>집도의 · 술식 · 재료를 넣어 물어보세요.</p></div><img src="img/mascot.png" alt="" /></div>
      ${input && html`<div style="display:grid;gap:6px;justify-items:end">${ASK_EXAMPLES.map(x => html`<button class="bubble" style="border:0;cursor:pointer" onClick=${() => ask(x)}>${x}</button>`)}</div>`}`}
    ${chat.map(m => m.role === 'q' ? html`<div class="bubble">${m.text}</div>` : html`<div class="ans">${m.text}</div>`)}
    ${S.asking && html`<div class="ans muted">우리 병원 기록을 찾아보는 중…</div>`}
    ${evidence && lastA && html`<div><span class="evlink" onClick=${() => setOpenEv(!openEv)}>${openEv ? '▾' : '▸'} 근거: 수술기록 10건 보기 <span class="code">${lastA.sets[0]}</span></span>${openEv && html`<${EvidenceTable} setCode=${lastA.sets[0]} />`}</div>`}
    ${input && html`<form style="display:flex;gap:8px" onSubmit=${e => { e.preventDefault(); ask(q); setQ(''); }}>
      <input id="ask-input" type="text" style="flex:1" placeholder="예: C교수 TLIF 나사 규격은?" value=${q} onInput=${e => setQ(e.target.value)} /><button class="btn pri" disabled=${S.asking}>묻기</button></form>`}
    <div class="wfoot">답은 우리 병원 기록에서만 · 진단 · 치료 추천은 하지 않음</div>
  </div><//>`;
}
function AskPage() {
  return html`<div class="page">
    <div class="head"><div><h1>우리 병원 기록으로 답하고, 읽은 기록은 DB에 더합니다</h1><p class="sub">구글도 모르는 우리 병원 이야기를 Loop DB 기록으로 답합니다. 기록에 없는 것은 없다고 답합니다.</p></div>
      ${S.chat.length > 0 && html`<div class="right"><button class="btn sm" onClick=${() => { S.chat = []; persist(); draw(); }}>대화 지우기</button></div>`}</div>
    <div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,1fr);align-items:start">
      <div class="col"><${TagHead} out=${true}>우리 병원 재료 묻기 — 질문과 답, 근거 수술 10건<//><${AskWin} /></div>
      <div class="col"><${TagHead} out=${true}>Loop DB 갱신 — 설치 때 v1 → 지금 v${S.db.version}<//><${UpdateWin} id="win-update-ask" /></div>
    </div>
  </div>`;
}

// ───────────────────────── 7. 정답지 채점 ─────────────────────────
async function runValidation() {
  S.validBusy = true; draw();
  try {
    const key = await (await fetch('answer/answer_key.json')).json();
    const db = S.db;
    const alerts = [...pastAlerts(), ...Object.values(S.snap.streamAlerts).flat()];
    const endDb = { ...db, sets: clone(S.snap.setsOriginal), held: {} };
    const pendingLeft = Object.keys(db.pending).length;
    S.valid = { s: score(key, { records: db.records, alerts, proposals: { v1: S.snap.proposalsV1, end: pendingLeft ? [] : proposeAll(endDb) } }), key: key.counts, pendingLeft, at: new Date().toISOString(), setItems: Object.values(S.snap.setsOriginal).reduce((n, s) => n + s.items.length, 0) };
  } catch (e) { toast('채점하지 못했습니다: ' + (e?.message || e)); }
  S.validBusy = false; draw();
}
function ValidatePage() {
  const db = S.db, V = S.valid;
  const pendingLeft = Object.keys(db.pending).length;
  return html`<div class="page">
    <div class="head"><div><h1>정답지가 있는 가상 데이터로 채점합니다</h1><p class="sub">가상 데이터에 심어 둔 오류와 기록 줄마다의 정답 코드를 따로 보관해 두고, 서비스가 낸 결과와 비교합니다.</p></div>
      <div class="right"><button class="btn pri" disabled=${S.validBusy} onClick=${runValidation}>${S.validBusy ? '채점 중…' : V ? '다시 채점' : '채점하기'}</button></div></div>
    ${pendingLeft > 0 && html`<div class="notice amber">설치 후 수술 ${pendingLeft}건을 아직 읽지 않았습니다. 지금 채점하면 읽은 수술까지만 반영됩니다. <a href="#/ehr">청구 대조 알림</a>에서 "남은 건 모두 읽기"를 누른 뒤 채점하면 전체 결과가 나옵니다.</div>`}
    ${!V && html`<div class="card empty">채점하기를 누르면 정답지(기록지 415건, 오류 53건)와 비교합니다.</div>`}
    ${V && html`<${ValidResult} V=${V} />`}
  </div>`;
}
function ValidResult({ V }) {
  const s = V.s, e = s.errors;
  const setRate = V.pendingLeft ? null : (V.setItems - s.sets.end.missed.length - s.sets.end.extra.length) / V.setItems;
  const rows = [
    ['A-1', '파일만 올려 DB v1이 만들어지는가', '필드 추출 정확도 = 정답과 일치한 필드 ÷ 전체 필드', `${fmtPct(s.extraction.accuracy)} (${s.extraction.correct.toLocaleString()} / ${s.extraction.fields.toLocaleString()})`],
    ['A-2', '같은 재료의 다른 별칭이 같은 재료코드로 묶이는가', '별칭 통합 정확도 = 올바르게 이어진 표기 ÷ 전체 표기', `표기 ${fmtPct(s.alias.notationAccuracy)} (${s.alias.notationsCorrect} / ${s.alias.notations}) · 줄 ${fmtPct(s.alias.accuracy)} (${s.alias.correct} / ${s.alias.lines})`],
    ['A-3', '수술 데이터를 추가하면 세트가 정답지대로 갱신되는가', '갱신 일치율 = 정답과 같은 세트 항목 ÷ 전체 세트 항목', setRate == null ? '설치 후 수술을 모두 읽은 뒤 계산' : `${fmtPct(setRate)} (${V.setItems - s.sets.end.missed.length - s.sets.end.extra.length} / ${V.setItems})`],
    ['B-1', '심어 둔 누락 · 수량 · 규격 오류를 대조 알림이 잡는가', '재현율 · 정밀도 (기록지 ↔ 청구)', `재현율 ${fmtPct(e.record.recall)} (${e.record.found} / ${e.record.truth}) · 정밀도 ${fmtPct(e.record.precision)}`],
    ['B-2', '급여구분 · 수량 제한 등 공지 규칙 위반을 걸러내는가', '검출률 = 걸러낸 항목 ÷ 심어 둔 항목', `${fmtPct(e.rule.recall)} (${e.rule.found} / ${e.rule.truth}) · 오탐 ${e.rule.falsePos}건`],
    ['B-3', '세트와 실제 사용이 어긋난 곳을 개정안으로 제안하는가', '제안 여부와 근거 제시', `설치 시점 ${s.sets.v1.found} / ${s.sets.v1.truth}건${V.pendingLeft ? '' : ` · 3개월 뒤 ${s.sets.end.found} / ${s.sets.end.truth}건`} · 정답에 없는 제안 ${s.sets.v1.extra.length + s.sets.end.extra.length}건`],
  ];
  return html`<${Win} title="검증" sub="정답지 채점 결과" id="win-validate"><div class="wbody">
    <div class="tiles t3">
      <div class="tile"><span>추출 정확도</span><b style="font-size:32px">${fmtPct(s.extraction.accuracy)}</b><span>추출한 필드 가운데 정답과 일치한 비율 · 기록지 ${s.extraction.found} / ${s.extraction.records}건</span></div>
      <div class="tile"><span>오류 검출 재현율</span><b style="font-size:32px">${fmtPct(e.all.recall)}</b><span>심어 둔 오류 ${e.all.truth}건 가운데 알림으로 잡은 ${e.all.found}건</span></div>
      <div class="tile"><span>오탐 비율</span><b style="font-size:32px">${fmtPct(e.all.falseRate ?? 0)}</b><span>전체 알림 ${e.all.alerts}건 가운데 실제 오류가 아닌 ${e.all.falsePos}건</span></div>
    </div>
    <div class="tablewrap"><table class="t"><thead><tr><th>시험</th><th>확인하려는 것</th><th>지표와 계산</th><th>결과</th></tr></thead><tbody>
      <tr><td colspan="4" style="background:#f1f4f3"><b>A. DB가 자동으로 구축 · 갱신되는가</b></td></tr>
      ${rows.slice(0, 3).map(r => html`<tr><td><b>${r[0]}</b></td><td>${r[1]}</td><td class="small muted">${r[2]}</td><td><b class="num">${r[3]}</b></td></tr>`)}
      <tr><td colspan="4" style="background:#f1f4f3"><b>B. 그 DB로 오류를 잡아내는가</b></td></tr>
      ${rows.slice(3).map(r => html`<tr><td><b>${r[0]}</b></td><td>${r[1]}</td><td class="small muted">${r[2]}</td><td><b class="num">${r[3]}</b></td></tr>`)}
    </tbody></table></div>
    <div class="grid g2">
      <div class="tablewrap"><table class="t"><thead><tr><th>오류 유형</th><th class="r">정답</th><th class="r">검출</th><th class="r">알림</th><th class="r">오탐</th></tr></thead><tbody>
        ${Object.entries(e.byType).filter(([, b]) => b.truth || b.alerts).map(([t, b]) => html`<tr><td>${b.label}</td><td class="r">${b.truth}</td><td class="r">${b.found}</td><td class="r">${b.alerts}</td><td class="r">${b.falsePos}</td></tr>`)}
        <tr><td><b>합계</b></td><td class="r"><b>${e.all.truth}</b></td><td class="r"><b>${e.all.found}</b></td><td class="r"><b>${e.all.alerts}</b></td><td class="r"><b>${e.all.falsePos}</b></td></tr>
      </tbody></table></div>
      <div><h3 style="margin-bottom:6px">놓친 것과 잘못 알린 것</h3>
        ${!s.detail.fn.length && !s.detail.fp.length && !s.detail.aliasMisses.length ? html`<p class="muted small">놓친 오류, 오탐, 코드 연결 오류가 없습니다.</p>` : ''}
        ${s.detail.fn.slice(0, 12).map(x => html`<div class="small"><${Pill} tone="red">놓침<//> ${x.op} · ${ALERT_LABEL[x.type]} · ${x.name} ${x.spec}</div>`)}
        ${s.detail.fp.slice(0, 12).map(x => html`<div class="small"><${Pill} tone="amber">오탐<//> ${x.op} · ${ALERT_LABEL[x.type]} · ${x.name} ${x.spec}</div>`)}
        ${s.detail.aliasMisses.slice(0, 8).map(x => html`<div class="small"><${Pill} tone="blue">코드 연결<//> ${x.op} · "${x.name}" ${x.spec} → 정답 ${x.want}, 결과 ${x.got || '미확정'}</div>`)}
        ${s.detail.fieldMisses.length > 0 && html`<p class="small muted" style="margin-top:8px">필드 불일치 ${s.extraction.fields - s.extraction.correct}건: ${s.detail.fieldMisses.slice(0, 4).map(x => `${x.op} ${x.field} (정답 "${x.want}", 결과 "${x.got ?? ''}")`).join(' · ')}</p>`}
        ${e.unmapped ? html`<p class="small muted">코드를 찾지 못해 "확인 필요"로만 띄운 표기 ${e.unmapped}건은 오류 알림에서 뺐습니다.</p>` : ''}
      </div>
    </div>
    <div class="wfoot">시험 재료: 가상 수술 1,240건(청구 42,861줄) · 수술간호기록지 415건 · 재료 마스터 312품목 · 정답지는 서비스와 다른 방법으로 작성 · 모두 가상 데이터</div>
  </div><//>`;
}

// ───────────────────────── 8. 한 화면 시연 ─────────────────────────
function ShowPage() {
  const db = S.db, E = S.ehr;
  const p = E.op ? db.pending[E.op] : null;
  const all = proposeAll(db);
  const open = all.filter(x => !x.tray && !x.held);
  const sel = pickSet(db, open);
  const props = open.filter(x => x.setCode === sel);
  const chip = (n, t, who) => html`<div class="stepchip"><i>${n}</i><b>${t}</b>${who}</div>`;
  return html`<div class="deskwrap"><div class="desk" id="desk">
    <div class="logo"><${Logo} />CartLoop</div>
    <div class="back">${p && p.claim ? html`<${EHRClaimWin} p=${p} id="desk-claim" readonly=${true} />` : html`<${Win} brand=${false} cls="ehr2" title="수술 재료 청구 목록" sub="원무 전송 전"><div class="empty" style="height:220px">청구 대조 알림에서 수술을 하나 읽으면 여기에 보입니다.</div><//>`}</div>
    <div class="fw" style="left:40px;width:425px">${chip(1, '수술 직후', '수술실 간호사')}${p && E.result ? html`<${AssistWin} p=${p} id="desk-assist" actions=${false} />` : html`<${Win} title="청구 도우미" sub="청구 대조 알림"><div class="empty">먼저 <a href="#/ehr">청구 대조 알림</a>에서 수술을 하나 읽으세요.</div><//>`}</div>
    <div class="fw" style="left:548px;width:425px">${chip(2, '다음 날', '책임 간호사')}<${ProposalWin} sel=${sel} props=${props} trays=${[]} id="desk-proposal" actions=${false} /></div>
    <div class="fw" style="left:1056px;width:440px">${chip(3, '다음 수술 전', '신규 · 이직 간호사')}<${AskWin} id="desk-ask" input=${false} limit=${2} evidence=${false} /></div>
    <div class="loop"><em>루프</em>① 기록지와 청구를 대조해 누락을 잡고 → ② 쌓인 사용 기록이 세트 개정안이 되고 → ③ 쌓인 기록이 다음 수술 준비의 답이 된다</div>
    <div class="task"><span>⊞</span><span style="background:#fff;border-radius:99px;padding:4px 60px 4px 14px">🔍 검색</span><span style="display:flex;gap:6px;align-items:center;border-bottom:2px solid var(--teal);padding-bottom:2px"><span style="width:26px;display:inline-flex"><${Logo} /></span><b>CartLoop</b></span><span>OO병원 HIS</span></div>
  </div></div>`;
}

// ───────────────────────── 앱 ─────────────────────────
function App() {
  const pages = { start: StartPage, db: DBPage, audit: AuditPage, ehr: EHRPage, sets: SetsPage, ask: AskPage, validate: ValidatePage, show: ShowPage };
  const route = S.db || S.route === 'start' ? S.route : 'start';
  const Page = pages[route] || StartPage;
  if (route === 'show') return html`<div style="background:#eef2f1;min-height:100%"><div style="padding:10px 20px 0"><a class="btn sm" href="#/ehr">← 돌아가기</a></div><${ShowPage} /></div>`;
  return html`<div class="shell"><${Side} /><main class="main"><${Page} /></main>${S.toast && html`<div class="toast" role="status">${S.toast}</div>`}</div>`;
}

(async () => {
  const saved = await store.load('state');
  if (saved?.db) { S.db = saved.db; S.snap = saved.snap; S.chat = saved.chat || []; }
  const qs = new URLSearchParams(location.search);
  if (qs.get('cache') === '1') S.mode = 'cache';
  draw();
  try { S.health = await (await fetch('/api/llm')).json(); draw(); } catch { /* 연결 정보 없이도 화면은 뜬다 */ }
  window.__cartloop = { S, draw, runBatch: () => runBatch(true), runValidation, ask, go, selectOp, startBuild, stageSample: () => stageFiles(fetchSample) };
  // 시연용 자동 실행: ?demo=1 이면 가상 병원 데이터를 올리고 바로 분석한다
  if (qs.get('demo') === '1' && !S.db) { await stageFiles(fetchSample); if (qs.get('stay') !== '1') startBuild(); }
})();
