import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

// Exercise application orchestration with synthetic devices, not the user's camera.
// Native encoder/device compatibility still requires the manual device checklist.
test('앱 흐름: 준비 → 녹화 → 10분 유지 → 정지/재개 → 15분 종료 → 저장 실패 시 내보내기 복구', async () => {
  const restore = [];
  const replace = (key, value) => {
    const old = Object.getOwnPropertyDescriptor(globalThis, key);
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
    restore.push(() => old ? Object.defineProperty(globalThis, key, old) : delete globalThis[key]);
  };
  class Node {
    constructor(id = '') { this.id = id; this.children = []; this.value = ''; this.hidden = false; this.disabled = false; this.checked = false; this.style = { setProperty() {} }; this.offsetTop = 0; this.listeners = {}; this.textContent = ''; this.className = ''; this._html = ''; const classes = new Set(); this.classList = { add: x => classes.add(x), toggle: (x, force) => { const enable = force ?? !classes.has(x); enable ? classes.add(x) : classes.delete(x); return enable; } }; }
    append(...nodes) { for (const node of nodes) if (node && typeof node === 'object') { node.parentElement = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    set innerHTML(value) { this._html = value; this.children = []; }
    get innerHTML() { return this._html; }
    setAttribute(name, value) { this[name] = value; }
    removeAttribute(name) { delete this[name]; }
    addEventListener(name, handler) { this.listeners[name] = handler; }
    closest() { return new Node(); }
    querySelectorAll() { return []; }
    async play() {}
    pause() {}
    load() {}
    showModal() { this.open = true; }
    close() { this.open = false; this.listeners.close?.(); }
    click() { this.onclick?.(); }
    remove() {}
  }
  const html = await readFile(new URL('../dist/index.html', import.meta.url), 'utf8');
  const nodes = Object.fromEntries([...html.matchAll(/id="([^"]+)"/g)].map(match => [match[1], new Node(match[1])]));
  nodes.title.value = '테스트 발표'; nodes.target.value = '10'; nodes.speechMode.value = 'off';
  nodes.script.value = '안녕하십니까. 관리번호 일번입니다. 발표를 시작하겠습니다.';
  let now = 0, ticker, recorderInstance;
  const tracks = [{ readyState: 'live', addEventListener() {}, stop() { this.readyState = 'ended'; } }, { readyState: 'live', addEventListener() {}, stop() { this.readyState = 'ended'; } }];
  class Recorder {
    static isTypeSupported() { return true; }
    constructor() { this.state = 'inactive'; this.mimeType = 'video/webm'; this.listeners = {}; recorderInstance = this; }
    start() { this.state = 'recording'; }
    pause() { this.state = 'paused'; }
    resume() { this.state = 'recording'; }
    addEventListener(name, listener) { this.listeners[name] = listener; }
    stop() {
      this.state = 'inactive';
      this.ondataavailable({ data: new Blob(['synthetic-media'], { type: 'video/webm' }) });
      this.listeners.stop?.();
    }
  }
  try {
    replace('document', { hidden: false, body: new Node(), documentElement: new Node(), getElementById: id => nodes[id], createElement: () => new Node(), createTextNode: text => ({ textContent: text }), addEventListener() {} });
    replace('window', { addEventListener() {} });
    replace('localStorage', { getItem: () => null, setItem() {} });
    replace('navigator', { mediaDevices: { getUserMedia: async () => ({ getTracks: () => tracks }) } });
    replace('isSecureContext', true); replace('MediaRecorder', Recorder);
    replace('performance', { now: () => now });
    replace('setTimeout', fn => { queueMicrotask(fn); return 1; });
    replace('setInterval', fn => { ticker = fn; return 1; }); replace('clearInterval', () => {});
    replace('fetch', async () => ({ ok: true, json: async () => ({ serverSpeech: false }) }));
    replace('indexedDB', { open() { const request = { error: new Error('Simulated unavailable storage') }; queueMicrotask(() => request.onerror()); return request; } });
    await import(`../dist/app.js?test=${Date.now()}`);
    await nodes.start.onclick();
    assert.equal(recorderInstance.state, 'recording'); assert.equal(nodes.stop.disabled, false);
    now = 600000; ticker(); assert.equal(recorderInstance.state, 'recording'); assert.equal(nodes.elapsed.textContent, '10:00');
    nodes.pause.onclick(); now += 60000; ticker(); assert.equal(nodes.elapsed.textContent, '10:00');
    nodes.pause.onclick(); assert.equal(recorderInstance.state, 'recording');
    now += 240000; ticker(); assert.match(nodes.notice.textContent, /60초/);
    now += 30000; ticker(); assert.match(nodes.notice.textContent, /30초/);
    now += 30000; ticker();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    assert.equal(recorderInstance.state, 'inactive');
    assert.equal(nodes.reviewDialog.open, true);
    assert.match(nodes.reviewInfo.textContent, /15:00/);
    assert.match(nodes.notice.textContent, /15분/);
    assert.match(nodes.notice.textContent, /저장에 실패/);
    assert.equal(nodes.sessionList.children.length, 1);
    nodes.closeReview.onclick();
  } finally { for (const undo of restore.reverse()) undo(); }
});
