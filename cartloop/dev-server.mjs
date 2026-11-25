// 로컬 개발 서버: 정적 파일 + /api/* 함수. 의존성 없음.
//   node dev-server.mjs [port]
// 상위 폴더의 .env 에서 OpenRouter 키를 읽는다.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
for (const envPath of [path.join(ROOT, '.env'), path.join(ROOT, '..', '.env')]) {
  if (!fs.existsSync(envPath)) continue;
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w]*)\s*=\s*(.*)\s*$/.exec(line);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.pdf': 'application/pdf', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' };
const port = Number(process.argv[2]) || 5173;
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    if (url.pathname.startsWith('/api/')) {
      const file = path.join(ROOT, url.pathname + '.js');
      if (!fs.existsSync(file)) { res.statusCode = 404; return res.end('no such function'); }
      const mod = await import(pathToFileURL(file).href + '?v=' + fs.statSync(file).mtimeMs);
      return await mod.default(req, res);
    }
    let p = path.join(ROOT, decodeURIComponent(url.pathname));
    if (!p.startsWith(ROOT)) { res.statusCode = 403; return res.end(); }
    if (fs.existsSync(p) && fs.statSync(p).isDirectory()) p = path.join(p, 'index.html');
    if (!fs.existsSync(p)) { res.statusCode = 404; return res.end('not found'); }
    res.setHeader('Content-Type', MIME[path.extname(p).toLowerCase()] || 'application/octet-stream');
    res.setHeader('Cache-Control', 'no-store');
    fs.createReadStream(p).pipe(res);
  } catch (e) {
    res.statusCode = 500; res.end(String(e && e.stack || e));
  }
}).listen(port, () => console.log(`CartLoop dev server → http://localhost:${port}`));
