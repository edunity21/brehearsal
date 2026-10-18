import { MAX_SECONDS, DEFAULT_ALIASES, formatTime, timing, parseAliases, normalize, align, SessionClock } from './core.js';
import { saveSession, saveChunk, listSessions, loadChunks, deleteSession } from './storage.js';
import { NativeRecognition, NativeSpeech, ServerSpeech } from './speech.js';

const $ = id => document.getElementById(id);
let stream, recorder, speech, session, normalized, marks = [], cursor = 0;
let state = 'idle', chunks = [], writes = Promise.resolve(), saveFailed = false;
let clock = new SessionClock(), interval, wakeLock, predictedSmoothed = null, predictionCooldown = 0;
let interimEnd = 0, captionNodes = [], warned = new Set(), currentLine = -1;
let reviewSession, reviewBlob, reviewURL, serverAvailable = false, captionSize = 23;
const memorySessions = new Map();
let emptyLibrary = $('sessionList').innerHTML;

function notice(text, error = false) { $('notice').textContent = text; $('notice').className = `notice${error ? ' error' : ''}`; $('notice').hidden = !text; }
function speechStatus(text) { $('speechStatus').textContent = text; }
function settings() { return { title: $('title').value, script: $('script').value, target: Number($('target').value) * 60, aliases: $('aliases').value }; }
function storeSettings() { try { localStorage.setItem('bridge-settings', JSON.stringify(settings())); } catch { /* Private browsing can disable local storage. */ } }
function setLocked(locked) { for (const element of $('setup').querySelectorAll('input,textarea,select,button')) element.disabled = locked; }
function setState(next) {
  state = next;
  document.body.classList.toggle('recording', ['recording', 'paused', 'countdown', 'saving'].includes(state));
  $('recordState').classList.toggle('live', state === 'recording');
  const names = { idle: '준비 중', recording: '녹화 중', paused: '일시정지', countdown: '준비 카운트다운', saving: '저장 중' };
  $('recordState').replaceChildren(Object.assign(document.createElement('i'), {}), document.createTextNode(names[state]));
  $('pause').disabled = !['recording', 'paused'].includes(state);
  $('pause').textContent = state === 'paused' ? '다시 시작' : '일시정지';
  $('stop').disabled = !['recording', 'paused'].includes(state);
  setLocked(state !== 'idle');
}
function modeChanged() {
  const mode = $('speechMode').value;
  $('serverOptions').hidden = mode !== 'server';
  $('consent').closest('label').hidden = mode === 'off';
  const help = {
    native: NativeRecognition ? '브라우저 제공자의 한국어 음성 인식을 사용합니다. 기기·네트워크에 따라 지원이 달라집니다.' : '현재 브라우저는 기본 음성 인식을 지원하지 않습니다. 서버 연결이나 녹화 전용을 선택하세요.',
    server: serverAvailable ? '서버 연결 가능 · 오디오를 약 5초씩 OpenAI로 전송합니다. 처리 시간이 추가됩니다.' : '서버 설정이 필요합니다. README의 OPENAI_API_KEY와 APP_PASSWORD 설정을 확인하세요.',
    off: '영상과 시간만 기록합니다. 원문 위치를 직접 선택하면 진행률을 맞출 수 있습니다.'
  };
  $('modeHelp').textContent = help[mode];
}
function prepareScript() {
  const config = settings();
  normalized = normalize(config.script, parseAliases(config.aliases));
  marks = new Uint8Array(config.script.length); cursor = 0; interimEnd = 0; currentLine = -1;
  captionNodes = [];
  $('captions').replaceChildren(); $('positionList').replaceChildren();
  let offset = 0;
  const lines = config.script.split('\n');
  for (const line of lines) {
    const start = offset;
    const row = document.createElement('div'); row.className = 'line';
    for (let k = 0; k < line.length; k++) {
      const span = document.createElement('span'); span.textContent = line[k];
      row.append(span); captionNodes[start + k] = span;
    }
    if (!line) row.append(document.createTextNode('\u00a0'));
    $('captions').append(row);
    if (line.trim()) {
      const button = document.createElement('button'); button.textContent = line;
      button.onclick = () => {
        const index = normalized.map.findIndex(item => item.start >= start);
        cursor = Math.max(0, index); interimEnd = cursor;
        predictedSmoothed = null; predictionCooldown = clock.seconds() + 10;
        if (session && ['recording', 'paused'].includes(state)) session.events.push({ type: 'seek', at: clock.seconds(), position: cursor, marks: [] });
        paintCaptions(); updateTiming();
        speechStatus('원문 위치를 직접 맞췄습니다. 다음 발화를 기다립니다.');
      };
      $('positionList').append(button);
    }
    offset += line.length + 1;
  }
  if (!config.script.trim()) $('captions').textContent = '원고를 입력하면 이곳에 자막이 표시됩니다.';
  $('scriptCount').textContent = `${config.script.length.toLocaleString()}자`;
  $('heroTarget').textContent = `${config.target / 60 || 10}분`;
  $('cameraTarget').textContent = `목표 ${formatTime(config.target)}`;
  paintCaptions(); updateTiming();
}
function paintCaptions() {
  const raw = normalized?.map[Math.min(cursor, normalized.map.length - 1)]?.start ?? 0;
  const end = normalized?.map[Math.min(interimEnd, normalized.map.length - 1)]?.end ?? raw;
  for (let i = 0; i < captionNodes.length; i++) {
    const node = captionNodes[i]; if (!node) continue;
    node.className = marks[i] === 1 ? 'matched' : marks[i] === 2 ? 'review-needed' : '';
    if (i >= raw && i <= Math.max(raw, end) && marks[i] === 0) node.classList.add('current-char');
  }
  const node = captionNodes[raw];
  if (node) {
    const top = node.offsetTop;
    if (currentLine !== top) {
      $('captions').scrollTop = Math.max(0, top - $('captions').offsetTop - captionSize * .5);
      currentLine = top;
    }
  }
}
function receiveText(text, final, start, end) {
  if (!session || !['recording', 'paused', 'saving'].includes(state)) return;
  $('heard').textContent = `${final ? '확정 인식' : '듣는 중'}: ${text}`;
  const result = align(normalized.value, normalize(text, parseAliases(session.aliases)).value, cursor);
  if (!final) { interimEnd = result?.end ?? cursor; paintCaptions(); return; }
  const event = { type: 'speech', text, start, at: end, marks: [], position: cursor, uncertain: !result };
  if (result) {
    for (const mark of result.marks) {
      const mapping = normalized.map[mark.index]; if (!mapping) continue;
      for (let i = mapping.start; i < mapping.end; i++) {
        // Keep earlier review candidates even if the presenter corrects them later.
        const status = marks[i] === 2 ? 2 : mark.state;
        marks[i] = status; event.marks.push([i, status]);
      }
    }
    cursor = Math.max(cursor, result.end); interimEnd = cursor;
    event.position = cursor; event.extra = result.extra;
    event.review = result.marks.some(m => m.state === 2) || !!result.extra;
    speechStatus(event.review ? '원문 차이 후보 · 녹화 후 실제 발화를 확인하세요.' : '원문을 따라가고 있어요 · 인식 일치 ✓');
  } else {
    speechStatus('원문 위치 확인 중 · 필요하면 아래에서 문장을 선택하세요.');
    predictionCooldown = clock.seconds() + 10; predictedSmoothed = null;
  }
  session.events.push(event); paintCaptions(); updateTiming();
}
function updateTiming() {
  const elapsed = ['recording', 'paused', 'saving'].includes(state) ? clock.seconds() : 0;
  const target = session && state !== 'idle' ? session.target : Number($('target').value) * 60 || 600;
  const t = timing(elapsed, cursor, normalized?.value.length || 0, target);
  $('elapsed').textContent = formatTime(elapsed); $('recommended').textContent = formatTime(t.recommended);
  $('remaining').textContent = formatTime(t.remaining);
  let predicted = t.predicted;
  if (elapsed < predictionCooldown) predicted = null;
  if (predicted !== null) {
    predictedSmoothed = predictedSmoothed === null ? predicted : .8 * predictedSmoothed + .2 * predicted;
    predicted = predictedSmoothed;
  }
  $('predicted').textContent = predicted === null ? '—' : formatTime(predicted);
  $('pace').textContent = !elapsed ? '발표 속도를 측정할 준비가 됐어요' : predicted === null ? '발표 속도 측정 중' : `${Math.abs(Math.round(t.difference))}초 ${t.difference > 1 ? '늦음' : t.difference < -1 ? '빠름' : '차이'} · 현재 속도 기준`;
  const axis = Math.max(MAX_SECONDS, Math.ceil((predicted || 0) / 60) * 60);
  $('targetBar').style.width = `${target / axis * 100}%`;
  $('predictedBar').style.width = `${(predicted || 0) / axis * 100}%`;
  const cutoff = predicted ? Math.min(100, target / predicted * 100) : 100;
  $('predictedBar').style.background = `linear-gradient(to right,#5d9c80 ${cutoff}%,#dc9b69 ${cutoff}%)`;
  $('elapsedMarker').style.left = `${elapsed / axis * 100}%`;
  $('recommendedMarker').style.left = `${t.recommended / axis * 100}%`;
  $('limitMarker').style.left = `${MAX_SECONDS / axis * 100}%`;
  $('axisMiddle').textContent = formatTime(axis / 2); $('axisMax').textContent = formatTime(axis);
  $('chart').setAttribute('aria-label', `목표 ${formatTime(target)}, 현재 ${formatTime(elapsed)}, 권장 도달 ${formatTime(t.recommended)}, 예상 ${formatTime(predicted)}`);
  if (state === 'recording') {
    for (const threshold of [840, 870]) if (elapsed >= threshold && !warned.has(threshold)) {
      warned.add(threshold); notice(`자동 종료까지 ${MAX_SECONDS - threshold}초 남았습니다. 최대 녹화 시간은 15분입니다.`);
    }
    if (elapsed >= MAX_SECONDS) finish('limit');
  }
}
async function preview() {
  if (!isSecureContext || !navigator.mediaDevices?.getUserMedia) throw new Error('카메라 사용에는 HTTPS 또는 localhost 접속이 필요합니다. README의 실행 방법을 확인하세요.');
  if (!globalThis.MediaRecorder) throw new Error('이 브라우저는 영상 녹화를 지원하지 않습니다. 최신 Safari 또는 Chrome에서 열어 주세요.');
  if (stream?.getTracks().every(t => t.readyState === 'live')) return;
  stream?.getTracks().forEach(t => t.stop());
  stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 1280 }, height: { ideal: 720 } }, audio: { echoCancellation: true, noiseSuppression: true } });
  $('camera').srcObject = stream; await $('camera').play(); $('cameraEmpty').hidden = true;
  for (const track of stream.getTracks()) track.addEventListener('ended', () => {
    if (['recording', 'paused'].includes(state)) { notice('카메라 또는 마이크 연결이 종료되어 녹화를 저장합니다.', true); finish('device-ended'); }
  });
  speechStatus('카메라와 마이크가 준비됐습니다. 연습 시작을 눌러 주세요.');
}
async function requestWakeLock() { try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* Not supported or denied. */ } }
function releaseCamera() { stream?.getTracks().forEach(t => t.stop()); stream = null; $('camera').srcObject = null; $('cameraEmpty').hidden = false; }
async function begin() {
  if (state !== 'idle') return;
  const config = settings();
  if (normalize(config.script).value.length < 3) return notice('발표할 원고를 입력해 주세요.', true);
  if (config.script.length > 40000) return notice('원고는 40,000자 이하로 입력해 주세요.', true);
  if (!(config.target >= 60 && config.target <= MAX_SECONDS)) return notice('목표 시간은 1~15분 사이로 입력해 주세요.', true);
  const mode = $('speechMode').value;
  if (mode !== 'off' && !$('consent').checked) return notice('음성 인식의 오디오 전송 안내를 확인해 주세요.', true);
  if (mode === 'server' && (!serverAvailable || !$('password').value)) return notice('서버 음성 인식 설정과 이용 비밀번호가 필요합니다.', true);
  setLocked(true); $('start').textContent = '준비 중…'; notice('');
  try {
    await preview(); prepareScript(); storeSettings();
    if (mode === 'server') {
      const check = await fetch('./api/authorize', { method: 'POST', headers: { 'X-App-Password': $('password').value } });
      if (!check.ok) throw new Error('서버 이용 비밀번호 또는 서버 연결을 확인해 주세요.');
    }
    speech = mode === 'off' ? null : new (mode === 'server' ? ServerSpeech : NativeSpeech)({ onText: receiveText, onStatus: speechStatus, time: () => clock.seconds(), password: $('password').value });
    if (speech) await speech.prepare(stream);
    const types = ['video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4'];
    const mimeType = types.find(type => MediaRecorder.isTypeSupported(type));
    recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), videoBitsPerSecond: 1400000, audioBitsPerSecond: 64000 });
    session = { id: crypto.randomUUID(), created: Date.now(), ...config, mode, mime: recorder.mimeType, duration: 0, pauses: [], events: [], position: 0, status: 'recording' };
    chunks = []; writes = Promise.resolve(); saveFailed = false; warned = new Set(); predictedSmoothed = null; predictionCooldown = 0;
    try { await saveSession(session); } catch { saveFailed = true; notice('브라우저 저장소를 사용할 수 없습니다. 종료 후 반드시 영상을 파일로 저장하세요.', true); }
    recorder.ondataavailable = e => {
      if (!e.data.size) return;
      const index = chunks.length; chunks.push(e.data);
      const snapshot = { ...session, duration: clock.seconds(), events: [...session.events], position: cursor };
      if (!saveFailed) writes = writes.then(async () => {
        await saveChunk(snapshot.id, index, e.data); await saveSession(snapshot);
      }).catch(() => { saveFailed = true; notice('기기 저장 공간이 부족하거나 저장이 중단됐습니다. 종료 후 영상 저장 버튼을 사용하세요.', true); });
    };
    recorder.onerror = () => { notice('녹화 오류가 발생했습니다. 보존된 영상을 저장합니다.', true); finish('recorder-error'); };
    setState('countdown'); $('countdown').hidden = false;
    for (let n = 3; n >= 1; n--) { $('countdown').textContent = n; await new Promise(resolve => setTimeout(resolve, 1000)); }
    if (document.hidden) throw new Error('화면을 다시 연 뒤 연습을 시작해 주세요.');
    $('countdown').hidden = true; clock = new SessionClock(); clock.start();
    recorder.start(2000); setState('recording');
    speech?.start(); if (!speech) speechStatus('녹화 전용 · 원문 위치를 직접 선택할 수 있습니다.');
    requestWakeLock(); interval = setInterval(updateTiming, 250); updateTiming();
  } catch (error) {
    $('countdown').hidden = true;
    await speech?.stop().catch(() => {}); speech = null;
    if (session && !chunks.length) { try { await deleteSession(session.id); } catch {} }
    session = null;
    releaseCamera(); setState('idle');
    notice(error.name === 'NotAllowedError' ? '카메라·마이크 권한을 허용한 뒤 다시 시도하세요.' : error.message, true);
  } finally { $('start').innerHTML = '<span class="record-dot"></span> 연습 시작'; if (state === 'idle') setLocked(false); }
}
function pauseResume() {
  if (state === 'recording') {
    clock.pause(); recorder.pause(); speech?.pause();
    session.pauses.push({ at: clock.seconds(), wallStart: Date.now() });
    setState('paused'); speechStatus('일시정지 · 녹화 시간에 포함되지 않습니다.');
  } else if (state === 'paused') {
    if (clock.seconds() >= MAX_SECONDS) return finish('limit');
    session.pauses.at(-1).wallEnd = Date.now();
    recorder.resume(); clock.resume(); setState('recording'); speech?.resume(); requestWakeLock();
  }
  updateTiming();
}
async function finish(reason = 'user') {
  if (!['recording', 'paused'].includes(state)) return;
  clock.pause(); clearInterval(interval); setState('saving');
  session.duration = clock.seconds(); session.position = cursor; session.reason = reason;
  session.status = 'complete';
  $('recordState').append(document.createTextNode(' · 분석 마무리'));
  const stopped = new Promise(resolve => {
    if (!recorder || recorder.state === 'inactive') return resolve();
    recorder.addEventListener('stop', resolve, { once: true }); recorder.stop();
  });
  const speechDone = speech?.stop().catch(() => {});
  await stopped; releaseCamera(); await wakeLock?.release().catch(() => {}); wakeLock = null;
  await speechDone; speech = null;
  session.position = cursor;
  await writes;
  if (!saveFailed) try { await saveSession(session); } catch { saveFailed = true; }
  const blob = new Blob(chunks, { type: session.mime });
  if (saveFailed) memorySessions.set(session.id, { data: session, blob });
  const saved = session; session = null; setState('idle');
  const message = reason === 'limit' ? '최대 녹화 시간 15분에 도달하여 종료했습니다.' : '연습을 마쳤습니다.';
  notice(`${message} ${saveFailed ? '브라우저 저장에 실패했습니다. 아래에서 영상을 파일로 저장하세요.' : '이 기기에 저장했습니다. 중요한 영상은 파일로 내보내세요.'}`, saveFailed);
  speechStatus('연습 완료 · 아래 기록에서 다시 볼 수 있어요.');
  await refreshLibrary(); await openReview(saved, blob);
}
async function refreshLibrary() {
  let all;
  try { all = await listSessions(); } catch { all = []; }
  const combined = new Map(all.map(s => [s.id, s]));
  for (const [id, entry] of memorySessions) combined.set(id, entry.data);
  const sessions = [...combined.values()].sort((a,b) => b.created - a.created);
  if (!sessions.length) { $('sessionList').innerHTML = emptyLibrary; return; }
  $('sessionList').replaceChildren();
  for (const item of sessions) {
    const card = document.createElement('article'); card.className = 'session-card';
    const info = document.createElement('div'), title = document.createElement('h3'), meta = document.createElement('p');
    title.textContent = item.title || '발표 연습';
    meta.textContent = `${new Date(item.created).toLocaleString('ko-KR')} · ${formatTime(item.duration)} / 목표 ${formatTime(item.target)}${item.pauses.length ? ' · 일시정지 포함' : ''}${item.status !== 'complete' ? ' · 중단된 녹화 복구' : ''}`;
    info.append(title, meta);
    const actions = document.createElement('div');
    const play = document.createElement('button'); play.className = 'secondary'; play.textContent = '다시 보기·저장';
    play.onclick = async () => { try {
      const blob = memorySessions.get(item.id)?.blob || new Blob(await loadChunks(item.id), { type: item.mime });
      if (!blob.size) throw new Error('저장된 영상 조각이 없습니다. 녹화 시작 전에 중단된 기록일 수 있습니다.');
      await openReview(item, blob);
    } catch (error) { notice(error.message, true); } };
    const remove = document.createElement('button'); remove.className = 'text-button'; remove.textContent = '삭제';
    remove.onclick = async () => {
      if (!confirm('이 기기에서 영상과 연습 기록을 삭제할까요? 저장한 외부 파일은 유지됩니다.')) return;
      try { await deleteSession(item.id); memorySessions.delete(item.id); refreshLibrary(); } catch { notice('기록 삭제에 실패했습니다.', true); }
    };
    actions.append(play, remove); card.append(info, actions); $('sessionList').append(card);
  }
}
function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob), link = document.createElement('a');
  link.href = url; link.download = filename; document.body.append(link); link.click(); link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
