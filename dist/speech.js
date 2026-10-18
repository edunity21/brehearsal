import { wavBlob } from './core.js';
export const NativeRecognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition;

export class NativeSpeech {
  constructor({ onText, onStatus, time }) {
    this.onText = onText; this.onStatus = onStatus; this.time = time;
    this.active = false; this.blocked = false; this.failures = 0;
  }
  async prepare() {
    if (!NativeRecognition) throw new Error('이 브라우저는 기본 음성 인식을 제공하지 않습니다. 서버 음성 인식 또는 녹화 전용을 선택하세요.');
    const r = this.recognition = new NativeRecognition();
    r.lang = 'ko-KR'; r.continuous = true; r.interimResults = true;
    r.onstart = () => { this.segmentStart = this.time(); this.onStatus('음성 듣는 중'); };
    r.onresult = e => {
      this.failures = 0;
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const result = e.results[i];
        this.onText(result[0].transcript, result.isFinal, this.segmentStart, this.time());
        if (result.isFinal) this.segmentStart = this.time();
      }
    };
    r.onerror = e => {
      if (['not-allowed', 'service-not-allowed', 'audio-capture', 'language-not-supported'].includes(e.error)) this.blocked = true;
      if (e.error !== 'aborted' && e.error !== 'no-speech') {
        this.failures++;
        if (this.failures >= 4) this.blocked = true;
        this.onStatus(`음성 인식 중단 (${e.error}) · 녹화는 계속됩니다. 위치를 직접 선택할 수 있습니다.`);
      }
    };
    r.onend = () => {
      this.onStopped?.();
      if (this.active && !this.blocked) this.timer = setTimeout(() => this.launch(), 500 + this.failures * 1000);
    };
  }
  launch() { if (this.active && !this.blocked) try { this.recognition.start(); } catch { this.onStatus('음성 인식 재연결 대기'); } }
  start() { this.active = true; this.launch(); }
  pause() { this.active = false; clearTimeout(this.timer); try { this.recognition.abort(); } catch {} }
  resume() { this.blocked = false; this.failures = 0; this.start(); }
  async stop() {
    this.active = false; clearTimeout(this.timer);
    if (!this.recognition) return;
    await new Promise(resolve => {
      const timeout = setTimeout(() => { try { this.recognition.abort(); } catch {} resolve(); }, 2000);
      this.onStopped = () => { clearTimeout(timeout); this.onStopped = null; resolve(); };
      try { this.recognition.stop(); } catch { clearTimeout(timeout); this.onStopped = null; resolve(); }
    });
  }
}

export class ServerSpeech {
  constructor({ onText, onStatus, time, password }) {
    Object.assign(this, { onText, onStatus, time, password });
    this.active = false; this.samples = []; this.length = 0; this.queue = []; this.busy = false;
  }
  async prepare(stream) {
    this.context = new AudioContext();
    await this.context.audioWorklet.addModule(new URL('./pcm-worklet.js', import.meta.url));
    this.source = this.context.createMediaStreamSource(stream);
    this.worklet = new AudioWorkletNode(this.context, 'pcm-capture');
    const silent = this.context.createGain(); silent.gain.value = 0;
    this.source.connect(this.worklet).connect(silent).connect(this.context.destination);
    this.worklet.port.onmessage = e => {
      if (!this.active) return;
      this.samples.push(e.data); this.length += e.data.length;
      if (this.length >= this.context.sampleRate * 5) this.flush();
    };
    await this.context.resume();
  }
  start() { this.active = true; this.segmentStart = this.time(); this.context.resume(); this.onStatus('서버 음성 인식 · 약 5초씩 분석'); }
  flush(final = false) {
    if (!this.length) return;
    const data = new Float32Array(this.length); let offset = 0;
    for (const chunk of this.samples) { data.set(chunk, offset); offset += chunk.length; }
    let energy = 0; for (const value of data) energy += value * value;
    const start = this.segmentStart, end = this.time();
    // Repeat 0.6 seconds of context to reduce words split at a chunk boundary.
    const overlap = final ? 0 : Math.min(data.length, Math.floor(this.context.sampleRate * .6));
    this.samples = overlap ? [data.slice(-overlap)] : []; this.length = overlap;
    this.segmentStart = end - overlap / this.context.sampleRate;
    if (Math.sqrt(energy / data.length) < .002) return;
    if (this.queue.length >= 3) { this.onStatus('음성 분석 지연 · 일부 구간은 직접 검토해 주세요.'); return; }
    this.queue.push({ blob: wavBlob(data, this.context.sampleRate), start, end }); this.drain();
  }
  async drain() {
    if (this.busy) return;
    this.busy = true;
    while (this.queue.length) {
      const item = this.queue.shift();
      try {
        const response = await fetch('./api/transcribe', { method: 'POST', headers: {
          'Content-Type': 'audio/wav', 'X-App-Password': this.password
        }, body: item.blob, signal: AbortSignal.timeout(20000) });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error || '음성 분석 실패');
        if (body.text?.trim()) this.onText(body.text, true, item.start, item.end);
      } catch (error) { this.onStatus(`음성 분석 실패 · ${error.message} · 녹화는 유지됩니다.`); }
    }
    this.busy = false;
  }
  pause() { this.active = false; this.flush(true); }
  resume() { this.start(); }
  async stop() {
    this.active = false; this.flush(true);
    if (this.source) this.source.disconnect();
    if (this.worklet) this.worklet.disconnect();
    if (this.context) await this.context.close();
    // A bounded queue drains before saving transcription metadata.
    while (this.busy) await new Promise(resolve => setTimeout(resolve, 100));
  }
}
