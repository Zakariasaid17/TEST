// Lightweight frontend logic checks without requiring an internet-enabled Chromium.
const fs = require('node:fs');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const source = fs.readFileSync(__dirname + '/../static/player.js', 'utf8');

function node() {
  return {
    textContent: '', value: '', disabled: false, className: '', style: {},
    children: [], handlers: {},
    addEventListener(k, f) { this.handlers[k] = f; },
    append(...x) { this.children.push(...x); },
    appendChild(x) { this.children.push(x); },
    prepend(...x) { this.children.unshift(...x); },
    removeAttribute() {},
    pause() {}, load() {},
    canPlayType() { return 'maybe'; },
    readyState: 2, playCount: 0, play() { this.playCount++; this.onplaying?.(); return Promise.resolve(); },
  };
}
const elements = Object.fromEntries(
  ['events', 'status', 'video', 'candidates', 'fingerprint', 'tokenFingerprint',
   'hasToken', 'stop', 'start', 'playerStatus', 'engineUsed', 'playbackStage', 'sid', 'found', 'blocked',
   'url', 'form', 'demo', 'manualForm', 'manualUrl', 'copyDiagnostics'].map(x => [x, node()])
);

const instantiated = [];
class MockHls {
  static isSupported() { return true; }
  static Events = { MEDIA_ATTACHED:'attached', MANIFEST_LOADED:'manifestLoaded', MANIFEST_PARSED:'parsed', FRAG_BUFFERED:'buffered', ERROR:'error' };
  static ErrorTypes = { MEDIA_ERROR: 'mediaError' };
  constructor() { instantiated.push(this); this.events = {}; this.levels = [{ height:432 }]; }
  on(event, callback) { this.events[event] = callback; }
  attachMedia() { this.events.attached(); }
  loadSource(url) { this.url = url; this.events.manifestLoaded(); this.events.parsed('parsed', {levels: this.levels}); }
  destroy() {}
  recoverMediaError() {}
}
const sandbox = {
  document: { getElementById: id => elements[id], createElement: () => node() },
  window: { Hls: MockHls }, Hls: MockHls,
  location: { protocol: 'https:', origin: 'https://example.app' },
  setTimeout(fn) { return 1; }, clearTimeout() {},
  fetch() { throw Error('No network intended in unit test'); },
  navigator: { clipboard: { writeText() {} } },
  console, URL, Date, Promise,
};
vm.createContext(sandbox);
vm.runInContext(source, sandbox);

// Regression: Safari reports native support, but HLS.js must win by default.
vm.runInContext("manualPlay('https://media.example/live.m3u8?token=abc')", sandbox);
assert.equal(instantiated.length, 1, 'HLS.js should initialize before native HLS');
assert.equal(instantiated[0].url, 'https://media.example/live.m3u8?token=abc');
assert.equal(elements.video.playCount, 0, 'Must not call play before media is buffered');
instantiated[0].events.buffered();
assert.match(elements.playerStatus.textContent, /CONFIRMED/);

// A successful master playlist should precede a merely observed media URL.
vm.runInContext(`
  candidates = [
    {httpStatus:null,kind:'unknown'},
    {httpStatus:200,kind:'master'},
    {httpStatus:404,kind:'master'}
  ];
  attempted = new Set();
`, sandbox);
assert.deepEqual([...vm.runInContext('rankedUntried()', sandbox)], [1,0,2]);

// HLS.js is used again without a native-engine dropdown.
vm.runInContext('candidates = []', sandbox);
vm.runInContext("manualPlay('https://media.example/second.m3u8')", sandbox);
assert.equal(instantiated.length, 2);
assert.match(elements.engineUsed.textContent, /HLS.js/);
instantiated[1].events.buffered();
console.log('Frontend tests passed: HLS.js priority, successful master ranking, buffered playback.');
