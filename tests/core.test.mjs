import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, parseAliases, align, timing, SessionClock, wavBlob, MAX_SECONDS } from '../dist/core.js';

test('띄어쓰기·문장부호만 제외하고 조사와 어미는 유지', () => {
  assert.equal(normalize('안녕하십니까? 관리번호 1번입니다.').value, '안녕하십니까관리번호1번입니다');
  assert.notEqual(normalize('학생은').value, normalize('학생이').value);
});
test('발음 대응은 원문 위치를 보존', () => {
  const original = 'AI로 연결합니다.';
  const out = normalize(original, parseAliases('AI=에이아이'));
  assert.equal(out.value, '에이아이로연결합니다');
  assert.deepEqual(out.map[3], { start: 0, end: 2 });
  assert.equal(original, 'AI로 연결합니다.');
});
test('일치 발화와 다음 구간 이어 읽기', () => {
  const ref = normalize('안녕하십니까 관리번호 일번입니다').value;
  const first = align(ref, '안녕하십니까', 0);
  assert.equal(first.end, 6); assert.ok(first.marks.every(m => m.state === 1));
  const next = align(ref, '관리번호일번입니다', first.end);
  assert.equal(next.end, ref.length);
});
test('조사 변경과 문장 내 누락을 검토 대상으로 검출', () => {
  const ref = '학생들은음악시간에노래를합니다';
  const changed = align(ref, '학생들이음악시간에노래를합니다', 0);
  assert.ok(changed.marks.some(m => m.state === 2));
  const omitted = align(ref, '학생들은노래를합니다', 0);
  assert.ok(omitted.marks.some(m => m.state === 2));
});
test('관계없는 발화는 진행시키지 않음', () => {
  assert.equal(align('안녕하십니까관리번호일번입니다', '오늘점심김치찌개먹어요', 0), null);
});
test('반복 발화는 같은 위치에 대응', () => {
  const ref = '안녕하십니까관리번호일번입니다';
  const first = align(ref, '안녕하십니까', 0);
  const again = align(ref, '안녕하십니까', first.end);
  assert.equal(again.end, first.end);
});
test('시간 비교와 예측 시작 조건', () => {
  const t = timing(200, 30, 100, 600);
  assert.equal(t.recommended, 180); assert.equal(t.difference, 20);
  assert.ok(Math.abs(t.predicted - 666.6666667) < .001);
  assert.equal(timing(20, 10, 100, 600).predicted, null);
  assert.equal(timing(40, 1, 100, 600).predicted, null);
  assert.equal(timing(500, 0, 100, 600).predicted, null);
});
test('15분 한도와 일시정지 시간 제외', () => {
  let now = 0; const clock = new SessionClock(() => now);
  clock.start(); now = 600000; assert.equal(clock.seconds(), 600);
  clock.pause(); now += 120000; assert.equal(clock.seconds(), 600);
  clock.resume(); now += 300000; assert.equal(clock.seconds(), MAX_SECONDS);
  now += 10000; assert.equal(clock.seconds(), MAX_SECONDS);
});
test('WAV는 독립 디코딩 가능한 PCM 헤더 포함', async () => {
  const blob = wavBlob(new Float32Array([0, 1, -1]), 16000);
  const data = new DataView(await blob.arrayBuffer());
  assert.equal(blob.size, 50); assert.equal(data.getUint32(24, true), 16000);
  assert.equal(data.getInt16(46, true), 32767); assert.equal(data.getInt16(48, true), -32767);
});