function videoFilename() { return `BRIDGE-${new Date(reviewSession.created).toISOString().replace(/[:.]/g, '-')}.${reviewBlob.type.includes('mp4') ? 'mp4' : 'webm'}`; }
async function openReview(item, blob) {
  if (reviewURL) URL.revokeObjectURL(reviewURL);
  reviewSession = item; reviewBlob = blob; reviewURL = URL.createObjectURL(blob);
  $('playback').src = reviewURL; $('reviewTitle').textContent = item.title || '연습 돌아보기';
  const total = normalize(item.script, parseAliases(item.aliases)).value.length;
  const progress = total ? Math.min(100, Math.round((item.position || 0) / total * 100)) : 0;
  $('reviewInfo').textContent = `녹화 ${formatTime(item.duration)} · 목표 ${formatTime(item.target)} · 원문 도달 ${progress}% (정확도 점수 아님) · ${item.pauses.length ? '일시정지 포함 연습' : '연속 연습'} · 자막은 앱 재생 화면에서 표시되며 영상 파일에는 합성되지 않습니다.`;
  $('reviewStatus').textContent = item.status !== 'complete' ? '중단 당시의 영상 조각입니다. 마지막 구간이 누락되거나 재생이 제한될 수 있습니다.' : '영상과 대조 기록을 각각 파일로 저장할 수 있습니다.';
  $('reviewEvents').replaceChildren();
  const questionable = item.events.filter(e => e.type === 'speech' && (e.review || e.uncertain));
  for (const event of questionable) {
    const button = document.createElement('button');
    const render = () => { button.textContent = `${formatTime(event.start)} · ${event.verified === 'recognition' ? '인식 오류로 확인됨' : event.verified === 'speech' ? '발화 차이로 확인됨' : event.uncertain ? '위치 확인 필요' : '원문 차이 후보'} — ${event.text}`; };
    render();
    button.onclick = () => { $('playback').currentTime = Math.max(0, event.start - 1); $('playback').play().catch(() => {}); };
    const box = document.createElement('div'); box.append(button);
    const select = document.createElement('select'); select.setAttribute('aria-label', '실제 발화 검토 결과');
    for (const [value, label] of [['', '검토 전'], ['recognition', '음성 인식 오류'], ['speech', '실제 발화 차이']]) { const option = document.createElement('option'); option.value = value; option.textContent = label; select.append(option); }
    select.value = event.verified || '';
    select.onchange = async () => { event.verified = select.value; render(); try { await saveSession(item); } catch { $('reviewStatus').textContent = '검토 결과를 브라우저에 저장하지 못했습니다. 대조 기록을 파일로 저장하세요.'; } };
    box.append(select); $('reviewEvents').append(box);
  }
  if (!questionable.length) $('reviewEvents').textContent = item.mode === 'off' ? '녹화 전용으로 진행하여 자동 대조 기록이 없습니다.' : '현재 검출된 검토 후보가 없습니다. 인식하지 못한 발화가 있을 수 있으므로 영상을 확인하세요.';
  $('share').hidden = !navigator.canShare;
  $('reviewDialog').showModal(); paintReview(0);
}
function paintReview(time) {
  const item = reviewSession; if (!item) return;
  const states = new Uint8Array(item.script.length), norm = normalize(item.script, parseAliases(item.aliases));
  let position = 0;
  for (const event of item.events) if (event.at <= time) {
    for (const [index, value] of event.marks || []) states[index] = value;
    position = event.position;
  }
  const raw = norm.map[Math.min(position, norm.map.length - 1)]?.start || 0;
  let from = item.script.lastIndexOf('\n', Math.max(0, raw - 1)) + 1;
  let to = item.script.indexOf('\n', raw); if (to < 0) to = item.script.length;
  if (to - from > 350) { from = Math.max(from, raw - 50); to = Math.min(to, raw + 180); }
  $('reviewCaption').replaceChildren();
  for (let i = from; i < to; i++) { const span = document.createElement('span'); span.textContent = item.script[i]; span.className = states[i] === 1 ? 'matched' : states[i] === 2 ? 'review-needed' : ''; $('reviewCaption').append(span); }
}

