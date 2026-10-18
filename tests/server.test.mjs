import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../server.mjs';
import { wavBlob } from '../dist/core.js';
async function withServer(options, run) {
  const server = createApp(options); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run(`http://127.0.0.1:${server.address().port}`); }
  finally { await new Promise(resolve => server.close(resolve)); }
}
test('앱 제공, 키 비노출, 서버 모드 미설정', () => withServer({ key: '', password: '' }, async base => {
  assert.equal((await fetch(base)).status, 200);
  assert.deepEqual(await (await fetch(base + '/api/config')).json(), { serverSpeech: false });
  assert.equal((await fetch(base + '/api/transcribe', { method: 'POST' })).status, 503);
  assert.notEqual((await fetch(base + '/.env')).status, 200);
  assert.notEqual((await fetch(base + '/server.mjs')).status, 200);
}));
test('인증과 오디오 검증 후 서버에서만 API 호출', () => withServer({ key: 'test-only-key', password: 'test-password', fetchImpl: async (url, options) => {
  assert.equal(url, 'https://api.openai.com/v1/audio/transcriptions');
  assert.equal(options.headers.Authorization, 'Bearer test-only-key');
  assert.equal(options.body.get('language'), 'ko');
  assert.equal(options.body.get('prompt'), null);
  return new Response(JSON.stringify({ text: '안녕하십니까' }), { status: 200 });
} }, async base => {
  assert.equal((await fetch(base + '/api/authorize', { method: 'POST' })).status, 401);
  const headers = { 'X-App-Password': 'test-password', 'Content-Type': 'audio/wav' };
  assert.equal((await fetch(base + '/api/authorize', { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.example' } })).status, 403);
  assert.equal((await fetch(base + '/api/transcribe', { method: 'POST', headers, body: 'bad' })).status, 400);
  const response = await fetch(base + '/api/transcribe', { method: 'POST', headers, body: wavBlob(new Float32Array(100), 16000) });
  assert.deepEqual(await response.json(), { text: '안녕하십니까' });
}));
