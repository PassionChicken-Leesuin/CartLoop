// 발표 자료에 넣을 서비스 화면을 창 단위로 캡처한다.
//   준비: node cartloop/dev-server.mjs  ·  npm i puppeteer-core (OneDrive 밖 폴더에서)
//   실행: node tools/capture-screens.mjs <저장 폴더> [주소]
// 가상 병원 데이터를 올려 구축하고, 수술 한 건을 읽고, 묻고, 세트를 승인하고, 석 달치를 반영하는 순서로 실제 화면을 찍는다.
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
const require = createRequire(path.join(process.cwd(), 'x.js'));
const puppeteer = require('puppeteer-core');

const out = path.resolve(process.argv[2] || 'shots');
const base = process.argv[3] || 'http://localhost:5173';
const OP = process.env.OP || 'OP25-2016';
const QUESTION = process.env.Q || 'A교수님 TLIF 2레벨 때 implant 뭐 써요?';
fs.mkdirSync(out, { recursive: true });

const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: 'new' });
const page = await browser.newPage();
await page.setViewport({ width: 1560, height: 1000, deviceScaleFactor: 2 });
page.on('dialog', d => d.accept());
const errs = []; page.on('pageerror', e => errs.push(e.message));
const wait = ms => new Promise(r => setTimeout(r, ms));
const ev = (fn, ...a) => page.evaluate(fn, ...a);
async function shot(sel, name) {
  await wait(450);
  const el = await page.$(sel);
  if (!el) { console.log('!! 없음', sel); return; }
  await el.screenshot({ path: path.join(out, name + '.png') });
  const b = await el.boundingBox();
  console.log(name, Math.round(b.width) + 'x' + Math.round(b.height));
}

await page.goto(`${base}/?demo=1&stay=1&cache=1`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__cartloop?.S.stage?.groups?.length && !window.__cartloop.S.stage.busy, { timeout: 180000 });
await shot('#win-upload', '18-left-upload');
await ev(() => window.__cartloop.startBuild());
await page.waitForFunction(() => window.__cartloop.S.building?.stage === 'done' || window.__cartloop.S.buildError, { timeout: 240000 });
await shot('#win-result', '18-right-result');

// 구현2: EHR 화면 → 청구 대조 알림
await ev(() => window.__cartloop.go('ehr')); await wait(300);
await ev(op => window.__cartloop.selectOp(op), OP);
await page.waitForFunction(() => window.__cartloop.S.ehr.result, { timeout: 90000 });
await page.waitForFunction(() => !window.__cartloop.S.ehr.busy, { timeout: 90000 });
await ev(() => { const a = window.__cartloop.S.ehr.result.alerts[0]; if (a) { window.__cartloop.S.ehr.hlRaw = a.raw || null; window.__cartloop.draw(); } });
await shot('#win-his', '19-left-ehr');
await shot('#cl-compact', '19-right-assist');
// 바탕화면 전체 (HIS 옆에 CartLoop 도우미가 떠 있는 모습)
await page.setViewport({ width: 1600, height: 900, deviceScaleFactor: 2 });
await wait(500);
await page.screenshot({ path: path.join(out, '23-desktop.png') }); console.log('23-desktop 1600x900');
// 화면을 읽는 도중의 모습
await ev(op => window.__cartloop.selectOp(op), OP);
await wait(2300);
await page.screenshot({ path: path.join(out, '23-desktop-reading.png') }); console.log('23-desktop-reading 1600x900');
await page.waitForFunction(() => window.__cartloop.S.ehr.result && !window.__cartloop.S.ehr.busy, { timeout: 90000 });
await page.setViewport({ width: 1560, height: 1000, deviceScaleFactor: 2 });

// 구현3: 세트 개정안
await ev(() => window.__cartloop.go('sets'));
await shot('#win-set-evidence', '20-left-evidence');
await shot('#win-set-proposal', '20-right-proposal');

// 묻기
await ev(() => window.__cartloop.go('ask')); await wait(300);
await ev(q => window.__cartloop.ask(q), QUESTION);
await page.waitForFunction(() => !window.__cartloop.S.asking, { timeout: 120000 });
console.log('답:', await ev(() => window.__cartloop.S.chat.at(-1).text.replace(/\n/g, ' ')));
// 세트 승인 → 석 달치 반영 → 구현4
await ev(() => window.__cartloop.go('sets')); await wait(300);
await page.click('#approve-set');
await ev(() => window.__cartloop.runBatch());
await page.waitForFunction(() => Object.keys(window.__cartloop.S.db.pending).length === 0 && !window.__cartloop.S.batch, { timeout: 300000 });
await ev(() => window.__cartloop.go('ask'));
await shot('#win-ask', '21-left-ask');
await shot('#win-update-ask', '21-right-update');
await ev(() => window.__cartloop.go('validate'));
await ev(() => window.__cartloop.runValidation());
await page.waitForFunction(() => window.__cartloop.S.valid, { timeout: 60000 });
await shot('#win-validate', '25-validate');
console.log('채점:', await ev(() => { const s = window.__cartloop.S.valid.s; return JSON.stringify({ 추출: s.extraction.accuracy, 재현율: s.errors.all.recall, 오탐: s.errors.all.falsePos, 세트: [s.sets.v1.found, s.sets.end.found] }); }));
console.log('요약:', await ev(() => JSON.stringify({ v: window.__cartloop.S.db.version, log: window.__cartloop.S.db.changelog.map(c => [c.version, c.addedOps, c.newAliases, c.snapshot.notations]) })));
if (errs.length) console.log('오류:', errs.slice(0, 5));
await browser.close();