$('preview').onclick = async () => { $('preview').disabled = true; try { await preview(); } catch (error) { notice(error.message, true); } finally { $('preview').disabled = false; } };
$('start').onclick = begin; $('pause').onclick = pauseResume; $('stop').onclick = () => finish('user');
$('speechMode').onchange = modeChanged;
$('mirror').onchange = () => $('camera').classList.toggle('mirrored', $('mirror').checked);
$('camera').classList.add('mirrored');
$('focus').onclick = () => { const focused = document.body.classList.toggle('focused'); $('focus').textContent = focused ? '전체 화면 구성' : '집중 화면'; };
$('fontDown').onclick = () => { captionSize = Math.max(16, captionSize - 2); document.documentElement.style.setProperty('--caption', `${captionSize}px`); };
$('fontUp').onclick = () => { captionSize = Math.min(40, captionSize + 2); document.documentElement.style.setProperty('--caption', `${captionSize}px`); };
for (const id of ['script', 'target', 'aliases', 'title']) $(id).addEventListener('input', () => { if (state === 'idle') { storeSettings(); prepareScript(); } });
$('sample').onclick = async () => {
  if ($('script').value.trim() && !confirm('현재 입력 원고를 제공된 발표문으로 바꿀까요?')) return;
  try { const response = await fetch('./sample.txt'); if (!response.ok) throw new Error(); $('script').value = await response.text(); storeSettings(); prepareScript(); notice('제공하신 발표문을 불러왔습니다. 구분선·글머리표는 제외했습니다. 미정 관리번호와 기관명, 숫자 발음은 연습 전에 확인하세요.'); }
  catch { notice('발표문을 불러오지 못했습니다. 원고를 직접 붙여넣어 주세요.', true); }
};
$('refresh').onclick = refreshLibrary;
$('closeReview').onclick = () => $('reviewDialog').close();
$('reviewDialog').addEventListener('close', () => { $('playback').pause(); $('playback').removeAttribute('src'); $('playback').load(); if (reviewURL) URL.revokeObjectURL(reviewURL); reviewURL = null; });
$('playback').ontimeupdate = () => paintReview($('playback').currentTime);
$('download').onclick = () => { downloadBlob(reviewBlob, videoFilename()); $('reviewStatus').textContent = '영상 파일 저장을 요청했습니다. 기기의 다운로드 또는 파일 앱을 확인하세요.'; };
$('downloadReport').onclick = () => downloadBlob(new Blob([JSON.stringify(reviewSession, null, 2)], { type: 'application/json' }), videoFilename().replace(/\.[^.]+$/, '-report.json'));
$('share').onclick = async () => {
  const file = new File([reviewBlob], videoFilename(), { type: reviewBlob.type });
  if (!navigator.canShare?.({ files: [file] })) { $('reviewStatus').textContent = '이 기기에서는 해당 영상 공유를 지원하지 않습니다. 영상 저장을 사용하세요.'; return; }
  try { await navigator.share({ files: [file], title: reviewSession.title }); } catch (error) { if (error.name !== 'AbortError') $('reviewStatus').textContent = '공유하지 못했습니다. 영상 저장을 사용하세요.'; }
};
document.addEventListener('visibilitychange', () => {
  if (document.hidden && state === 'recording') { pauseResume(); notice('다른 앱으로 이동하여 일시정지했습니다. 돌아온 뒤 다시 시작을 눌러 주세요.'); }
  if (!document.hidden && state === 'recording') requestWakeLock();
});
window.addEventListener('beforeunload', e => { if (state !== 'idle' || (saveFailed && memorySessions.size)) { e.preventDefault(); e.returnValue = ''; } });
window.addEventListener('pagehide', () => { releaseCamera(); });

$('aliases').value = DEFAULT_ALIASES;
try { const saved = JSON.parse(localStorage.getItem('bridge-settings') || 'null'); if (saved) { $('title').value = saved.title; $('script').value = saved.script; $('target').value = saved.target / 60; $('aliases').value = saved.aliases || DEFAULT_ALIASES; } } catch {}
prepareScript(); modeChanged(); refreshLibrary();
fetch('./api/config').then(r => r.ok ? r.json() : null).then(config => { serverAvailable = !!config?.serverSpeech; modeChanged(); }).catch(() => {});
if (!isSecureContext) notice('휴대폰·태블릿에서 카메라를 사용하려면 HTTPS 주소로 접속해 주세요.', true);
