import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { timingSafeEqual } from 'node:crypto';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), 'dist');
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
function sameSecret(a, b) { const left = Buffer.from(a || ''), right = Buffer.from(b || ''); return left.length > 0 && left.length === right.length && timingSafeEqual(left, right); }
function json(res, status, data) { res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(data)); }
export function createApp({ key = process.env.OPENAI_API_KEY || '', password = process.env.APP_PASSWORD || '', model = process.env.TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe', origin = process.env.PUBLIC_ORIGIN || '', fetchImpl = fetch } = {}) {
  const serverSpeech = !!(key && password);
  let inflight = 0;
  const rates = new Map();
  return http.createServer(async (req, res) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'same-origin');
    res.setHeader('Permissions-Policy', 'camera=(self), microphone=(self)');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; media-src 'self' blob:; connect-src 'self'; worker-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'");
    try {
      let url;
      try { url = new URL(req.url, 'http://localhost'); } catch { return json(res, 400, { error: '잘못된 주소' }); }
      if (url.pathname === '/api/config' && req.method === 'GET') return json(res, 200, { serverSpeech });
      if (url.pathname.startsWith('/api/')) {
        if (!['/api/authorize', '/api/transcribe'].includes(url.pathname)) return json(res, 404, { error: '없는 API' });
        if (req.method !== 'POST') return json(res, 405, { error: 'POST 요청만 지원합니다.' });
        if (!serverSpeech) return json(res, 503, { error: '서버 음성 인식이 설정되지 않았습니다.' });
        const allowedOrigin = origin || `http://${req.headers.host}`;
        if (req.headers.origin && req.headers.origin !== allowedOrigin) return json(res, 403, { error: '허용되지 않은 출처입니다.' });
        if (!sameSecret(req.headers['x-app-password'], password)) return json(res, 401, { error: '서버 이용 비밀번호를 확인하세요.' });
        if (url.pathname === '/api/authorize') return json(res, 200, { ok: true });
        const now = Date.now(), client = req.socket.remoteAddress || 'local';
        for (const [id, entry] of rates) if (now - entry.start > 60000) rates.delete(id);
        const rate = rates.get(client) || { start: now, count: 0 }; rate.count++; rates.set(client, rate);
        if (rate.count > 30 || inflight >= 3) return json(res, 429, { error: '음성 요청이 많습니다. 잠시 후 다시 시도하세요.' });
        if (req.headers['content-type'] !== 'audio/wav') return json(res, 415, { error: 'WAV 오디오만 지원합니다.' });
        if (Number(req.headers['content-length'] || 0) > 2_000_000) return json(res, 413, { error: '오디오 조각이 너무 큽니다.' });
        const parts = []; let length = 0;
        for await (const chunk of req) {
          length += chunk.length;
          if (length > 2_000_000) { json(res, 413, { error: '오디오 조각이 너무 큽니다.' }); return; }
          parts.push(chunk);
        }
        const buffer = Buffer.concat(parts);
        if (buffer.length < 44 || buffer.toString('ascii', 0, 4) !== 'RIFF' || buffer.toString('ascii', 8, 12) !== 'WAVE') return json(res, 400, { error: '올바른 WAV 오디오가 아닙니다.' });
        inflight++;
        try {
          const form = new FormData();
          form.append('file', new Blob([buffer], { type: 'audio/wav' }), 'speech.wav');
          form.append('model', model); form.append('language', 'ko'); form.append('response_format', 'json');
          // Do not send the reference script as a prompt: it can bias transcription toward the answer.
          const upstream = await fetchImpl('https://api.openai.com/v1/audio/transcriptions', {
            method: 'POST', headers: { Authorization: `Bearer ${key}` }, body: form, signal: AbortSignal.timeout(18000)
          });
          if (!upstream.ok) return json(res, 502, { error: `음성 인식 서비스 응답 오류 (${upstream.status}). 서버의 API 설정을 확인하세요.` });
          const body = await upstream.json();
          return json(res, 200, { text: typeof body.text === 'string' ? body.text : '' });
        } catch { return json(res, 502, { error: '음성 인식 서비스에 연결하지 못했습니다.' }); }
        finally { inflight--; }
      }
      if (!['GET', 'HEAD'].includes(req.method)) return json(res, 405, { error: '지원하지 않는 요청' });
      let pathname;
      try { pathname = decodeURIComponent(url.pathname); } catch { return json(res, 400, { error: '잘못된 경로' }); }
      if (pathname.includes('\\') || pathname.includes('\0') || pathname.split('/').some(part => part.startsWith('.'))) return json(res, 403, { error: '접근할 수 없는 경로' });
      const filename = path.resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
      if (!filename.startsWith(root + path.sep)) return json(res, 403, { error: '접근할 수 없는 경로' });
      try {
        const data = await readFile(filename);
        res.writeHead(200, { 'Content-Type': mime[path.extname(filename)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
        res.end(req.method === 'HEAD' ? undefined : data);
      } catch { json(res, 404, { error: '파일을 찾을 수 없습니다.' }); }
    } catch { if (!res.headersSent) json(res, 500, { error: '요청 처리 중 오류가 발생했습니다.' }); else res.end(); }
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.env.OPENAI_API_KEY && !process.env.APP_PASSWORD) {
    console.error('OPENAI_API_KEY를 설정했다면 APP_PASSWORD도 설정해야 합니다.'); process.exit(1);
  }
  const port = Number(process.env.PORT || 4173), host = process.env.HOST || '127.0.0.1';
  createApp().listen(port, host, () => console.log(`BRIDGE ready: http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`));
}
