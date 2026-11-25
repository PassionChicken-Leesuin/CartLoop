// 가상 데이터 셋을 배포 폴더(cartloop/sample)로 복사하고 목록(manifest.json)을 만든다.
//   node tools/make-sample.mjs
// 표시 이름은 원래 파일 이름 그대로 두고, 주소는 영문으로 바꾼다(한글 주소 문제를 피하려고).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(HERE, '..', '가상 데이터 셋');
const DST = path.join(HERE, '..', 'cartloop', 'sample');
fs.rmSync(path.join(DST, 'data'), { recursive: true, force: true });
fs.mkdirSync(path.join(DST, 'data', 'records'), { recursive: true });
const files = []; let n = 0, bytes = 0;
const walk = dir => fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]);
for (const p of walk(SRC).sort()) {
  const rel = path.relative(SRC, p).replace(/\\/g, '/');
  const ext = path.extname(p).toLowerCase();
  const isRecord = ext === '.pdf' || ext === '.docx';
  const url = isRecord ? `data/records/${path.basename(p)}` : `data/file${++n}${ext}`;
  if (!/^[\x20-\x7e]+$/.test(url)) throw new Error('영문이 아닌 주소: ' + url);
  fs.copyFileSync(p, path.join(DST, url));
  const size = fs.statSync(p).size; bytes += size;
  files.push({ name: rel, url, size });
}
fs.writeFileSync(path.join(DST, 'manifest.json'), JSON.stringify({ title: 'OO병원 가상 데이터 셋', files }));
console.log(`샘플 ${files.length}개 · ${(bytes / 1e6).toFixed(1)}MB → ${DST}`);
