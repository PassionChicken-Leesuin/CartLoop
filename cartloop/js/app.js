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
  mode: 'live', stage: null, building: null, buildError: null, resultHidden: false, revealed: false,
  toast: null, health: null,
  ehr: { op: null, busy: false, result: null, dismissed: {}, hl: null, hlRaw: null, entry: { code: '', qty: '' } },
  dbTab: 'alias', kbFile: 'README.md', aliasQ: '', auditType: 'all', asking: false, batch: null, valid: null, validBusy: false,
  setSel: null, setPick: {},
  // 바탕화면에서 켠 프로그램. 처음에는 아무것도 켜져 있지 않다.
  win: { cl: false, his: false, data: false }, focus: 'cl', lastRoute: 'start', explorer: null,
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
window.addEventListener('hashchange', () => {
  S.route = location.hash.replace(/^#\/?/, '') || 'start';
  // CartLoop 안의 메뉴를 눌러 온 것이므로 CartLoop는 켜진 상태다. "청구 대조 알림"은 HIS 화면 옆에서 동작한다.
  if (S.route === 'ehr') { S.win.his = true; S.win.cl = true; S.focus = 'his'; }
  else { S.win.cl = true; S.focus = 'cl'; S.lastRoute = S.route; }
  draw(); document.querySelector('.main')?.scrollTo(0, 0);
});
// 프로그램 켜기 · 끄기
function openApp(app) {
  if (app === 'his') {
    if (!S.db) toast('HIS 시연 데이터는 CartLoop에서 파일을 분석한 뒤 채워집니다. 먼저 CartLoop를 켜서 파일을 올려 주세요.', 4500);
    S.win.his = true; S.focus = 'his';
  } else if (app === 'cl') {
    const wasOpen = S.win.cl;
    S.win.cl = true;
    // HIS를 보고 있을 때 CartLoop를 켜면 그 옆에 도우미로 뜬다. 이미 켜져 있으면 전체 창으로 바꾼다.
    if (!(S.win.his && S.focus === 'his' && !wasOpen && S.db)) S.focus = 'cl';
  } else if (app === 'data') { S.win.data = true; loadExplorer(); }
  draw();
}
function closeApp(app) {
  S.win[app] = false;
  if (app === 'cl' && S.win.his) S.focus = 'his';
  if (app === 'his') S.focus = 'cl';
  if (app === 'cl' || app === 'his') S.ehr = { ...S.ehr, result: null, scan: null, busy: false };
  draw();
}
// 가상 데이터 셋 폴더(탐색기)에 보일 항목
async function loadExplorer() {
  if (S.explorer) return;
  try {
    const man = await (await fetch('sample/manifest.json')).json();
    const recs = man.files.filter(f => /\.(pdf|docx)$/i.test(f.name));
    const items = [];
    if (recs.length) items.push({ key: recs[0].name.split('/')[0] + '/', name: recs[0].name.split('/')[0], type: '파일 폴더', size: `${recs.length}개 항목`, folder: true });
    for (const f of man.files.filter(f => !/\.(pdf|docx)$/i.test(f.name))) items.push({ key: f.name, name: f.name, type: f.name.endsWith('.csv') ? 'CSV 파일' : '텍스트 문서', size: f.size > 1e6 ? (f.size / 1e6).toFixed(1) + 'MB' : Math.ceil(f.size / 1024) + 'KB' });
    S.explorer = { items, sel: Object.fromEntries(items.map(i => [i.key, true])) };
  } catch { S.explorer = { items: [], sel: {} }; }
  draw();
}
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
async function fetchSample(onProgress, keys) {
  const man = await (await fetch('sample/manifest.json')).json();
  if (keys) man.files = man.files.filter(f => keys.some(k => f.name === k || f.name.startsWith(k)));
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
  S.building = null; S.resultHidden = true; S.revealed = false; // 아직 분석하지 않은 파일이므로 이전 결과는 보이지 않게 한다
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
  S.building = { stage: 'read', prog: {}, info: {}, at: { read: Date.now() }, took: {}, t0: Date.now() };
  S.resultHidden = false;
  draw();
  try {
    await loadSampleCache();
    const before = { ...llm.stats, byKey: { ...llm.stats.byKey } };
    let lastDraw = 0;
    const res = await buildFromFiles(files, {
      llm, deps: await deps(), cache, mode: S.mode,
      onStage: s => { if (s !== 'done') { S.building.stage = s; S.building.at[s] = Date.now(); draw(); } },
      onInfo: (s, text) => { S.building.info[s] = text; S.building.took[s] = (Date.now() - (S.building.at[s] || Date.now())) / 1000; draw(); },
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
    S.snap.process = { info: S.building.info, took: S.building.took };
    persist();
    await new Promise(r => setTimeout(r, 700)); // 마지막 단계가 끝난 것을 보여 주고 결과로 넘어간다
    S.building.stage = 'done'; S.resultHidden = false;
    draw();
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
  const cur = S.route === 'ehr' ? S.lastRoute : S.route;
  const item = (r, n, label, badge) => html`<a class=${'nav' + (cur === r ? ' on' : '') + (!db && r !== 'start' ? ' off' : '')} href=${'#/' + r}><span class="step">${n}</span>${label}${badge ? html`<span class="badge">${badge}</span>` : ''}</a>`;
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
      onDrop=${e => { e.preventDefault(); setOver(false);
        const keys = e.dataTransfer.getData('text/x-cartloop-sample');
        if (keys) { const k = JSON.parse(keys); stageFiles(p => fetchSample(p, k), !!S.stage?.files?.length); } else dropItems(e.dataTransfer.items); }}>
      <div class="hint">⬆ 여기에 끌어다 놓기</div>
      ${st?.busy && html`<div class="frow"><span class="ext">···</span><div><b>${st.busy}</b><small>${st.prog ? `${st.prog[0]} / ${st.prog[1]}` : ''}</small></div><span class="bar" style="width:90px"><i style=${`width:${st.prog ? st.prog[0] / st.prog[1] * 100 : 0}%`}></i></span></div>`}
      ${groups.map(g => html`<div class="frow"><span class=${'ext ' + g.ext}>${g.ext.toUpperCase()}</span><div><b>${g.name}</b><small>${g.sub}</small></div><span class="cnt">${g.cnt} ${g.bad ? '' : html`<i>✓</i>`}</span></div>`)}
      ${!groups.length && !st?.busy && html`<div class="frow" style="border-style:dashed"><span class="ext">?</span><div><b>아직 올린 파일이 없습니다</b><small>수술간호기록지 · 청구 목록 · 재료 마스터 · Case cart 세트 · 기준 변경 공지</small></div><span></span></div>`}
    </div>
    <div class="btnrow">
      <button class="btn" id="load-sample" disabled=${running || !!st?.busy} onClick=${() => stageFiles(fetchSample)}>샘플 파일 올리기</button>
      <button class="btn" disabled=${running || !!st?.busy} onClick=${() => fileRef.current.click()}>파일 더 추가</button>
      <button class="btn pri" id="start-build" disabled=${running || !!st?.busy || (!canStart && !restored)} onClick=${canStart ? startBuild : reanalyze}>${running ? '분석 중…' : '분석 시작'}</button>
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
  if (running) {
    const act = llm.stats.active;
    return html`<${Win} title="처음 설정" sub="2 / 2 분석 중" id="win-result"><div class="wbody">
      <div class="wh">파일 내용과 구조를 <em>읽고 있어요</em></div>
      <div class="underline" style=${`width:${Math.max(6, (cur + 0.5) / order.length * 100)}%;transition:width .4s`}></div>
      <div class="strip busy">에이전트 처리 중 · LLM 동시 호출 ${act}건 <span class="keys" style="margin-left:auto">${Array.from({ length: 20 }, (_, i) => html`<i class=${i < act ? 'on' : ''}></i>`)}</span></div>
      <div class="steps">${STAGES.map(([id, name, desc], i) => {
        if (i > cur) return html`<div class="step wait" key=${id}><span class="ck wait"></span><div><b>${name}</b><small>${desc}</small></div><span></span></div>`;
        const pr = b.prog[id], done = i < cur || b.info[id];
        return html`<div class=${'step ' + (done ? 'done' : 'run')} key=${id}><span class=${'ck ' + (done ? '' : 'run')}>${done ? '✓' : ''}</span>
          <div><b>${name}</b><small>${b.info[id] || desc}</small>${!done && pr ? html`<span class="bar"><i style=${`width:${pr[0] / pr[1] * 100}%`}></i></span>` : ''}</div>
          <span class="num small muted">${done ? (b.took[id] != null ? b.took[id].toFixed(1) + '초' : '') : pr ? `${pr[0]} / ${pr[1]}` : ''}</span></div>`;
      })}</div>
      <div class="wfoot">${((Date.now() - b.t0) / 1000).toFixed(0)}초 지남 · 키 20개로 나눠 동시에 처리</div>
    </div><//>`;
  }
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
    ${!running && sn.process && html`<details><summary class="evlink">처리 과정 보기 (${STAGES.length}단계 · ${sn.sec.toFixed(1)}초)</summary><div class="steps" style="margin-top:8px">${STAGES.map(([id, name]) => html`<div class="step done"><span class="ck">✓</span><div><b>${name}</b><small>${sn.process.info[id] || ''}</small></div><span class="num small muted">${sn.process.took[id] != null ? sn.process.took[id].toFixed(1) + '초' : ''}</span></div>`)}</div></details>`}
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
  // 출력 화면은 "분석 시작"을 누른 뒤에만 보인다. 저장된 DB가 있어도 먼저 띄우지 않는다.
  const showResult = running || (S.db && S.building && !S.resultHidden) || (S.db && S.revealed && !S.resultHidden);
  const restored = S.db && !S.stage && !S.building; // 이 브라우저에 저장돼 있던 DB
  return html`<div class="page">
    <div class="head"><div><h1>파일을 올리면 Loop DB v1이 만들어집니다</h1><p class="sub">병원에 이미 있는 파일을 그대로 올립니다. 파일 이름이나 서식을 맞출 필요가 없고, EHR에는 연결하지 않습니다.</p></div></div>
    ${S.buildError && html`<div class="notice amber"><b>마치지 못했습니다.</b> ${S.buildError}</div>`}
    ${restored && !S.revealed && html`<div class="notice">이 브라우저에 지난번 분석한 Loop DB v${S.db.version}이 저장돼 있습니다. "분석 시작"을 누르면 같은 파일로 처음부터 다시 분석합니다. <button class="linkbtn" id="reveal-saved" style="color:inherit;font-size:inherit" onClick=${() => { S.revealed = true; draw(); }}>다시 분석하지 않고 저장된 결과 보기</button></div>`}
    <div class="pair">
      <div class="col"><${TagHead}>병원에 이미 있는 파일<//><${UploadWin} restored=${restored ? groupsFromDB(S.db) : null} /></div>
      ${showResult ? html`<div class="arrow">→</div>
      <div class="col"><${TagHead} out=${true}>우리 병원 Loop DB v1<//><${ResultWin} /></div>` : html`<div></div><div></div>`}
    </div>
    ${showResult && !running && html`<div class="row"><a class="btn pri" href="#/audit">과거 대조 결과 보기</a><a class="btn" href="#/db">Loop DB 열어 보기</a><a class="btn" href="#/ehr">설치 후 수술 ${Object.keys(S.db.pending).length}건 읽기</a></div>`}
  </div>`;
}
// 저장된 DB만 있고 파일은 메모리에 없을 때: 같은 가상 병원 데이터를 다시 받아 처음부터 분석한다
async function reanalyze() {
  const man = await (await fetch('sample/manifest.json')).json();
  const names = new Set(man.files.map(f => f.name));
  const fromSample = (S.db.files || []).length && S.db.files.every(f => names.has(f.name));
  if (!fromSample) return toast('직접 올린 파일로 만든 DB입니다. 다시 분석하려면 파일을 다시 올려 주세요.');
  if (!confirm('저장된 Loop DB를 지우고 같은 파일로 처음부터 다시 분석할까요? (읽은 수술, 승인한 세트 개정도 처음으로 돌아갑니다)')) return;
  await stageFiles(fetchSample);
  if (S.stage?.files?.length) startBuild();
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
function selectOp(op) { S.ehr = { ...S.ehr, op, result: null, scan: null, dismissed: {}, hl: null, hlRaw: null, entry: { code: '', qty: '' }, busy: false }; draw(); if (op && S.win.cl) doRead(); }
async function doRead() {
  const E = S.ehr, db = S.db, op = E.op;
  if (!op || !db.pending[op] || E.busy) return;
  E.busy = true; draw();
  try {
    const p = db.pending[op];
    // 화면의 글자를 읽는 동안(LLM 추출) 어느 줄을 읽고 있는지 EHR 화면 위에 보여 준다
    const [r] = await Promise.all([readScreen(db, op, { llm, cache, mode: S.mode === 'cache' ? 'cache' : 'live', screenText: p.text }), animateScan(E, p)]);
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
// EHR 화면에서 읽는 줄의 순서: 기록지 머리 정보 → Implants → Drain → 청구 목록
function scanTargets(p) {
  const out = [], r = p.rec;
  if (r) {
    out.push({ k: 'meta', i: 0, text: `수술번호 ${p.op} | 수술일 ${r.date} | 집도의 ${r.surgeon}` });
    out.push({ k: 'meta', i: 1, text: `수술명 ${r.opName}` });
    r.lines.filter(l => l.src === 'material').forEach((l, i) => out.push({ k: 'rec', i, text: `${l.rawName} | ${l.rawSpec || '-'} | ${l.qty}` }));
    r.lines.filter(l => l.src === 'drain').forEach((l, i) => out.push({ k: 'drain', i, text: `${l.rawName} | ${l.rawSpec || '-'} | ${l.qty}` }));
  }
  (p.claim?.lines || []).forEach((l, i) => out.push({ k: 'claim', i, text: `${l.code} | ${l.name} | ${l.spec} | ${l.qty}` }));
  return out;
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function animateScan(E, p) {
  const T = scanTargets(p);
  E.scan = { T, at: -1 };
  for (let n = 0; n < T.length; n++) {
    if (S.ehr !== E) return;
    E.scan.at = n; draw();
    if (T[n].k === 'claim') { const box = document.getElementById('win-ehr-claim-scroll'), row = document.getElementById('crow-' + T[n].i); if (box && row) box.scrollTop = Math.max(0, row.offsetTop - 110); }
    await sleep(T[n].k === 'claim' ? 45 : T[n].k === 'meta' ? 260 : 190);
  }
  E.scan.at = T.length;
  const box = document.getElementById('win-ehr-claim-scroll'); if (box) box.scrollTop = 0;
  draw();
}
// 이 줄이 지금 읽는 줄인지, 이미 읽은 줄인지
function scanCls(k, i) {
  const sc = S.ehr.scan; if (!sc) return '';
  const n = sc.T.findIndex(t => t.k === k && t.i === i);
  return n < 0 ? '' : n === sc.at ? ' scan-now' : n < sc.at ? ' scan-done' : '';
}
const scanningWin = kinds => { const sc = S.ehr.scan; return sc && sc.at >= 0 && sc.at < sc.T.length && kinds.includes(sc.T[sc.at].k) ? ' scanning' : ''; };
const rawMatch = (raw, l) => raw && raw.some(r => r.replace(/\s/g, '') === `${l.rawName} ${l.rawSpec}`.replace(/\s/g, ''));
function showRow(code, raw) { S.ehr.hl = code; S.ehr.hlRaw = raw || null; draw(); setTimeout(() => document.getElementById('cl-' + code)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 30); }
function fillEntry(code, qty, raw) { S.ehr.entry = { code, qty: String(qty) }; S.ehr.hl = null; S.ehr.hlRaw = raw || null; draw(); setTimeout(() => document.getElementById('entry-code')?.focus(), 30); }

// ── 병원 EHR(HIS) 창: CartLoop와 무관한 남의 프로그램이다. 윈도우 위에 떠 있는 병원 전산 화면 모양으로 그린다. ──
const HisWin = ({ title, id, kinds, menu = true, status, onClose, children }) => html`<section class=${'his' + (kinds ? scanningWin(kinds) : '')} id=${id}>
  ${kinds && scanningWin(kinds) ? html`<div class="capture"><${Logo} />CartLoop이 이 화면의 글자를 읽는 중</div>` : ''}
  <div class="his-title"><span class="his-ico">H</span><span>OO병원 통합의료정보시스템 - [${title}]</span><span class="his-ctl"><i>─</i><i>☐</i><i class="x" onClick=${onClose}>✕</i></span></div>
  ${menu && html`<div class="his-menu"><span>파일(F)</span><span>편집(E)</span><span>조회(V)</span><span>서식(O)</span><span>창(W)</span><span>도움말(H)</span></div>
  <div class="his-tool"><button>조회</button><button>저장</button><button>인쇄</button><button>임시저장</button><span class="sep"></span><button>이전 기록</button><button>원무 전송</button></div>`}
  ${children}
  <div class="his-status"><span>${status || '조회 완료'}</span><span>사용자: 수술실 간호사</span><span>HIS-APP07</span><span>가상 데이터</span></div>
</section>`;
function EHRRecordWin({ p, id = 'win-ehr-record', onClose }) {
  const E = S.ehr, r = p.rec;
  if (!r) return html`<${HisWin} title="수술간호기록" id=${id}><div class="his-empty">이 수술은 기록지가 없습니다.</div><//>`;
  const mats = r.lines.filter(l => l.src === 'material'), drains = r.lines.filter(l => l.src === 'drain');
  const dept = /신경/.test(r.dept) ? 'NS' : /정형/.test(r.dept) ? 'OS' : r.dept;
  const f = (label, value, w) => html`<label>${label}<input readonly value=${value || ''} style=${w ? `width:${w}px` : ''} /></label>`;
  return html`<${HisWin} title="수술간호기록" id=${id} onClose=${onClose} kinds=${['meta', 'rec', 'drain']} status=${`수술간호기록 1건 조회 · 재료 ${mats.length}줄`}>
    <div class=${'his-form' + scanCls('meta', 0)}>${f('수술번호', p.op, 92)}${f('수술일', r.date, 84)}${f('등록번호', r.pid, 78)}${f('진료과', r.dept, 74)}${f('집도의', r.surgeon, 62)}${f('수술실', r.room, 62)}</div>
    <div class=${'his-form' + scanCls('meta', 1)}>${f('진단명', r.diagnosis || r.site, 210)}${f('수술명', r.opName, 360)}</div>
    <div class="his-sec">■ Implants</div>
    <table class="his-grid"><thead><tr><th style="width:26px"></th><th>진료과</th><th>부위</th><th>종류</th><th>Manufacturer</th><th>수량</th><th>재료코드</th><th>규격</th></tr></thead><tbody>
      ${mats.map((l, i) => html`<tr class=${(rawMatch(E.hlRaw, l) ? 'hl' : '') + scanCls('rec', i)}><td class="no">${i + 1}</td><td>${dept}</td><td>OP site</td><td>${l.rawName.replace(/\s*\(.*$/, '')}</td><td>${(/\(([^)]*)\)/.exec(l.rawName) || [])[1] || ''}</td><td class="c">${l.qty}</td><td>${l.givenCode}</td><td>${l.rawSpec}</td></tr>`)}
      ${!mats.length && html`<tr><td class="no"></td><td colspan="7" style="color:#888">기록된 치료재료 없음</td></tr>`}
    </tbody></table>
    <div class="his-sec">■ Drain and Catheter</div>
    <table class="his-grid"><thead><tr><th style="width:26px"></th><th>종류</th><th>수량</th><th>규격</th></tr></thead><tbody>
      ${drains.map((l, i) => html`<tr class=${(rawMatch(E.hlRaw, l) ? 'hl' : '') + scanCls('drain', i)}><td class="no">${i + 1}</td><td>${l.rawName}</td><td class="c">${l.qty}</td><td>${l.rawSpec}</td></tr>`)}
      ${!drains.length && html`<tr><td class="no"></td><td colspan="3" style="color:#888">없음</td></tr>`}
    </tbody></table>
  <//>`;
}
function EHRClaimWin({ p, id = 'win-ehr-claim', readonly, onClose }) {
  const E = S.ehr, db = S.db;
  const ec = E.entry.code?.trim().toUpperCase();
  const total = p.claim.lines.reduce((n, l) => n + l.amount, 0);
  return html`<${HisWin} title="수술 재료 청구 목록 (원무 전송 전)" id=${id} onClose=${onClose} kinds=${readonly ? null : ['claim']} menu=${false} status=${`${p.claim.lines.length}줄 · 합계 ${total.toLocaleString()}원`}>
    <div class="his-scroll" id=${id + '-scroll'}><table class="his-grid"><thead><tr><th style="width:30px">순번</th><th>재료코드</th><th>재료명</th><th>규격</th><th>수량</th><th>단가</th><th>급여구분</th><th></th></tr></thead><tbody>
      ${p.claim.lines.map((l, i) => html`<tr class=${(E.hl === l.code ? 'hl' : '') + (readonly ? '' : scanCls('claim', i))} id=${readonly ? null : 'cl-' + l.code}><td class="no" id=${readonly ? null : 'crow-' + i}>${i + 1}</td><td>${l.code}</td><td>${l.name}</td><td>${l.spec}</td>
        <td class="c"><input type="number" min="0" style="width:44px" value=${l.qty} disabled=${readonly} onChange=${e => claimQty(i, e.target.value)} /></td><td class="r">${l.price.toLocaleString()}</td><td>${l.benefit}</td>
        <td class="c"><button disabled=${readonly} onClick=${() => claimDel(i)}>삭제</button></td></tr>`)}
    </tbody></table></div>
    <div class=${'his-entry' + (E.entry.code ? ' hl' : '')}><b>재료 추가</b>
      <label>재료코드<input id=${readonly ? null : 'entry-code'} type="text" style="width:96px" value=${E.entry.code} disabled=${readonly} onInput=${e => { E.entry.code = e.target.value; draw(); }} /></label>
      <label>수량<input id=${readonly ? null : 'entry-qty'} type="number" min="1" style="width:48px" value=${E.entry.qty} disabled=${readonly} onInput=${e => { E.entry.qty = e.target.value; draw(); }} /></label>
      <button disabled=${readonly} onClick=${claimAdd}>추가</button>
      <span style="color:#555">${db.master[ec] ? `${db.master[ec].name} ${db.master[ec].spec}` : ''}</span></div>
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
  if (!r) {
    const sc = E.scan, T = sc?.T || [], at = sc ? Math.max(0, sc.at) : 0;
    const seen = T.slice(0, at + 1);
    const nRec = T.filter(t => t.k === 'rec' || t.k === 'drain').length, nCl = T.filter(t => t.k === 'claim').length;
    const dRec = seen.filter(t => t.k === 'rec' || t.k === 'drain').length, dCl = seen.filter(t => t.k === 'claim').length;
    const where = !sc ? '' : (T[Math.min(at, T.length - 1)]?.k === 'claim' ? '청구 목록 화면' : '수술간호기록 화면');
    return html`<${Win} key="reading" title="청구 도우미" sub="청구 대조 알림" id=${id}><div class="wbody">
      <div class=${'strip' + (E.busy ? ' busy' : '')}>${E.busy ? `EHR 화면 인식 중 — ${where}의 글자를 읽고 있어요` : 'EHR 화면 인식 대기'}</div>
      <div class="hero"><div><div class="wh">화면을 <em>읽고 있어요</em></div><p>기록 ${dRec} / ${nRec}줄 · 청구 ${dCl} / ${nCl}줄<br />화면에 보이는 글자만 읽습니다. EHR DB에는 접근하지 않습니다.</p></div><img src="img/mascot.png" alt="" /></div>
      ${E.busy && html`<div class="bar"><i style=${`width:${T.length ? (at + 1) / T.length * 100 : 0}%`}></i></div>
      <div class="readlog"><b>화면에서 읽은 글자</b>${seen.slice(-7).map((t, i, arr) => html`<div class=${i === arr.length - 1 ? 'now' : ''}>${t.text}</div>`)}</div>
      <div class="wfoot">${sc && sc.at >= T.length ? '읽은 글자에서 재료 · 규격 · 수량을 뽑아 대조하는 중…' : '읽는 대로 별칭 사전으로 재료코드에 잇습니다'}</div>`}
      ${!E.busy && html`<button class="btn pri" id="read-screen" onClick=${doRead}>이 화면 읽기</button>`}</div><//>`;
  }
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
    ${actions && html`<button class="linkbtn" style="color:var(--teal-ink);justify-self:start" onClick=${() => { const op = E.op; selectOp(op); }}>↻ 화면 다시 읽기</button>
    <details><summary class="evlink">화면에서 읽은 텍스트 보기 (${r.via === 'llm' ? 'LLM으로 읽음' : '저장 결과'})</summary><pre class="mono" style="white-space:pre-wrap;max-height:200px;overflow:auto;margin:6px 0 0;font-size:11.5px">${p.text}</pre></details>`}
  </div><//>`;
}
function EHRScene() {
  const db = S.db, E = S.ehr, cl = S.win.cl && !!db;
  const list = db ? pendingList() : [];
  const p = db && E.op ? db.pending[E.op] : null;
  useEffect(() => {
    if (!db) return;
    if (!S.ehr.op && list.length) selectOp(list[0].op);
    else if (cl && S.ehr.op && db.pending[S.ehr.op] && !S.ehr.result && !S.ehr.busy) doRead(); // CartLoop를 켜면 지금 화면부터 읽는다
  }, [E.op, cl]);
  const doneN = db ? Object.values(db.records).filter(r => r.date >= db.installDate).length : 0;
  const x = () => closeApp('his');
  return html`<div class=${'scene' + (cl ? '' : ' nocl')}>
    <${HisWin} title="수술 스케줄" id="win-his-list" menu=${false} onClose=${x} status=${`대기 ${list.length}건 · 기록 완료 ${doneN}건`}>
      <div class="his-scroll tall"><table class="his-grid pick"><thead><tr><th>수술번호</th><th>일자</th><th>집도의</th><th>수술명</th></tr></thead><tbody>
        ${list.map(x => html`<tr class=${x.op === E.op ? 'sel' : ''} onClick=${() => selectOp(x.op)}><td>${x.op}</td><td class="c">${x.date.slice(5)}</td><td class="c">${x.rec?.surgeon || ''}</td><td>${x.rec ? (x.rec.opName || '').split('(')[0].split(':')[0].trim().slice(0, 16) : '기록 없음'}</td></tr>`)}
        ${!list.length && html`<tr><td colspan="4" style="color:#777;text-align:center;height:60px">${db ? '대기 중인 수술이 없습니다' : '조회된 수술이 없습니다'}</td></tr>`}
      </tbody></table></div>
    <//>
    <div class="stack" id="ehr-pair">${p && p.claim ? html`<${EHRRecordWin} p=${p} onClose=${x} /><${EHRClaimWin} p=${p} onClose=${x} />` : html`<${HisWin} title="수술간호기록" id="win-ehr-record" onClose=${x}><div class="his-empty">수술 스케줄에서 수술을 선택하십시오.</div><//>`}</div>
    ${cl && html`<section class="appwin compact" id="cl-compact">
      <div class="apptitle"><${Logo} /><b>CartLoop</b><span>청구 도우미</span><span class="his-ctl"><i>─</i><i>☐</i><i class="x" onClick=${() => closeApp('cl')}>✕</i></span></div>
      <div class="cltool"><button class="mini" onClick=${() => { S.focus = 'cl'; draw(); }}>☰ CartLoop 전체 창 열기</button>
        ${S.batch ? html`<span class="small num" style="margin-left:auto">읽는 중 ${S.batch.d} / ${S.batch.n}</span>` : list.length ? html`<button class="mini" style="margin-left:auto" onClick=${() => runBatch()}>남은 ${list.length}건 모두 읽기</button>` : ''}</div>
      ${p && p.claim ? html`<${AssistWin} p=${p} />` : html`<div class="wbody"><div class="hero"><div><div class="wh">${list.length ? html`EHR 화면을 <em>기다리고 있어요</em>` : html`설치 후 수술을 <em>모두 읽었어요</em>`}</div>
        <p>${list.length ? 'EHR에서 수술을 열면 화면의 글자를 읽어 청구 목록과 대조합니다.' : `수술 ${doneN}건을 Loop DB v${db.version}에 반영했습니다.`}</p></div><img src="img/mascot.png" alt="" /></div>
        ${!list.length && html`<div class="btnrow"><a class="btn" href="#/db">갱신 내역</a><a class="btn" href="#/sets">세트 개정안</a><a class="btn pri" href="#/validate">정답지 채점</a></div>`}</div>`}
    </section>`}
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

// ───────────────────────── 앱 ─────────────────────────
const ROUTE_TITLE = { start: '처음 설정 · 파일 올리기', db: 'Loop DB', audit: '과거 대조', sets: '세트 개정안', ask: '우리 병원 재료 묻기', validate: '정답지 채점' };
function Clock() {
  const [now, setNow] = useState(new Date());
  useEffect(() => { const t = setInterval(() => setNow(new Date()), 30000); return () => clearInterval(t); }, []);
  return html`<span class="tray num"><span>한</span><span style="text-align:right">${now.toLocaleTimeString('ko-KR', { hour: 'numeric', minute: '2-digit' })}<br />${now.toLocaleDateString('ko-KR')}</span></span>`;
}
function Taskbar({ view }) {
  const btn = (app, label, icon, on) => html`<button class=${'tbapp' + (S.win[app] ? ' run' : '') + (on ? ' on' : '')} onClick=${() => openApp(app)} title=${label}>${icon}${label}</button>`;
  return html`<div class="taskbar"><span></span>
    <span class="tbicons"><span class="winlogo"><i></i><i></i><i></i><i></i></span><span class="tbsearch">🔍 검색</span>
      ${btn('data', '파일 탐색기', html`<span>📁</span>`, S.win.data)}
      ${btn('his', 'OO병원 HIS', html`<span class="his-ico">H</span>`, view === 'his')}
      ${btn('cl', 'CartLoop', html`<span class="tblogo"><${Logo} /></span>`, view === 'cl' || (view === 'his' && S.win.cl))}</span>
    <${Clock} /></div>`;
}
function DeskIcons() {
  const icon = (label, glyph, cls, app) => html`<button class="dicon" onClick=${app ? () => openApp(app) : null} onDblClick=${app ? () => openApp(app) : null}><span class=${'dglyph ' + cls}>${glyph}</span><span>${label}</span></button>`;
  return html`<div class="dicons">
    ${icon('내 PC', '🖥', '')}
    ${icon('OO병원 HIS', 'H', 'his', 'his')}
    ${icon('CartLoop', html`<${Logo} />`, 'cl', 'cl')}
    ${icon('가상 데이터 셋', '📁', '', 'data')}
    ${icon('휴지통', '🗑', '')}
  </div>`;
}
// 파일 탐색기: 가상 데이터 셋 폴더. 선택한 항목을 CartLoop 창으로 끌어다 놓을 수 있다.
function Explorer() {
  const ex = S.explorer;
  const items = ex?.items || [], sel = ex?.sel || {};
  const nSel = items.filter(i => sel[i.key]).length;
  const drag = e => { const keys = items.filter(i => sel[i.key]).map(i => i.key); if (!keys.length) { e.preventDefault(); return; } e.dataTransfer.setData('text/x-cartloop-sample', JSON.stringify(keys)); e.dataTransfer.effectAllowed = 'copy'; };
  return html`<section class="explorer" id="win-explorer">
    <div class="his-title"><span>📁</span><span>가상 데이터 셋</span><span class="his-ctl"><i>─</i><i>☐</i><i class="x" onClick=${() => closeApp('data')}>✕</i></span></div>
    <div class="ex-addr"><span>←</span><span>→</span><span>↑</span><span class="ex-path">내 PC › 문서 › OO병원 › 가상 데이터 셋</span></div>
    <table class="ex-list"><thead><tr><th>이름</th><th>유형</th><th>크기</th></tr></thead><tbody>
      ${items.map(i => html`<tr class=${sel[i.key] ? 'sel' : ''} draggable="true" onDragStart=${drag} onClick=${e => { if (e.ctrlKey || e.metaKey) sel[i.key] = !sel[i.key]; else { items.forEach(x => sel[x.key] = false); sel[i.key] = true; } draw(); }}>
        <td><span class="ex-ico">${i.folder ? '📁' : i.name.endsWith('.csv') ? '📊' : '📄'}</span>${i.name}</td><td>${i.type}</td><td>${i.size}</td></tr>`)}
      ${!ex && html`<tr><td colspan="3" style="color:#777">불러오는 중…</td></tr>`}
    </tbody></table>
    <div class="ex-status"><span>${items.length}개 항목</span><span>${nSel}개 항목 선택함</span><button onClick=${() => { items.forEach(x => sel[x.key] = true); draw(); }}>모두 선택</button></div>
  </section>`;
}
// 웹을 열면 가상 윈도우 바탕화면만 보인다. 아이콘을 눌러 프로그램(CartLoop · OO병원 HIS · 가상 데이터 셋 폴더)을 켠다.
function App() {
  const pages = { start: StartPage, db: DBPage, audit: AuditPage, sets: SetsPage, ask: AskPage, validate: ValidatePage };
  let route = pages[S.route] ? S.route : S.lastRoute;
  if (!S.db || !pages[route]) route = 'start';
  const Page = pages[route];
  // 지금 앞에 보이는 것: HIS 장면(옆에 CartLoop 도우미) 또는 CartLoop 전체 창 또는 빈 바탕화면
  const view = S.win.his && (S.focus === 'his' || !S.win.cl) ? 'his' : S.win.cl ? 'cl' : 'none';
  return html`<div class="desktop">
    <div class="deskarea">
      <${DeskIcons} />
      ${view === 'his' && html`<${EHRScene} />`}
      ${view === 'cl' && html`<section class="appwin" id="cl-main">
        <div class="apptitle"><${Logo} /><b>CartLoop</b><span>${ROUTE_TITLE[route]}</span><span class="his-ctl"><i>─</i><i>☐</i><i class="x" onClick=${() => closeApp('cl')}>✕</i></span></div>
        <div class="shell"><${Side} /><main class="main"><${Page} /></main></div>
      </section>`}
      ${S.win.data && html`<${Explorer} />`}
    </div>
    <${Taskbar} view=${view} />
    ${S.toast && html`<div class="toast" role="status">${S.toast}</div>`}
  </div>`;
}

(async () => {
  const saved = await store.load('state');
  if (saved?.db) { S.db = saved.db; S.snap = saved.snap; S.chat = saved.chat || []; }
  const qs = new URLSearchParams(location.search);
  if (qs.get('cache') === '1') S.mode = 'cache';
  if (S.route !== 'ehr') S.lastRoute = S.route;
  if (qs.get('demo') === '1' || qs.get('open') === 'cl') S.win.cl = true;
  draw();
  try { S.health = await (await fetch('/api/llm')).json(); draw(); } catch { /* 연결 정보 없이도 화면은 뜬다 */ }
  window.__cartloop = { S, draw, runBatch: () => runBatch(true), runValidation, ask, go, selectOp, startBuild, openApp, closeApp, stageSample: () => stageFiles(fetchSample) };
  // 시연용 자동 실행: ?demo=1 이면 가상 병원 데이터를 올리고 바로 분석한다
  if (qs.get('demo') === '1' && !S.db) { await stageFiles(fetchSample); if (qs.get('stay') !== '1') startBuild(); }
})();
