// CartLoop 화면. 모든 처리는 브라우저에서 하고, LLM 호출만 /api/llm 을 거친다.
import { html, render, useState, useEffect, useRef } from './vendor/preact-htm.js';
import { unzipSync } from './vendor/fflate.js';
import { createLLM } from './lib/llm.js';
import { buildFromFiles, STAGES, readScreen, commitOp, runAllPending } from './lib/pipeline.js';
import { KIND_LABEL } from './lib/classify.js';
import { summary } from './lib/loopdb.js';
import { auditOp, auditAll, ALERT_LABEL, RECORD_TYPES, RULE_TYPES } from './lib/audit.js';
import { proposeAll, proposeForSet, approve, hold, setPolicy } from './lib/sets.js';
import { answerQuestion } from './lib/agents.js';
import { buildContext } from './lib/qa.js';
import { buildKB } from './lib/kb.js';
import { score, fmtPct } from './lib/score.js';
import * as store from './lib/store.js';

const won = n => Math.round(Number(n) || 0).toLocaleString('ko-KR') + '원';
const clone = o => JSON.parse(JSON.stringify(o));
const llm = createLLM({ endpoint: '/api/llm', concurrency: 20 });

const S = {
  route: location.hash.replace(/^#\/?/, '') || 'start',
  db: null, snap: null, chat: [],
  mode: 'live', building: null, buildError: null,
  toast: null, health: null,
  ehr: { op: null, busy: false, result: null, dismissed: {}, hl: null, entry: { code: '', qty: '' }, filter: 'todo' },
  dbTab: 'alias', kbFile: 'README.md', aliasQ: '', auditType: 'all', asking: false, batch: null, valid: null, validBusy: false,
};
let pdfjs = null;
const cacheStore = {};
const cache = { get: k => cacheStore[k], set: (k, v) => { cacheStore[k] = v; } };

const root = document.getElementById('app');
function draw() { render(html`<${App} />`, root); }
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

// ───────────────────────── 구축 ─────────────────────────
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
async function startBuild(getFiles) {
  S.buildError = null;
  S.building = { stage: 'fetch', prog: {}, kinds: {}, t0: Date.now(), nFiles: 0 };
  draw();
  try {
    await loadSampleCache();
    const files = await getFiles((d, n) => { S.building.prog.fetch = [d, n]; draw(); });
    S.building.nFiles = files.length;
    const before = { ...llm.stats, byKey: { ...llm.stats.byKey } };
    let lastDraw = 0;
    const res = await buildFromFiles(files, {
      llm, deps: await deps(), cache, mode: S.mode,
      onStage: s => { if (s !== 'done') { S.building.stage = s; draw(); } },
      onProgress: (s, d, n) => { S.building.prog[s] = [d, n]; if (Date.now() - lastDraw > 120 || d === n) { lastDraw = Date.now(); draw(); } },
      onFile: f => { S.building.kinds[f.kind] = (S.building.kinds[f.kind] || 0) + 1; },
    });
    const keys = Object.keys(llm.stats.byKey).filter(k => (llm.stats.byKey[k] || 0) > (before.byKey[k] || 0)).length;
    S.db = res.db;
    S.snap = {
      report: res.report, proposalsV1: proposeAll(res.db), setsOriginal: clone(res.db.sets), streamAlerts: {}, v1: res.summary,
      sec: (Date.now() - S.building.t0) / 1000, mode: S.mode,
      llm: { calls: llm.stats.calls - before.calls, inTok: llm.stats.inTok - before.inTok, outTok: llm.stats.outTok - before.outTok, keys, peak: llm.stats.peak },
    };
    S.chat = []; S.valid = null; S.ehr = { ...S.ehr, op: null, result: null, dismissed: {} };
    S.building.stage = 'done';
    persist(); draw();
  } catch (e) {
    console.error(e);
    S.buildError = String(e?.message || e); S.building = null; draw();
  }
}
async function pickFiles(fileList) {
  const list = [...fileList].filter(f => /\.(csv|tsv|xlsx|pdf|docx|txt)$/i.test(f.name));
  if (!list.length) return toast('읽을 수 있는 파일이 없습니다. CSV · XLSX · PDF · DOCX · TXT 를 올려 주세요.');
  startBuild(async onProgress => {
    const out = []; let d = 0;
    for (const f of list) { out.push({ name: f.webkitRelativePath || f.name, buf: new Uint8Array(await f.arrayBuffer()) }); onProgress(++d, list.length); }
    return out;
  });
}
async function dropItems(items) {
  // 폴더째 끌어다 놓은 경우 안의 파일을 모두 모은다
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
  pickFiles(files);
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
const Logo = () => html`<svg viewBox="0 0 64 40"><path d="M6 20c9-17 17-17 26 0s17 17 26 0" fill="none" stroke="#f2a93b" stroke-width="6" stroke-linecap="round"/><path d="M6 20c9 17 17 17 26 0s17-17 26 0" fill="none" stroke="#1d9c91" stroke-width="6" stroke-linecap="round"/></svg>`;
const TYPE_TONE = { missing: 'red', qty_mismatch: 'amber', spec_mismatch: 'amber', unrecorded: 'blue', non_billable: 'red', bundled: 'red', bundle_dup: 'amber', qty_limit: 'amber', price: 'blue', discontinued: 'blue', duplicate: 'blue', unmapped: '' };
const Pill = ({ tone = '', children }) => html`<span class=${'pill ' + tone}>${children}</span>`;
const Stat = ({ k, v, unit, d, hot }) => html`<div class=${'stat' + (hot ? ' hot' : '')}><div class="k">${k}</div><div class="v">${v}${unit && html`<small>${unit}</small>`}</div>${d && html`<div class="d">${d}</div>`}</div>`;

function Side() {
  const db = S.db;
  const nPast = db ? pastAlerts().filter(a => !db.dismissed[a.id]).length : 0;
  const nPend = db ? Object.keys(db.pending).length : 0;
  const nProp = db ? openProposals().length : 0;
  const item = (r, n, label, badge) => html`<a class=${'nav' + (S.route === r ? ' on' : '') + (!db && r !== 'start' ? ' off' : '')} href=${'#/' + r}><span class="step">${n}</span>${label}${badge ? html`<span class="badge">${badge}</span>` : ''}</a>`;
  return html`<aside class="side">
    <div class="brand"><${Logo} /><div><b>CartLoop</b><span>우리 병원을 알아가는 청구 도우미</span></div></div>
    ${item('start', 1, '파일 올리기')}
    ${item('db', 2, 'Loop DB')}
    ${item('audit', 3, '과거 대조', nPast)}
    <div class="navsep">설치 후</div>
    ${item('ehr', 4, '청구 도우미', nPend)}
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
  await store.remove('state'); S.db = null; S.snap = null; S.chat = []; S.building = null; S.valid = null; go('start'); draw();
}

// ───────────────────────── 1. 파일 올리기 ─────────────────────────
function StartPage() {
  const [over, setOver] = useState(false);
  const fileRef = useRef(), dirRef = useRef();
  useEffect(() => { if (dirRef.current) dirRef.current.setAttribute('webkitdirectory', ''); }, []);
  const b = S.building, db = S.db;
  const running = b && b.stage !== 'done';
  return html`<div class="page">
    <div class="head"><div><h1>병원에 이미 있는 파일을 그대로 올립니다</h1>
      <p class="sub">수술간호기록지, 청구 목록, 재료 마스터, Case cart 세트, 기준 변경 공지. 파일 이름이나 서식을 맞출 필요가 없습니다. EHR에는 연결하지 않습니다.</p></div></div>

    ${!running && html`<div class=${'drop' + (over ? ' over' : '')}
        onDragOver=${e => { e.preventDefault(); setOver(true); }} onDragLeave=${() => setOver(false)}
        onDrop=${e => { e.preventDefault(); setOver(false); dropItems(e.dataTransfer.items); }}>
      <div class="kinds">${['수술간호기록지 PDF · DOCX', '청구 목록 CSV · XLSX', '재료 마스터', '세트 목록', '공지 TXT'].map(k => html`<${Pill}>${k}<//>`)}</div>
      <div><b>파일이나 폴더를 여기에 끌어다 놓으세요</b></div>
      <div class="row" style="justify-content:center">
        <button class="btn" onClick=${() => fileRef.current.click()}>파일 고르기</button>
        <button class="btn" onClick=${() => dirRef.current.click()}>폴더 고르기</button>
        <button class="btn pri" onClick=${() => startBuild(fetchSample)}>가상 병원(OO병원) 데이터로 시작</button>
      </div>
      <label class="small muted row" style="gap:6px;justify-content:center"><input id="mode-cache" type="checkbox" checked=${S.mode === 'cache'} onChange=${e => { S.mode = e.target.checked ? 'cache' : 'live'; draw(); }} />
        저장해 둔 추출 결과 사용 (LLM 호출 없이 빠르게. 끄면 기록지를 지금 LLM으로 읽습니다)</label>
      <input ref=${fileRef} id="pick-files" type="file" multiple style="display:none" onChange=${e => pickFiles(e.target.files)} />
      <input ref=${dirRef} id="pick-dir" type="file" multiple style="display:none" onChange=${e => pickFiles(e.target.files)} />
      ${S.health && html`<div class="small muted">LLM 연결: OpenRouter 키 ${S.health.keys}개 · 동시에 ${llm.concurrency}건까지 처리</div>`}
    </div>`}
    ${S.buildError && html`<div class="notice amber"><b>구축을 마치지 못했습니다.</b> ${S.buildError}</div>`}

    ${b && html`<${BuildProgress} b=${b} />`}
    ${db && !running && html`<${BuildResult} />`}
  </div>`;
}
function BuildProgress({ b }) {
  const order = ['fetch', ...STAGES.map(s => s[0])];
  const cur = b.stage === 'done' ? order.length : order.indexOf(b.stage);
  const rows = [['fetch', '파일 받기', '올린 파일을 브라우저로 읽기'], ...STAGES];
  const active = llm.stats.active;
  return html`<div class="card">
    <div class="row" style="margin-bottom:6px"><h2>${b.stage === 'done' ? `Loop DB v1 구축 완료 · ${S.snap.sec.toFixed(1)}초` : '에이전트가 파일을 읽고 있습니다'}</h2>
      ${b.stage !== 'done' && html`<span class="muted small">LLM 동시 호출 ${active}건</span><span class="keys">${Array.from({ length: 20 }, (_, i) => html`<i class=${i < active ? 'on' : ''}></i>`)}</span>`}</div>
    <div class="stages">${rows.map(([id, name, desc], i) => {
      const st = i < cur ? 'done' : i === cur ? 'run' : '';
      const p = b.prog[id];
      return html`<div class=${'stage ' + st}><span class="dot">${st === 'done' ? '✓' : ''}</span><b>${name}</b><span class="muted small">${desc}</span>
        <span class="row small num" style="gap:8px">${p ? html`<span class="bar" style="width:140px"><i style=${`width:${(p[0] / p[1] * 100) || 0}%`}></i></span>${p[0]} / ${p[1]}` : ''}</span></div>`;
    })}</div>
  </div>`;
}
function BuildResult() {
  const db = S.db, sn = S.snap, v1 = sn.v1;
  const alerts = pastAlerts();
  const missed = alerts.filter(a => a.amount > 0).reduce((s, a) => s + a.amount, 0);
  const kinds = {};
  for (const f of sn.report.files) (kinds[f.kind] ||= []).push(f);
  const ex = sn.report.extract;
  return html`
    <div class="grid g4">
      <${Stat} k="수술 (청구 기준)" v=${v1.ops.toLocaleString()} unit="건" d=${`청구 ${v1.claimLines.toLocaleString()}줄 · 기록지 ${v1.records}건`} />
      <${Stat} k="현장 표기 → 재료코드" v=${`${v1.notations} → ${v1.codes}`} d=${`호칭 ${v1.aliasNames}종을 품목군에 연결 · 기록 줄 ${v1.resolvedLines}/${v1.recordLines} 연결`} />
      <${Stat} k="세트 · 공지 규칙" v=${`${v1.sets} · ${v1.rules}`} d="집도의 · 술식별 세트와 시행일이 있는 규칙" />
      <${Stat} hot=${true} k="만들자마자 과거 대조" v=${alerts.length} unit="건 확인 필요" d=${`빠진 금액 추정 ${won(missed)} (가상 금액)`} />
    </div>
    <div class="row">
      <a class="btn pri" href="#/audit">과거 대조 결과 보기</a>
      <a class="btn" href="#/db">Loop DB 열어 보기</a>
      <a class="btn" href="#/ehr">설치 후 수술 ${Object.keys(db.pending).length}건 읽기</a>
    </div>
    <div class="grid g2">
      <div class="card flush"><div style="padding:14px 18px 8px"><h2>파일 판별 결과</h2><p class="small muted">파일 이름이 아니라 머리글과 내용으로 판별했습니다.</p></div>
        <div class="tablewrap"><table class="t"><thead><tr><th>종류</th><th class="r">파일</th><th>판별 근거</th></tr></thead><tbody>
          ${Object.entries(kinds).map(([k, fs]) => html`<tr><td><${Pill} tone=${k === 'unknown' ? 'red' : 'teal'}>${KIND_LABEL[k] || k}<//></td><td class="r">${fs.length}</td>
            <td class="small">${fs.length === 1 ? html`<span class="mono">${fs[0].name.split('/').pop()}</span> · ` : ''}${fs[0].why}${fs[0].rows ? ` · ${fs[0].rows.toLocaleString()}행` : ''}</td></tr>`)}
        </tbody></table></div></div>
      <div class="card"><h2>에이전트 처리 내역</h2>
        <table class="t"><tbody>
          <tr><td>기록지 추출</td><td class="r">${ex.llm + ex.cache}건${ex.failed ? ` · 실패 ${ex.failed}` : ''}</td><td class="small muted">${ex.llm ? `LLM 실시간 ${ex.llm}건` : ''}${ex.cache ? ` 저장 결과 ${ex.cache}건` : ''}</td></tr>
          <tr><td>별칭 통합</td><td class="r">${sn.report.alias.learned}종</td><td class="small muted">코드가 적힌 줄에서 ${sn.report.alias.fromCode}종 · LLM 제안 ${sn.report.alias.proposed}종 · 청구 기록으로 교정 ${sn.report.alias.corrected}종</td></tr>
          <tr><td>공지 → 규칙</td><td class="r">${db.rules.length}건</td><td class="small muted">${sn.report.rulesVia === 'llm' ? 'LLM이 공지문을 읽어 규칙으로' : sn.report.rulesVia === 'cache' ? '저장 결과' : sn.report.rulesVia}</td></tr>
          <tr><td>LLM 호출</td><td class="r">${sn.llm.calls}회</td><td class="small muted">키 ${sn.llm.keys}개로 나눠 동시에 · 입력 ${(sn.llm.inTok / 1000).toFixed(0)}k · 출력 ${(sn.llm.outTok / 1000).toFixed(0)}k 토큰</td></tr>
          <tr><td>걸린 시간</td><td class="r">${sn.sec.toFixed(1)}초</td><td class="small muted">추출 ${(sn.report.ms.extract / 1000).toFixed(1)}초 · 별칭 ${(sn.report.ms.alias / 1000).toFixed(1)}초 · 대조 ${(sn.report.ms.audit / 1000).toFixed(2)}초</td></tr>
        </tbody></table>
      </div>
    </div>`;
}

// ───────────────────────── 2. Loop DB ─────────────────────────
const SRC_LABEL = { code: ['코드가 적힌 줄', 'teal'], 'llm+data': ['LLM 제안 · 청구로 확인', 'teal'], 'llm→data': ['청구 기록으로 교정', 'amber'], data: ['청구 기록에서 추정', 'amber'], llm: ['LLM 제안', 'blue'], 'llm?': ['LLM 제안 · 확인 필요', 'red'], none: ['미연결', 'red'] };
function DBPage() {
  const db = S.db, s = summary(db);
  const tabs = [['alias', '별칭 사전', s.aliasNames], ['pref', '집도의 · 세트', s.sets], ['rules', '공지 규칙', s.rules], ['kb', 'KB 파일'], ['log', '버전 이력', db.changelog.length]];
  return html`<div class="page">
    <div class="head"><div><h1>우리 병원 Loop DB <span class="muted">v${db.version}</span></h1>
      <p class="sub">올린 파일과 읽은 수술에서만 만든 병원 고유 지식입니다. 사람이 입력한 것은 없습니다.</p></div></div>
    <div class="grid g4">
      <${Stat} k="수술기록" v=${s.records} unit="건" d=${`청구 ${s.ops.toLocaleString()}건 · ${s.claimLines.toLocaleString()}줄`} />
      <${Stat} k="현장 표기" v=${s.notations} unit="가지" d=${`호칭 ${s.aliasNames}종`} />
      <${Stat} k="연결된 재료코드" v=${s.codes} unit="개" d=${`재료 마스터 ${s.masterItems}품목 중`} />
      <${Stat} k="아직 읽지 않은 수술" v=${s.pending} unit="건" d="청구 도우미에서 한 건씩 읽습니다" />
    </div>
    <div class="card flush">
      <div class="tabs" style="padding:0 10px">${tabs.map(([id, label, n]) => html`<button class=${'tab' + (S.dbTab === id ? ' on' : '')} onClick=${() => { S.dbTab = id; draw(); }}>${label}${n != null ? html`<span class="n">${n}</span>` : ''}</button>`)}</div>
      ${S.dbTab === 'alias' && html`<${AliasTab} />`}
      ${S.dbTab === 'pref' && html`<${PrefTab} />`}
      ${S.dbTab === 'rules' && html`<${RulesTab} />`}
      ${S.dbTab === 'kb' && html`<${KBTab} />`}
      ${S.dbTab === 'log' && html`<${LogTab} />`}
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
    <div class="row" style="padding:12px 16px"><input id="alias-q" type="text" placeholder="호칭이나 품목으로 찾기 (예: 케이지, screw)" style="width:320px" value=${S.aliasQ} onInput=${e => { S.aliasQ = e.target.value; draw(); }} />
      <span class="small muted">같은 재료의 다른 이름을 하나로 묶었습니다. LLM이 제안하고, 같은 수술의 청구 목록이 확인합니다.</span></div>
    <div class="tablewrap" style="max-height:560px;overflow-y:auto"><table class="t"><thead><tr><th>병원 품목군 (재료 마스터)</th><th>현장에서 부르는 이름</th><th class="r">사용</th><th>연결 근거</th></tr></thead><tbody>
      ${fams.map(([f, al]) => { al.sort((a, b) => b.n - a.n); const src = {}; al.forEach(a => src[a.source] = (src[a.source] || 0) + 1);
        return html`<tr><td style="min-width:240px"><b>${f}</b><div class="small muted">${db.families[f] ? `${db.families[f].maker || ''} · ${db.families[f].codes.length}규격 · ${db.families[f].benefits.join('/')}` : ''}</div></td>
          <td>${al.map(a => html`<span class="code" style="margin:0 4px 4px 0;display:inline-block" title=${a.examples.join(' / ')}>${a.examples[0]?.replace(/\s*\(.*$/, '') || a.key} <span class="muted">${a.n}</span></span>`)}</td>
          <td class="r">${al.reduce((s, a) => s + a.n, 0)}</td>
          <td>${Object.entries(src).map(([k, n]) => html`<${Pill} tone=${(SRC_LABEL[k] || [k, ''])[1]}>${(SRC_LABEL[k] || [k])[0]} ${n}<//> `)}</td></tr>`; })}
    </tbody></table></div></div>`;
}
function PrefTab() {
  const db = S.db, M = db.master;
  const sets = Object.values(db.sets);
  return html`<div class="tablewrap" style="max-height:600px;overflow-y:auto"><table class="t"><thead><tr><th>세트</th><th>집도의 · 술식</th><th class="r">수술</th><th>세트 임플란트</th><th>최근 10건에서 실제로 쓴 임플란트 (기록지)</th></tr></thead><tbody>
    ${sets.map(s => {
      const recs = Object.values(db.records).filter(r => r.setCode === s.code).sort((a, b) => (a.date + a.op).localeCompare(b.date + b.op));
      const last = recs.slice(-10); const use = {};
      for (const r of last) { const seen = {}; r.lines.forEach(l => { if (l.code && l.src === 'material') seen[l.code] = (seen[l.code] || 0) + l.qty; }); Object.entries(seen).forEach(([c, q]) => (use[c] ||= []).push(q)); }
      return html`<tr><td><span class="code">${s.code}</span><div class="small muted">${s.version} · ${s.revised}</div></td><td><b>${s.surgeon}</b> ${s.procedure} ${s.level}</td><td class="r">${recs.length}</td>
        <td class="small">${s.items.filter(i => /임플란트/.test(i.kind)).map(i => html`<div>${i.code === 'TRAY' ? html`<${Pill}>트레이<//> ` : ''}${i.name.replace(/LNK SPINAL FIXATION SYSTEM /, '')} ${i.spec} × ${i.qty}</div>`)}</td>
        <td class="small">${Object.entries(use).sort((a, b) => b[1].length - a[1].length).slice(0, 7).map(([c, qs]) => html`<div>${M[c].name.replace(/LNK SPINAL FIXATION SYSTEM /, '')} ${M[c].spec} <span class="muted">· ${last.length}건 중 ${qs.length}건 · 보통 ${mode(qs)}개</span></div>`)}</td></tr>`; })}
  </tbody></table></div>`;
}
const mode = a => { const c = {}; let b = a[0]; a.forEach(v => { c[v] = (c[v] || 0) + 1; if (c[v] > c[b]) b = v; }); return b; };
const RULE_KO = { non_billable: '산정 불가', bundled: '정액 포함', qty_limit: '수량 한도', price_change: '단가 변경', discontinued: '사용 중지', set_policy: '세트 개정 기준', info: '안내' };
function RulesTab() {
  const db = S.db;
  if (!db.rules.length) return html`<div class="empty">공지 파일이 없거나 규칙을 읽지 못했습니다.</div>`;
  return html`<div class="tablewrap"><table class="t"><thead><tr><th>공지</th><th>시행일</th><th>규칙 유형</th><th>청구 점검에 쓰는 내용</th><th>대상</th></tr></thead><tbody>
    ${db.rules.map(r => html`<tr><td><b>${r.no}. ${r.title}</b><div class="small muted">${r.docNo}</div></td><td class="num">${r.effective}</td><td><${Pill} tone=${r.type === 'info' ? '' : 'teal'}>${RULE_KO[r.type] || r.type}<//></td>
      <td class="small" style="max-width:420px">${r.summary}</td>
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
function AlertRow({ a, db }) {
  const M = db.master;
  return html`<tr>
    <td><span class="mono">${a.op}</span><div class="small muted num">${a.date}</div></td>
    <td><${Pill} tone=${TYPE_TONE[a.type]}>${ALERT_LABEL[a.type]}<//></td>
    <td><b>${a.name}</b> ${a.spec} ${a.code && html`<span class="code">${a.code}</span>`}${a.otherCode && M[a.otherCode] ? html`<div class="small muted">청구된 품목: ${M[a.otherCode].spec} <span class="code">${a.otherCode}</span></div>` : ''}
      ${a.raw ? html`<div class="small muted">기록지 표기: ${[...new Set(a.raw)].map(r => `"${r}"`).join(', ')}</div>` : ''}</td>
    <td class="small">${a.why}</td>
    <td class="r">${a.amount > 0 ? html`<b style="color:var(--red)">+${won(a.amount)}</b><div class="small muted">못 받은 금액</div>` : a.amount < 0 ? html`${won(-a.amount)}<div class="small muted">삭감 · 환수 위험</div>` : '–'}</td>
  </tr>`;
}
function AuditPage() {
  const db = S.db, alerts = pastAlerts();
  const types = [...RECORD_TYPES, ...RULE_TYPES].filter(t => alerts.some(a => a.type === t));
  const shown = alerts.filter(a => S.auditType === 'all' || a.type === S.auditType).sort((a, b) => b.date.localeCompare(a.date));
  const missed = alerts.filter(a => a.amount > 0).reduce((s, a) => s + a.amount, 0);
  const over = alerts.filter(a => a.amount < 0).reduce((s, a) => s - a.amount, 0);
  const nRec = alerts.filter(a => RECORD_TYPES.includes(a.type)).length;
  const dates = Object.values(db.claims).map(c => c.date).sort();
  return html`<div class="page">
    <div class="head"><div><h1>과거 대조</h1><p class="sub">DB를 만들자마자, 쌓여 있던 ${dates[0]?.slice(0, 7)} ~ ${db.installDate.slice(0, 7)} 이전 기록에서 확인할 항목을 찾았습니다. 판정은 규칙으로 하며, 자동으로 고치거나 전송하지 않습니다.</p></div></div>
    <div class="grid g4">
      <${Stat} hot=${true} k="확인할 항목" v=${alerts.length} unit="건" d=${`수술 ${new Set(alerts.map(a => a.op)).size}건에서`} />
      <${Stat} k="기록지 ↔ 청구 목록" v=${nRec} unit="건" d="누락 · 수량 · 규격 · 기록 없는 청구" />
      <${Stat} k="공지 규칙 위반" v=${alerts.length - nRec} unit="건" d="산정 불가 · 정액 · 한도 · 단가" />
      <${Stat} k="빠진 금액 추정" v=${won(missed)} d=${`삭감 · 환수 위험 ${won(over)} (가상 금액)`} />
    </div>
    <div class="card flush">
      <div class="tabs" style="padding:0 10px"><button class=${'tab' + (S.auditType === 'all' ? ' on' : '')} onClick=${() => { S.auditType = 'all'; draw(); }}>전체<span class="n">${alerts.length}</span></button>
        ${types.map(t => html`<button class=${'tab' + (S.auditType === t ? ' on' : '')} onClick=${() => { S.auditType = t; draw(); }}>${ALERT_LABEL[t]}<span class="n">${alerts.filter(a => a.type === t).length}</span></button>`)}</div>
      <div class="tablewrap"><table class="t"><thead><tr><th>수술</th><th>유형</th><th>재료</th><th>근거</th><th class="r">추정 금액</th></tr></thead><tbody>
        ${shown.map(a => html`<${AlertRow} a=${a} db=${db} key=${a.id} />`)}
      </tbody></table>${!shown.length && html`<div class="empty">해당하는 항목이 없습니다.</div>`}</div>
    </div>
    <p class="small muted">기록지가 있는 수술은 기록지와 청구 목록을 대조하고, 기록지가 없는 기간은 공지 규칙으로만 점검했습니다. 대조 대상은 기록과 청구가 실제로 대응해 온 품목군으로 한정합니다.</p>
  </div>`;
}

// ───────────────────────── 4. 청구 도우미 (EHR 화면) ─────────────────────────
function pendingList() {
  return Object.values(S.db.pending).sort((a, b) => (a.date + a.op).localeCompare(b.date + b.op));
}
function selectOp(op) { S.ehr = { ...S.ehr, op, result: null, dismissed: {}, hl: null, entry: { code: '', qty: '' } }; draw(); }
async function doRead() {
  const E = S.ehr, db = S.db;
  E.busy = true; draw();
  try {
    const p = db.pending[E.op];
    const r = await readScreen(db, E.op, { llm, cache, mode: 'live', screenText: p.text });
    E.result = r;
    if (!S.snap.streamAlerts[E.op]) S.snap.streamAlerts[E.op] = clone(r.alerts); // 채점용: 처음 읽었을 때의 알림
    persist();
  } catch (e) { toast('화면을 읽지 못했습니다: ' + (e?.message || e)); }
  E.busy = false; draw();
}
function reaudit() {
  const E = S.ehr, db = S.db, p = db.pending[E.op];
  if (!E.result) return;
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
function claimPrice(i) { const l = S.db.pending[S.ehr.op].claim.lines[i]; l.price = S.db.master[l.code].cap; l.amount = l.qty * l.price; reaudit(); }
function claimDel(i) { S.db.pending[S.ehr.op].claim.lines.splice(i, 1); reaudit(); }
function doCommit() {
  const E = S.ehr, db = S.db;
  const list = pendingList(); const idx = list.findIndex(p => p.op === E.op);
  const before = Object.keys(db.aliases).length;
  const r = commitOp(db, E.op, E.result.rec);
  persist();
  toast(r.bumped ? `Loop DB v${r.version} 로 갱신했습니다. 이번 달 수술을 모두 반영했습니다.` : `${E.op} 을(를) Loop DB에 더했습니다.`);
  const next = list[idx + 1] || list[idx - 1];
  selectOp(next && db.pending[next.op] ? next.op : null);
}
async function runBatch(skipConfirm) {
  const db = S.db;
  if (skipConfirm !== true && !confirm(`남은 수술 ${Object.keys(db.pending).length}건을 날짜순으로 모두 읽어 Loop DB에 반영할까요? 청구 목록은 고치지 않고 알림만 남깁니다.`)) return;
  S.batch = { d: 0, n: Object.keys(db.pending).length }; draw();
  try {
    const r = await runAllPending(db, { llm, cache, mode: S.mode === 'cache' ? 'cache' : 'live', onProgress: (d, n) => { S.batch = { d, n }; draw(); } });
    for (const a of r.alerts) { if (!S.snap.streamAlertsBatch) S.snap.streamAlertsBatch = {}; (S.snap.streamAlertsBatch[a.op] ||= []).push(a); }
    for (const [op, al] of Object.entries(S.snap.streamAlertsBatch || {})) if (!S.snap.streamAlerts[op]) S.snap.streamAlerts[op] = al;
    delete S.snap.streamAlertsBatch;
    S.ehr.op = null; S.ehr.result = null;
    toast(`수술 ${r.ops}건을 읽었습니다. Loop DB v${db.version} · 알림 ${r.alerts.length}건`);
  } catch (e) { toast('일괄 읽기를 마치지 못했습니다: ' + (e?.message || e)); }
  S.batch = null; persist(); draw();
}

function EHRScreen({ p, result }) {
  const E = S.ehr, db = S.db;
  const lines = (p.text || '').split('\n');
  const total = p.claim.lines.reduce((s, l) => s + l.amount, 0);
  const hlCodes = new Set([E.hl].filter(Boolean));
  const recHl = E.hlRaw;
  return html`<div class="ehr" id="ehr-screen">
    <div class="title"><span>OO병원 통합의료정보시스템 · 수술실 [HIS-OR]</span><span>${p.op} · ${p.date}</span></div>
    <div class="menu"><span>수술간호기록</span><span>처치재료</span><span>원무전송</span><span>조회</span><span style="margin-left:auto;color:#777">가상 화면</span></div>
    <div class="body">
      <div class="pane"><div class="cap">수술간호기록지</div><div class="scroll" id="ehr-record"><table><tbody>
        ${lines.map(line => {
          const cells = line.split(' | ').map(c => c === '∅' ? '' : c);
          const sec = cells.length === 1 && /^[A-E]\.\s|문서공통|심사평가|수술간호기록자료/.test(cells[0]);
          const hit = recHl && cells.some(c => recHl.includes(c.replace(/\s/g, '')));
          return html`<tr class=${(sec ? 'sec ' : '') + (hit ? 'hl' : '')}>${cells.map((c, i) => html`<td colspan=${i === cells.length - 1 ? 8 - cells.length + 1 : 1}>${c}</td>`)}</tr>`;
        })}
      </tbody></table></div></div>
      <div class="pane"><div class="cap">치료재료 청구 목록 (원무 전송 전) · ${p.claim.lines.length}줄 · 합계 ${won(total)}</div><div class="scroll" id="ehr-claim"><table>
        <thead><tr><th>순번</th><th>재료코드</th><th>재료명</th><th>규격</th><th>수량</th><th>단가</th><th>금액</th><th></th></tr></thead><tbody>
        ${p.claim.lines.map((l, i) => html`<tr class=${hlCodes.has(l.code) ? 'hl' : ''} id=${'cl-' + l.code}>
          <td>${i + 1}</td><td>${l.code}</td><td>${l.name}</td><td>${l.spec}</td>
          <td><input type="number" min="0" style="width:44px" value=${l.qty} id=${'qty-' + i} onChange=${e => claimQty(i, e.target.value)} /></td>
          <td style="text-align:right">${l.price.toLocaleString()}${db.master[l.code] && db.master[l.code].cap && l.price !== db.master[l.code].cap ? html` <button title="현재 상한금액으로" onClick=${() => claimPrice(i)}>갱신</button>` : ''}</td>
          <td style="text-align:right">${l.amount.toLocaleString()}</td><td><button onClick=${() => claimDel(i)}>삭제</button></td></tr>`)}
      </tbody></table></div>
      <div class=${'entry' + (E.entry.code ? ' hl' : '')}><b>재료 추가</b>
        <label>코드 <input id="entry-code" type="text" style="width:96px" value=${E.entry.code} onInput=${e => { E.entry.code = e.target.value; draw(); }} /></label>
        <label>수량 <input id="entry-qty" type="number" min="1" style="width:50px" value=${E.entry.qty} onInput=${e => { E.entry.qty = e.target.value; draw(); }} /></label>
        <span class="small">${db.master[E.entry.code?.trim().toUpperCase()] ? `${db.master[E.entry.code.trim().toUpperCase()].name} ${db.master[E.entry.code.trim().toUpperCase()].spec}` : ''}</span>
        <button style="margin-left:auto" onClick=${claimAdd}>추가</button></div></div>
    </div>
  </div>`;
}
function showRow(code, raw) { S.ehr.hl = code; S.ehr.hlRaw = raw ? raw.map(r => r.replace(/\s/g, '')).join('|') : null; draw(); setTimeout(() => document.getElementById('cl-' + code)?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 30); }
function fillEntry(code, qty, raw) { S.ehr.entry = { code, qty: String(qty) }; S.ehr.hl = null; S.ehr.hlRaw = raw ? raw.map(r => r.replace(/\s/g, '')).join('|') : null; draw(); setTimeout(() => document.getElementById('entry-code')?.scrollIntoView({ block: 'center', behavior: 'smooth' }), 30); }

function Assistant({ p }) {
  const E = S.ehr, db = S.db, M = db.master, r = E.result;
  if (!r) return html`<div class="assist"><div class="ahead"><${Logo} style="width:34px" /> CartLoop 청구 도우미</div><div class="abody">
    <p>EHR의 수술간호기록 화면과 청구 화면에 보이는 글자를 읽어, 원무로 보내기 전에 대조합니다. EHR DB에는 접근하지 않습니다.</p>
    <button class="btn pri" id="read-screen" disabled=${E.busy} onClick=${doRead}>${E.busy ? '화면을 읽는 중…' : '이 화면 읽기'}</button>
  </div></div>`;
  const live = r.alerts.filter(a => !E.dismissed[a.id]);
  const mats = r.rec.lines;
  return html`<div class="assist"><div class="ahead"><${Logo} /> CartLoop 청구 도우미 <span style="margin-left:auto;font-weight:500;font-size:12px">${r.via === 'llm' ? 'LLM으로 읽음' : '저장 결과'}</span></div><div class="abody">
    <div class="small">기록 ${mats.length}줄 · 청구 ${p.claim.lines.length}줄을 읽었습니다. ${r.rec.surgeon} · ${r.rec.procedure || ''} ${r.rec.setCode ? html`<span class="code">${r.rec.setCode}</span>` : ''}</div>
    <details><summary class="small" style="cursor:pointer">기록지 표기를 재료코드에 이은 결과 ${mats.filter(l => l.code).length}/${mats.length}</summary>
      <div class="small" style="display:grid;gap:3px;margin-top:6px">${mats.map(l => html`<div>"${l.rawName}" ${l.rawSpec} × ${l.qty} → ${l.code ? html`<span class="code">${l.code}</span> ${M[l.code].spec}` : html`<${Pill} tone="red">미확정<//>`}${db.aliases[l.alias]?.n <= 1 && db.aliases[l.alias]?.since > 1 ? html` <${Pill} tone="blue">새 표기<//>` : ''}</div>`)}</div></details>
    ${live.length === 0 ? html`<div class="alert ok"><div class="what">확인할 항목이 없습니다</div><div class="small">기록지와 청구 목록이 맞고, 공지 규칙에도 걸리지 않습니다.</div></div>` : html`<b>확인할 항목 ${live.length}건</b>`}
    ${live.map(a => html`<div class=${'alert ' + (TYPE_TONE[a.type] || '')} key=${a.id}>
      <div class="top"><${Pill} tone=${TYPE_TONE[a.type]}>${ALERT_LABEL[a.type]}<//>${a.amount > 0 ? html`<span class="small" style="color:var(--red);font-weight:700">+${won(a.amount)}</span>` : ''}</div>
      <div class="what">${a.name} ${a.spec} ${a.code && html`<span class="code">${a.code}</span>`}</div>
      <div class="small">${a.why}${a.raw ? html`<br />기록지 표기: ${[...new Set(a.raw)].map(x => `"${x}"`).join(', ')}` : ''}</div>
      <div class="acts">
        ${a.type === 'missing' && html`<button class="btn sm pri" onClick=${() => fillEntry(a.code, a.recQty, a.raw)}>코드를 입력칸에 넣기</button>`}
        ${a.type === 'spec_mismatch' && html`<button class="btn sm pri" onClick=${() => fillEntry(a.code, a.recQty, a.raw)}>맞는 규격을 입력칸에 넣기</button><button class="btn sm" onClick=${() => showRow(a.otherCode, a.raw)}>청구된 줄 보기</button>`}
        ${!['missing', 'spec_mismatch', 'unmapped'].includes(a.type) && html`<button class="btn sm pri" onClick=${() => showRow(a.code, a.raw)}>청구 화면에서 보기</button>`}
        <button class="btn sm ghost" onClick=${() => { E.dismissed[a.id] = true; draw(); }}>확인함 · 그대로 둠</button>
      </div></div>`)}
    <div class="small muted">고치는 것은 사람이 합니다. 청구 화면에서 추가 · 수량 변경 · 삭제를 하면 알림이 바로 다시 계산됩니다. 자동 전송은 없습니다.</div>
    <button class="btn warn" id="commit-op" disabled=${live.length > 0} onClick=${doCommit}>${live.length ? `알림 ${live.length}건을 먼저 확인하세요` : '확인 완료 · Loop DB에 반영'}</button>
  </div></div>`;
}
function EHRPage() {
  const db = S.db, E = S.ehr;
  const list = pendingList();
  if (!E.op && list.length) E.op = list[0].op;
  const p = E.op ? db.pending[E.op] : null;
  const doneN = Object.values(db.records).filter(r => r.date >= db.installDate).length;
  return html`<div class="page wide">
    <div class="head"><div><h1>청구 도우미</h1><p class="sub">설치 후에는 파일을 올리지 않습니다. 간호사가 쓰는 EHR 화면 옆에서, 화면의 글자만 읽어 원무 전송 전에 알려 줍니다.</p></div>
      <div class="right">${S.batch ? html`<span class="small num">읽는 중 ${S.batch.d} / ${S.batch.n}</span><span class="bar" style="width:160px"><i style=${`width:${S.batch.d / S.batch.n * 100}%`}></i></span>`
        : list.length ? html`<button class="btn" onClick=${() => runBatch()}>남은 ${list.length}건 모두 읽기</button>` : ''}</div></div>
    ${!list.length ? html`<div class="card empty"><b>설치 후 수술 ${doneN}건을 모두 읽었습니다.</b><br />Loop DB v${db.version} · <a href="#/db">버전 이력 보기</a> · <a href="#/sets">세트 개정안 보기</a> · <a href="#/validate">정답지 채점</a></div>` : html`
    <div class="ehrwrap">
      <div class="card flush"><div style="padding:10px 12px;border-bottom:1px solid var(--line)"><b>오늘의 수술</b> <span class="muted small">읽을 수술 ${list.length}건 · 반영 ${doneN}건</span></div>
        <div class="oplist">${list.map(x => html`<div class=${'opitem' + (x.op === E.op ? ' on' : '')} onClick=${() => selectOp(x.op)}>
          <div class="row" style="gap:6px"><b class="mono">${x.op}</b><span class="small muted num">${x.date}</span></div>
          <div class="small">${x.rec ? `${x.rec.surgeon} · ${(x.rec.opName || '').split('(')[0].split(':')[0].trim()}` : '기록지 없음'}</div></div>`)}</div></div>
      ${p && p.claim ? html`<${EHRScreen} p=${p} result=${E.result} />` : html`<div class="card empty">이 수술은 청구 목록이 없습니다.</div>`}
      ${p && p.claim && html`<${Assistant} p=${p} />`}
    </div>`}
  </div>`;
}

// ───────────────────────── 5. 세트 개정안 ─────────────────────────
function SetsPage() {
  const db = S.db, P = setPolicy(db);
  const all = proposeAll(db);
  const open = all.filter(p => !p.tray && !p.held), trays = all.filter(p => p.tray), held = all.filter(p => !p.tray && p.held);
  const bySet = {};
  for (const p of open) (bySet[p.setCode] ||= []).push(p);
  const hist = Object.values(db.sets).flatMap(s => s.history.map(h => ({ ...h, setCode: s.code }))).sort((a, b) => b.date.localeCompare(a.date));
  const act = { add: ['세트에 추가', 'teal'], qty: ['수량 변경', 'amber'], remove: ['세트에서 삭제', 'red'] };
  const doApprove = ps => { const r = approve(db, ps); persist(); toast(r.map(x => `${x.setCode} ${x.from} → ${x.to}`).join(', ') + ' 로 개정했습니다. 다음 수술분부터 적용합니다.'); draw(); };
  return html`<div class="page">
    <div class="head"><div><h1>세트 개정안</h1><p class="sub">쌓인 사용 기록과 Case cart 세트를 비교합니다. 근거를 먼저 보여 주고, 책임 간호사가 승인해야 세트가 바뀝니다.</p></div></div>
    <div class="notice">개정 기준${P.docNo ? ` (${P.docNo})` : ''}: 임플란트는 기록지 수량으로 최근 ${P.implant.window}건 중 ${P.implant.min}건 이상, 소모품은 청구 수량으로 최근 ${P.consumable.window}건 중 ${P.consumable.min}건 이상 같은 방향으로 다를 때만 제안합니다.</div>
    ${!open.length && html`<div class="card empty">지금 기준을 넘는 개정안이 없습니다.${held.length ? ` 보류한 제안 ${held.length}건은 다시 올리지 않습니다.` : ''}</div>`}
    ${Object.entries(bySet).map(([code, ps]) => { const s = db.sets[code]; return html`<div class="card">
      <div class="row" style="margin-bottom:10px"><h2>${s.surgeon} · ${s.procedure} ${s.level}</h2><span class="code">${code}</span><${Pill}>${s.version} · ${s.revised} 개정<//>
        <button class="btn pri" style="margin-left:auto" onClick=${() => doApprove(ps)}>${ps.length}건 모두 승인 → ${s.version.replace(/\d+$/, n => Number(n) + 1)}</button></div>
      <div class="grid">${ps.map(p => html`<div class="alert" key=${p.id}>
        <div class="top"><${Pill} tone=${act[p.action][1]}>${act[p.action][0]}<//><span class="what">${p.name} ${p.spec}</span><span class="code">${p.code}</span><${Pill}>${p.kind}<//>
          <b style="margin-left:auto" class="num">${p.setQty}개 → ${p.newQty}개</b></div>
        <div class="small">최근 ${p.window}건 사용 수량 (${p.basis === 'record' ? '기록지' : '청구'} 기준, 세트 수량 ${p.setQty}): <span class="series">${p.series.map(v => html`<i class=${v !== p.setQty ? 'hit' : ''}>${v}</i>`)}</span> <b>${p.window}건 중 ${p.hits}건</b>이 세트와 다릅니다.</div>
        ${p.note && html`<div class="small muted">관련 공지: ${p.note}</div>`}
        <div class="small muted">근거 수술: ${p.ops.slice(-5).join(', ')} 외</div>
        <div class="acts"><button class="btn sm pri" onClick=${() => doApprove([p])}>승인</button><button class="btn sm" onClick=${() => { hold(db, p); persist(); draw(); }}>보류</button></div></div>`)}</div></div>`; })}
    ${trays.length > 0 && html`<div class="card"><h2>트레이(업체 대여) 품목 · 참고</h2><p class="small muted" style="margin-bottom:8px">세트에 규격 범위로 들어 있는 임플란트입니다. 구성은 업체와 협의하므로 개정안으로 올리지 않고, 실제로 자주 쓴 규격만 알려 드립니다.</p>
      <div class="tablewrap"><table class="t"><thead><tr><th>세트</th><th>품목</th><th>최근 사용 수량</th></tr></thead><tbody>${trays.map(p => html`<tr><td><span class="code">${p.setCode}</span></td><td>${p.name} ${p.spec}</td><td><span class="series">${p.series.map(v => html`<i class=${v ? 'hit' : ''}>${v}</i>`)}</span></td></tr>`)}</tbody></table></div></div>`}
    ${hist.length > 0 && html`<div class="card flush"><div style="padding:14px 18px 6px"><h2>개정 이력</h2></div><table class="t"><thead><tr><th>일자</th><th>세트</th><th>버전</th><th>바뀐 내용</th><th>승인</th></tr></thead><tbody>
      ${hist.map(h => html`<tr><td class="num">${h.date}</td><td><span class="code">${h.setCode}</span></td><td><b>${h.from} → ${h.to}</b></td><td class="small">${h.changes.map(c => html`<div>${c.name} ${c.spec}: ${c.from}개 → ${c.to}개 <span class="muted">(${c.window}건 중 ${c.hits}건)</span></div>`)}</td><td>${h.by}</td></tr>`)}</tbody></table></div>`}
  </div>`;
}

// ───────────────────────── 6. 재료 묻기 ─────────────────────────
const ASK_EXAMPLES = ['A교수 TLIF 2레벨에는 케이지 뭐 준비해요?', 'B교수 PLIF 나사는 보통 어떤 규격을 몇 개 써요?', '콜라스탯은 몇 개까지 청구돼요?', 'set screw는 청구 목록에 넣어도 되나요?', 'D교수 TKA 때 시멘트는 몇 개 써요?'];
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
  setTimeout(() => document.querySelector('.main')?.scrollTo({ top: 1e9, behavior: 'smooth' }), 50);
}
function AskPage() {
  const [q, setQ] = useState('');
  return html`<div class="page">
    <div class="head"><div><h1>우리 병원 재료 묻기</h1><p class="sub">"구글도 모르는" 우리 병원 이야기를 Loop DB 기록으로 답합니다. 기록에 없는 것은 없다고 답하고, 진단 · 치료 추천은 하지 않습니다.</p></div>
      ${S.chat.length > 0 && html`<div class="right"><button class="btn sm" onClick=${() => { S.chat = []; persist(); draw(); }}>대화 지우기</button></div>`}</div>
    ${!S.chat.length && html`<div class="card"><h3 style="margin-bottom:8px">이렇게 물어볼 수 있습니다</h3><div class="row">${ASK_EXAMPLES.map(x => html`<button class="btn" onClick=${() => ask(x)}>${x}</button>`)}</div></div>`}
    <div class="chat">${S.chat.map(m => m.role === 'q' ? html`<div class="msg q">${m.text}</div>` : html`<div class="msg a">${m.text}
      ${(m.sets?.length || m.fams?.length) ? html`<div class="ev">근거 · Loop DB v${m.version}: ${m.sets.map(s => html`<span class="code">${s}</span>`)}${m.fams.map(f => html`<${Pill}>${f.slice(0, 28)}<//>`)}
        <details style="flex-basis:100%"><summary style="cursor:pointer">답에 쓴 병원 기록 보기</summary><pre class="mono" style="white-space:pre-wrap;margin:6px 0 0;max-height:260px;overflow:auto">${m.context}</pre></details></div>` : ''}</div>`)}
      ${S.asking && html`<div class="msg a muted">우리 병원 기록을 찾아보는 중…</div>`}</div>
    <form class="askbox" onSubmit=${e => { e.preventDefault(); ask(q); setQ(''); }}>
      <input id="ask-input" type="text" placeholder="예: C교수 TLIF 나사 규격은?" value=${q} onInput=${e => setQ(e.target.value)} />
      <button class="btn pri" disabled=${S.asking}>묻기</button></form>
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
    <div class="head"><div><h1>정답지 채점</h1><p class="sub">가상 데이터에 심어 둔 오류와 기록 줄마다의 정답 코드를 따로 보관해 두고, 서비스가 낸 결과와 비교합니다.</p></div>
      <div class="right"><button class="btn pri" disabled=${S.validBusy} onClick=${runValidation}>${S.validBusy ? '채점 중…' : V ? '다시 채점' : '채점하기'}</button></div></div>
    ${pendingLeft > 0 && html`<div class="notice amber">설치 후 수술 ${pendingLeft}건을 아직 읽지 않았습니다. 지금 채점하면 읽은 수술까지만 반영됩니다. <a href="#/ehr">청구 도우미</a>에서 "남은 건 모두 읽기"를 누른 뒤 채점하면 전체 결과가 나옵니다.</div>`}
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
  return html`
    <div class="grid g3">
      <div class="stat"><div class="k">추출 정확도</div><div class="big">${fmtPct(s.extraction.accuracy)}</div><div class="d">추출한 필드 가운데 정답과 일치한 비율 · 기록지 ${s.extraction.found} / ${s.extraction.records}건</div></div>
      <div class="stat"><div class="k">오류 검출 재현율</div><div class="big">${fmtPct(e.all.recall)}</div><div class="d">심어 둔 오류 ${e.all.truth}건 가운데 알림으로 잡은 ${e.all.found}건</div></div>
      <div class="stat"><div class="k">오탐 비율</div><div class="big">${fmtPct(e.all.falseRate ?? 0)}</div><div class="d">전체 알림 ${e.all.alerts}건 가운데 실제 오류가 아닌 ${e.all.falsePos}건</div></div>
    </div>
    <div class="card flush"><table class="t"><thead><tr><th>시험</th><th>확인하려는 것</th><th>지표와 계산</th><th>결과</th></tr></thead><tbody>
      <tr><td colspan="4" style="background:#fafbfb"><b>A. DB가 자동으로 구축 · 갱신되는가</b></td></tr>
      ${rows.slice(0, 3).map(r => html`<tr><td><b>${r[0]}</b></td><td>${r[1]}</td><td class="small muted">${r[2]}</td><td><b class="num">${r[3]}</b></td></tr>`)}
      <tr><td colspan="4" style="background:#fafbfb"><b>B. 그 DB로 오류를 잡아내는가</b></td></tr>
      ${rows.slice(3).map(r => html`<tr><td><b>${r[0]}</b></td><td>${r[1]}</td><td class="small muted">${r[2]}</td><td><b class="num">${r[3]}</b></td></tr>`)}
    </tbody></table></div>
    <div class="grid g2">
      <div class="card flush"><div style="padding:14px 18px 6px"><h2>오류 유형별</h2></div><table class="t"><thead><tr><th>유형</th><th class="r">정답</th><th class="r">검출</th><th class="r">알림</th><th class="r">오탐</th></tr></thead><tbody>
        ${Object.entries(e.byType).filter(([, b]) => b.truth || b.alerts).map(([t, b]) => html`<tr><td>${b.label}</td><td class="r">${b.truth}</td><td class="r">${b.found}</td><td class="r">${b.alerts}</td><td class="r">${b.falsePos}</td></tr>`)}
        <tr><td><b>합계</b></td><td class="r"><b>${e.all.truth}</b></td><td class="r"><b>${e.all.found}</b></td><td class="r"><b>${e.all.alerts}</b></td><td class="r"><b>${e.all.falsePos}</b></td></tr>
      </tbody></table>${e.unmapped ? html`<p class="small muted" style="padding:8px 16px">코드를 찾지 못해 "확인 필요"로만 띄운 표기 ${e.unmapped}건은 오류 알림에서 뺐습니다.</p>` : ''}</div>
      <div class="card"><h2>놓친 것과 잘못 알린 것</h2>
        ${!s.detail.fn.length && !s.detail.fp.length && !s.detail.aliasMisses.length ? html`<p class="muted">놓친 오류, 오탐, 코드 연결 오류가 없습니다.</p>` : ''}
        ${s.detail.fn.slice(0, 12).map(x => html`<div class="small"><${Pill} tone="red">놓침<//> ${x.op} · ${ALERT_LABEL[x.type]} · ${x.name} ${x.spec}</div>`)}
        ${s.detail.fp.slice(0, 12).map(x => html`<div class="small"><${Pill} tone="amber">오탐<//> ${x.op} · ${ALERT_LABEL[x.type]} · ${x.name} ${x.spec}</div>`)}
        ${s.detail.aliasMisses.slice(0, 8).map(x => html`<div class="small"><${Pill} tone="blue">코드 연결<//> ${x.op} · "${x.name}" ${x.spec} → 정답 ${x.want}, 결과 ${x.got || '미확정'}</div>`)}
        ${s.detail.fieldMisses.length > 0 && html`<p class="small muted" style="margin-top:8px">필드 불일치 ${s.extraction.fields - s.extraction.correct}건: ${s.detail.fieldMisses.slice(0, 4).map(x => `${x.op} ${x.field} (정답 "${x.want}", 결과 "${x.got ?? ''}")`).join(' · ')}</p>`}
      </div>
    </div>
    <p class="small muted">시험 재료: 가상 수술 1,240건(청구 42,861줄), 수술간호기록지 415건, 재료 마스터 312품목. 정답지는 서비스와 다른 방법(표를 칸 단위로 읽는 파서와 사람이 정리한 호칭 규칙표)으로 만들었습니다. 환자 · 수술 · 금액은 모두 가상입니다.</p>`;
}

// ───────────────────────── 앱 ─────────────────────────
function App() {
  const pages = { start: StartPage, db: DBPage, audit: AuditPage, ehr: EHRPage, sets: SetsPage, ask: AskPage, validate: ValidatePage };
  const route = S.db || S.route === 'start' ? S.route : 'start';
  const Page = pages[route] || StartPage;
  return html`<div class="shell"><${Side} /><main class="main"><${Page} /></main>${S.toast && html`<div class="toast" role="status">${S.toast}</div>`}</div>`;
}

(async () => {
  const saved = await store.load('state');
  if (saved?.db) { S.db = saved.db; S.snap = saved.snap; S.chat = saved.chat || []; }
  draw();
  try { S.health = await (await fetch('/api/llm')).json(); draw(); } catch { /* 연결 정보 없이도 화면은 뜬다 */ }
  // 시연용 자동 실행: ?demo=1 이면 가상 병원 데이터를 바로 불러온다
  const qs = new URLSearchParams(location.search);
  if (qs.get('cache') === '1') S.mode = 'cache';
  if (qs.get('demo') === '1' && !S.db) startBuild(fetchSample);
  window.__cartloop = { S, draw, runBatch: () => runBatch(true), runValidation, ask, go };
})();
