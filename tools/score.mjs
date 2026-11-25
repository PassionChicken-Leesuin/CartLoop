// 서비스 결과(tools/service-output.json)를 정답지와 비교해 채점표를 낸다.
//   node tools/score.mjs [--detail]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.join(HERE, '..', 'cartloop');
const { score, fmtPct } = await import(pathToFileURL(path.join(APP, 'js/lib/score.js')).href);
const key = JSON.parse(fs.readFileSync(path.join(APP, 'answer/answer_key.json'), 'utf8'));
const out = JSON.parse(fs.readFileSync(process.argv.find(a => a.endsWith('.json')) || path.join(HERE, 'service-output.json'), 'utf8'));
const s = score(key, out);
const detail = process.argv.includes('--detail');
console.log(`A-1 필드 추출 정확도  ${fmtPct(s.extraction.accuracy)}  (${s.extraction.correct}/${s.extraction.fields}, 기록지 ${s.extraction.found}/${s.extraction.records})`);
console.log('    ' + Object.entries(s.extraction.perField).map(([k, v]) => `${k} ${fmtPct(v.accuracy)}`).join(' · '));
console.log(`A-2 별칭 통합 정확도  줄 ${fmtPct(s.alias.accuracy)} (${s.alias.correct}/${s.alias.lines}) · 표기 ${fmtPct(s.alias.notationAccuracy)} (${s.alias.notationsCorrect}/${s.alias.notations})`);
console.log(`B   오류 검출        재현율 ${fmtPct(s.errors.all.recall)} (${s.errors.all.found}/${s.errors.all.truth}) · 정밀도 ${fmtPct(s.errors.all.precision)} · 오탐 ${s.errors.all.falsePos}/${s.errors.all.alerts} · 코드 못 찾은 표기 ${s.errors.unmapped}`);
for (const [t, b] of Object.entries(s.errors.byType)) if (b.truth || b.alerts) console.log(`    ${b.label.padEnd(14)} 정답 ${b.truth} · 검출 ${b.found} · 알림 ${b.alerts} · 오탐 ${b.falsePos}`);
console.log(`세트  설치 시점 ${s.sets.v1.found}/${s.sets.v1.truth} (제안 ${s.sets.v1.proposed}) · 3개월 뒤 ${s.sets.end.found}/${s.sets.end.truth} (제안 ${s.sets.end.proposed})`, JSON.stringify({ missed: [...s.sets.v1.missed, ...s.sets.end.missed], extra: [...s.sets.v1.extra, ...s.sets.end.extra] }));
if (detail) {
  console.log('\n-- 놓친 오류'); for (const e of s.detail.fn) console.log('  ', e.op, e.type, e.code, e.name, e.spec, 'rec', e.recQty, 'claim', e.claimQty);
  console.log('-- 오탐'); for (const a of s.detail.fp.slice(0, 60)) console.log('  ', a.op, a.type, a.code, a.name.slice(0, 30), a.spec, 'rec', a.recQty, 'claim', a.claimQty, a.raw || '');
  console.log('-- 코드 연결 오류'); for (const a of s.detail.aliasMisses.slice(0, 50)) console.log('  ', JSON.stringify(a));
  console.log('-- 필드 오류'); for (const a of s.detail.fieldMisses.slice(0, 40)) console.log('  ', JSON.stringify(a));
}
