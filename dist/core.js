export const MAX_SECONDS = 900;
export const DEFAULT_ALIASES = 'AI=에이아이\nBRIDGE=브리지\nME=미\nWE=위';

export function formatTime(seconds) {
  if (!Number.isFinite(seconds)) return '—';
  const n = Math.max(0, Math.round(seconds));
  return `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`;
}
export function timing(elapsed, position, total, target) {
  const progress = total ? Math.max(0, Math.min(1, position / total)) : 0;
  const recommended = target * progress;
  return { progress, recommended, difference: elapsed - recommended,
    predicted: elapsed >= 30 && progress >= .05 ? elapsed / progress : null,
    remaining: Math.max(0, MAX_SECONDS - elapsed) };
}
export function parseAliases(text = '') {
  return text.split('\n').map(line => line.split('=').map(s => s.trim()))
    .filter(pair => pair.length === 2 && pair[0] && pair[1])
    .sort((a, b) => b[0].length - a[0].length);
}
// Canonical text never changes. The map links comparison characters to original offsets.
export function normalize(text, aliases = []) {
  let value = '', map = [];
  const lower = text.toLocaleLowerCase('ko');
  for (let i = 0; i < text.length;) {
    const alias = aliases.find(([from]) => lower.startsWith(from.toLocaleLowerCase('ko'), i));
    if (alias) {
      const out = alias[1].toLocaleLowerCase('ko').replace(/[^\p{L}\p{N}]/gu, '');
      for (let j = 0; j < out.length; j++) {
        value += out[j];
        map.push({ start: i, end: i + alias[0].length });
      }
      i += alias[0].length;
    } else {
      if (/[\p{L}\p{N}]/u.test(text[i])) { value += lower[i]; map.push({ start: i, end: i + 1 }); }
      i++;
    }
  }
  return { value, map };
}

// Bounded semi-global edit alignment. Differences are review candidates, not verdicts.
export function align(reference, spoken, position = 0) {
  if (spoken.length < 2 || !reference.length) return null;
  spoken = spoken.slice(0, 400);
  const begin = Math.max(0, position - 36);
  const ref = reference.slice(begin, Math.min(reference.length, position + Math.max(180, spoken.length + 60)));
  const m = spoken.length, n = ref.length;
  const matrix = Array.from({ length: m + 1 }, () => new Float64Array(n + 1));
  for (let j = 0; j <= n; j++) matrix[0][j] = Math.abs(begin + j - position) * .10;
  for (let i = 1; i <= m; i++) {
    matrix[i][0] = matrix[i - 1][0] + 1;
    for (let j = 1; j <= n; j++) matrix[i][j] = Math.min(
      matrix[i - 1][j - 1] + (spoken[i - 1] === ref[j - 1] ? 0 : 1),
      matrix[i - 1][j] + 1, matrix[i][j - 1] + 1);
  }
  let end = 0;
  for (let j = 1; j <= n; j++) if (matrix[m][j] < matrix[m][end]) end = j;
  let i = m, j = end, matches = 0;
  const marks = [], extras = [];
  while (i > 0) {
    if (j > 0 && Math.abs(matrix[i][j] - matrix[i - 1][j - 1] - (spoken[i - 1] === ref[j - 1] ? 0 : 1)) < .001) {
      const same = spoken[i - 1] === ref[j - 1];
      if (same) matches++;
      marks.push({ index: begin + j - 1, state: same ? 1 : 2 }); i--; j--;
    } else if (j > 0 && Math.abs(matrix[i][j] - matrix[i][j - 1] - 1) < .001) {
      marks.push({ index: begin + j - 1, state: 2 }); j--;
    } else { extras.push(spoken[i - 1]); i--; }
  }
  if (matches < Math.min(3, m) || matches / m < .55 || matrix[m][end] / m > .7) return null;
  for (let k = position; k < begin + j; k++) marks.push({ index: k, state: 2 });
  return { start: begin + j, end: begin + end, marks: marks.reverse(),
    extra: extras.reverse().join(''), confidence: matches / Math.max(m, end - j) };
}

export class SessionClock {
  constructor(now = () => performance.now()) { this.now = now; this.accumulated = 0; this.anchor = null; }
  start() { this.accumulated = 0; this.anchor = this.now(); }
  pause() { if (this.anchor !== null) { this.accumulated += (this.now() - this.anchor) / 1000; this.anchor = null; } }
  resume() { if (this.anchor === null) this.anchor = this.now(); }
  seconds() { return Math.min(MAX_SECONDS, Math.max(0, this.accumulated + (this.anchor === null ? 0 : (this.now() - this.anchor) / 1000))); }
}

export function wavBlob(samples, sampleRate) {
  const data = new ArrayBuffer(44 + samples.length * 2), view = new DataView(data);
  const str = (offset, s) => [...s].forEach((c, k) => view.setUint8(offset + k, c.charCodeAt(0)));
  str(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); str(8, 'WAVE'); str(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true); view.setUint16(34, 16, true); str(36, 'data');
  view.setUint32(40, samples.length * 2, true);
  for (let k = 0; k < samples.length; k++) view.setInt16(44 + k * 2, Math.max(-1, Math.min(1, samples[k])) * 32767, true);
  return new Blob([data], { type: 'audio/wav' });
}
