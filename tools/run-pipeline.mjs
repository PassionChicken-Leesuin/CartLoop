// 브라우저 없이 CartLoop 전체 흐름을 돌린다 (검증 · 추출 캐시 만들기).
//   1) 다른 창에서:  node cartloop/dev-server.mjs
//   2) node tools/run-pipeline.mjs [--cache] [--out 결과.json]
// --cache 를 주면 저장된 추출 결과를 먼저 쓰고, 없을 때만 LLM을 부른다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', 'cartloop');
const DATA = path.join(HERE, '..', '가상 데이터 셋');
const imp = p => import(pathToFileURL(path.join(APP, p)).href);
const args = process.argv.slice(2);
const flag = n => args.includes(n);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };

const origWarn = console.warn; console.warn = () => {}; // pdf.js 의 canvas 경고는 글자 추출과 무관하다
const pdfjs = await imp('js/vendor/pdf.min.mjs');
pdfjs.GlobalWorkerOptions.workerSrc = pathToFileURL(path.join(APP, 'js/vendor/pdf.worker.min.mjs')).href;
const { unzipSync } = await imp('js/vendor/fflate.js');
const { createLLM } = await imp('js/lib/llm.js');
const P = await imp('js/lib/pipeline.js');
const { summary } = await imp('js/lib/loopdb.js');
const { tally } = await imp('js/lib/audit.js');
const { proposeAll } = await imp('js/lib/sets.js');

const endpoint = opt('--endpoint', 'http://localhost:5173/api/llm');
const llm = createLLM({ endpoint, concurrency: 20 });
const cachePath = path.join(APP, 'sample', 'extraction-cache.json');
const store = fs.existsSync(cachePath) ? JSON.parse(fs.readFileSync(cachePath, 'utf8')) : {};
const cache = { get: k => store[k], set: (k, v) => { store[k] = v; } };
const mode = flag('--cache') ? 'cache' : 'live';

function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
}
const limit = Number(opt('--limit', 0));
let paths = walk(DATA);
if (limit) { const recs = paths.filter(p => /\.(pdf|docx)$/i.test(p)); paths = [...paths.filter(p => !/\.(pdf|docx)$/i.test(p)), ...recs.slice(0, limit)]; }
const files = paths.map(p => ({ name: path.relative(DATA, p).replace(/\\/g, '/'), buf: new Uint8Array(fs.readFileSync(p)) }));
console.log(`파일 ${files.length}개 · 모드 ${mode}`);

const t0 = Date.now();
let lastStage = '';
const res = await P.buildFromFiles(files, {
  llm, deps: { pdfjs, unzipSync }, cache, mode,
  onStage: s => { lastStage = s; console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s] ${s}`); },
  onProgress: (s, d, n) => { if (d % 50 === 0 || d === n) process.stdout.write(`   ${s} ${d}/${n}\n`); },
});
const { db, alerts, report } = res;
console.log('판독:', Object.entries(report.files.reduce((a, f) => (a[f.kind] = (a[f.kind] || 0) + 1, a), {})).map(([k, v]) => `${k} ${v}`).join(' · '));
console.log('추출:', JSON.stringify(report.extract).slice(0, 300));
console.log('공지 규칙:', report.rulesVia, db.rules.map(r => `${r.no}:${r.type}`).join(' '));
console.log('별칭:', JSON.stringify(report.alias));
console.log('소요(ms):', JSON.stringify(report.ms));
console.log('v1 요약:', JSON.stringify(summary(db)));
console.log('설치 기준일:', db.installDate, '· 과거 알림:', JSON.stringify(Object.fromEntries(Object.entries(tally(alerts)).map(([k, v]) => [k, v.n]))));
const propV1 = proposeAll(db);

// 설치 후 석 달
const v1 = { summary: summary(db), aliases: JSON.parse(JSON.stringify(db.aliases)), proposals: propV1 };
const stream = await P.runAllPending(db, { llm, cache, mode, onProgress: (d, n) => { if (d % 50 === 0 || d === n) console.log(`   stream ${d}/${n}`); } });
console.log('설치 후 알림:', JSON.stringify(Object.fromEntries(Object.entries(tally(stream.alerts)).map(([k, v]) => [k, v.n]))));
console.log('최종 요약:', JSON.stringify(summary(db)));
console.log('버전 이력:', db.changelog.map(c => `v${c.version} ${c.reason} (+${c.addedOps ?? 0}건, 별칭 +${c.newAliases ?? 0})`).join(' | '));
const propEnd = proposeAll(db);
console.log('세트 개정안:', propEnd.filter(p => !p.tray).map(p => `${p.setCode} ${p.action} ${p.code} ${p.setQty}→${p.newQty} (${p.hits}/${p.window})`).join(' | ') || '없음');
console.log('LLM:', JSON.stringify({ ...llm.stats, byKey: Object.keys(llm.stats.byKey).length + ' keys' }), `· 총 ${((Date.now() - t0) / 1000).toFixed(1)}s`);

fs.mkdirSync(path.dirname(cachePath), { recursive: true });
fs.writeFileSync(cachePath, JSON.stringify(store));
const out = opt('--out', path.join(HERE, 'service-output.json'));
fs.writeFileSync(out, JSON.stringify({
  installDate: db.installDate, report, v1,
  records: db.records, aliases: db.aliases, rules: db.rules, procMap: db.procMap, famStat: db.famStat,
  alerts: [...alerts, ...stream.alerts], proposals: { v1: propV1, end: propEnd }, changelog: db.changelog,
  sets: db.sets, llm: llm.stats,
}));
console.log('결과 저장:', out);
process.exit(0);
