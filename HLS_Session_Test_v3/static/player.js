'use strict';
const $ = (id) => document.getElementById(id);
let sessionId = null, es = null, hls = null, currentIndex = -1, watchdog = null;
let candidates = [], attempted = new Set(), inspectionDone = false, isPlaying = false;
let errorHistory = [], startTimer = null, generation = 0, activeManualUrl = null;

function log(messageText) {
  const p = document.createElement('p');
  p.textContent = new Date().toLocaleTimeString() + ' — ' + messageText;
  const el = $('events');
  if (el.textContent === 'No events yet.') el.textContent = '';
  el.prepend(p);
}
function setStatus(s) { $('status').textContent = s; log(s); }
function stopWatch() {
  if (watchdog !== null) { clearTimeout(watchdog); watchdog = null; }
}
function resetMedia() {
  stopWatch();
  if (hls) { hls.destroy(); hls = null; }
  const v = $('video');
  v.onplaying = null;
  v.onerror = null;
  v.onloadedmetadata = null;
  v.onwaiting = null;
  v.onstalled = null;
  v.pause();
  v.removeAttribute('src');
  v.load();
}
async function stopTest() {
  if (startTimer !== null) { clearTimeout(startTimer); startTimer = null; }
  generation++;
  if (es) { es.close(); es = null; }
  resetMedia();
  const id = sessionId;
  sessionId = null;
  if (id) {
    try { await fetch('/api/tests/' + encodeURIComponent(id), { method: 'DELETE' }); }
    catch (_) { /* session may have expired */ }
  }
  $('stop').disabled = true;
  $('start').disabled = false;
}
function resolvePlaybackUrl(url) {
  const u = new URL(url);
  // Only remap the bundled sample, never third-party URLs or signed credentials.
  if (u.hostname === '127.0.0.1' && /^\/mock\/video\//.test(u.pathname)) {
    return location.origin + u.pathname + u.search;
  }
  return url;
}
function formatHlsError(data) {
  const details = [data.details || data.type || 'Unknown HLS error'];
  if (data.response && typeof data.response.code === 'number') {
    details.push('HTTP ' + data.response.code);
  }
  if (data.type === 'networkError' && (!data.response || data.response.code === 0)) {
    details.push('Possible CORS, origin, or network restriction');
  }
  return details.join(' — ');
}
function displayCandidates() {
  const box = $('candidates');
  box.textContent = '';
  if (!candidates.length) {
    const p = document.createElement('p'); p.textContent = 'No playlists detected yet.';
    box.appendChild(p); return;
  }
  candidates.forEach((record, index) => {
    const c = record.candidate;
    const button = document.createElement('button');
    button.className = 'candidate' + (index === currentIndex ? ' active' : '');
    button.type = 'button';
    const title = document.createElement('strong');
    title.textContent = `Candidate ${index + 1}` + (record.kind !== 'unknown' ? ` · ${record.kind}` : '');
    const path = document.createElement('small');
    path.textContent = (c.host || 'unknown') + (c.path || '');
    const meta = document.createElement('small');
    const http = record.httpStatus === null ? 'response pending' : 'HTTP ' + record.httpStatus;
    meta.textContent = http + ' | URL #' + c.urlFingerprint + ' | token #' + (c.tokenFingerprint || 'none');
    button.append(title, path, meta);
    button.addEventListener('click', () => attempt(index, true));
    box.append(button);
  });
}
function displayFingerprint(record) {
  const c = record.candidate;
  $('fingerprint').textContent = c.urlFingerprint;
  $('tokenFingerprint').textContent = c.tokenFingerprint || '(no recognized token parameter)';
  $('hasToken').textContent = c.tokenPresent ? 'Yes' : (c.queryPresent ? 'Query present, parameter not recognized' : 'No');
}
function rankedUntried() {
  const indices = candidates.map((_, i) => i).filter(i => !attempted.has(i));
  const rank = (c) => {
    let score = 0;
    if (c.httpStatus >= 200 && c.httpStatus < 300) score += 100;
    if (c.kind === 'master') score += 30;
    if (c.kind === 'media') score += 15;
    if (c.httpStatus >= 400) score -= 100;
    return score;
  };
  return indices.sort((a, b) => rank(candidates[b]) - rank(candidates[a]) || a - b);
}
function autoNext() {
  if (isPlaying || currentIndex >= 0 || activeManualUrl) return;
  const untried = rankedUntried();
  if (untried.length) { attempt(untried[0], false); return; }
  $('playerStatus').textContent = inspectionDone
    ? 'All detected candidates failed. See exact errors below. Try the same URL in Advanced direct test to isolate origin/player issues.'
    : 'No playable candidate yet; waiting for more HLS responses…';
}
function scheduleAuto() {
  if (isPlaying || currentIndex >= 0 || activeManualUrl || startTimer !== null || !candidates.length) return;
  // A request can be observed before its response is known. Wait briefly and
  // prioritize successful master playlists rather than racing the first request.
  startTimer = setTimeout(() => { startTimer = null; autoNext(); }, inspectionDone ? 0 : 2200);
}
function candidateFailed(reason, index, attemptGeneration) {
  if (generation !== attemptGeneration || isPlaying || currentIndex !== index) return;
  const msg = `Candidate ${index + 1}: ${reason}`;
  errorHistory.push(msg);
  log(msg);
  generation++;
  resetMedia();
  currentIndex = -1;
  $('playerStatus').textContent = msg;
  displayCandidates();
  scheduleAuto();
}
function startPlayback(url, failure, onSuccess) {
  const v = $('video');
  let recoveryCount = 0;
  v.muted = true;
  v.onplaying = onSuccess;
  v.onerror = () => failure('HTML5 video error ' + (v.error ? `(code ${v.error.code})` : ''));
  v.onwaiting = () => { /* normal on live sources */ };
  v.onstalled = () => log('Video is waiting for more media data.');
  stopWatch();
  watchdog = setTimeout(() => failure('No playable video after 35 seconds (inspect the HLS errors)'), 35000);

  if (location.protocol === 'https:' && url.startsWith('http:')) {
    failure('Mixed content: HTTPS page cannot load insecure HTTP media.');
    return;
  }
  const wantsNative = $('engine').value === 'native';
  const nativeAvailable = Boolean(v.canPlayType('application/vnd.apple.mpegurl'));
  const hlsjsAvailable = Boolean(window.Hls && Hls.isSupported());

  const requestPlay = () => {
    v.play().catch(err => {
      if (err.name === 'NotAllowedError') {
        stopWatch();
        $('playerStatus').textContent = 'Autoplay blocked. Press Play in the video controls to continue.';
        log('Autoplay requires a user gesture; video source may still work.');
      } else if (err.name !== 'AbortError') {
        failure('Browser play() refused: ' + err.name + ' — ' + err.message);
      }
    });
  };

  try {
    // Prefer the same Hls.js MSE playback path as the successful official demo.
    // Safari native HLS is only the fallback, or an explicit diagnostic choice.
    if (hlsjsAvailable && !wantsNative) {
      log('Playback engine: HLS.js (MSE)');
      hls = new Hls({ enableWorker: true });
      hls.on(Hls.Events.MEDIA_ATTACHED, () => hls.loadSource(url));
      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        log('HLS manifest parsed (' + hls.levels.length + ' video level(s)).');
        requestPlay();
      });
      hls.on(Hls.Events.ERROR, (_event, data) => {
        const reason = formatHlsError(data);
        if (!data.fatal) { log('HLS warning: ' + reason); return; }
        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && recoveryCount < 1) {
          recoveryCount++;
          log('HLS media error: attempting one recovery.');
          hls.recoverMediaError();
          return;
        }
        failure('HLS.js: ' + reason);
      });
      hls.attachMedia(v);
    } else if (nativeAvailable) {
      log('Playback engine: native HLS');
      v.src = url;
      v.onloadedmetadata = () => requestPlay();
      v.load();
      requestPlay();
    } else {
      failure(wantsNative
        ? 'Native HLS unavailable on this browser. Select HLS.js first.'
        : 'HLS.js unavailable and this browser has no native HLS.');
    }
  } catch (err) {
    failure('Initialization error: ' + err.message);
  }
}
function attempt(index, manual) {
  if (index < 0 || index >= candidates.length) return;
  if (startTimer !== null) { clearTimeout(startTimer); startTimer = null; }
  activeManualUrl = null;
  generation++;
  const mine = generation;
  resetMedia();
  isPlaying = false;
  currentIndex = index;
  attempted.add(index);
  displayCandidates();
  displayFingerprint(candidates[index]);
  const url = resolvePlaybackUrl(candidates[index].url);
  $('playerStatus').textContent = `Loading candidate ${index + 1}/${candidates.length} (${candidates[index].kind})…`;
  const failure = (msg) => candidateFailed(msg, index, mine);
  const onSuccess = () => {
    if (generation !== mine || currentIndex !== index) return;
    isPlaying = true;
    stopWatch();
    $('playerStatus').textContent = `PLAYING: candidate ${index + 1}, using ${window.Hls && Hls.isSupported() && $('engine').value !== 'native' ? 'HLS.js' : 'native HLS'}.`;
    log('Playback CONFIRMED on candidate ' + (index + 1));
  };
  startPlayback(url, failure, onSuccess);
}
function manualPlay(url) {
  generation++;
  const mine = generation;
  if (startTimer !== null) { clearTimeout(startTimer); startTimer = null; }
  resetMedia();
  isPlaying = false;
  currentIndex = -1;
  activeManualUrl = url;
  displayCandidates();
  $('playerStatus').textContent = 'Testing manually provided HLS URL in THIS website (not sent to backend).';
  const fail = (reason) => {
    if (generation !== mine) return;
    errorHistory.push('Direct test: ' + reason);
    log('Direct test failed: ' + reason);
    resetMedia();
    $('playerStatus').textContent = 'Direct test failed: ' + reason;
  };
  startPlayback(url, fail, () => {
    if (generation !== mine) return;
    isPlaying = true;
    stopWatch();
    $('playerStatus').textContent = 'Direct URL playback CONFIRMED in this website.';
    log('Direct URL playback CONFIRMED.');
  });
}
async function runTest(url) {
  await stopTest();
  candidates = [];
  attempted = new Set();
  currentIndex = -1;
  inspectionDone = false;
  isPlaying = false;
  activeManualUrl = null;
  errorHistory = [];
  $('sid').textContent = '—';
  $('found').textContent = '0';
  $('fingerprint').textContent = '—';
  $('tokenFingerprint').textContent = '—';
  $('hasToken').textContent = '—';
  $('blocked').textContent = '0 / 0 / 0';
  $('events').textContent = '';
  displayCandidates();
  $('start').disabled = true;
  $('status').textContent = 'Starting…';
  $('playerStatus').textContent = 'Waiting for HLS detection…';
  try {
    const response = await fetch('/api/tests', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url })
    });
    const data = await response.json();
    if (!response.ok) throw Error(data.detail || 'Could not start test.');
    sessionId = data.id;
    $('sid').textContent = sessionId.slice(0, 9) + '…';
    $('stop').disabled = false;
    es = new EventSource('/api/tests/' + encodeURIComponent(sessionId) + '/events');
    es.addEventListener('status', (e) => setStatus(JSON.parse(e.data).status));
    es.addEventListener('notice', (e) => log(JSON.parse(e.data).message));
    es.addEventListener('error', (e) => {
      if (e.data) log(JSON.parse(e.data).message || 'Detection error');
      else log('Event stream connection interrupted');
    });
    es.addEventListener('filters', (e) => {
      const d = JSON.parse(e.data);
      $('blocked').textContent = [d.popups, d.ads, d.redirects].join(' / ');
    });
    es.addEventListener('candidate', (e) => {
      const d = JSON.parse(e.data);
      if (candidates.some(x => x.candidate.urlFingerprint === d.candidate.urlFingerprint)) return;
      candidates.push({ ...d, kind: 'unknown', httpStatus: null });
      $('found').textContent = String(candidates.length);
      displayCandidates();
      log(`HLS candidate ${candidates.length}: ${d.candidate.host}${d.candidate.path}`);
      scheduleAuto();
    });
    es.addEventListener('candidate_http', (e) => {
      const d = JSON.parse(e.data);
      const found = candidates.find(c => c.candidate.urlFingerprint === d.urlFingerprint);
      if (found) {
        found.kind = d.kind;
        found.httpStatus = d.httpStatus;
        displayCandidates();
      }
    });
    es.addEventListener('complete', (e) => {
      inspectionDone = true;
      log(`Inspection complete: ${JSON.parse(e.data).candidates} candidate(s).`);
      scheduleAuto();
    });
  } catch (err) {
    $('status').textContent = 'Error';
    log(err.message);
    $('start').disabled = false;
  }
}
$('form').addEventListener('submit', (e) => { e.preventDefault(); runTest($('url').value.trim()); });
$('demo').addEventListener('click', async () => {
  try {
    const config = await (await fetch('/api/config')).json();
    $('url').value = config.mockUrl;
    runTest(config.mockUrl);
  } catch (err) { log('Demo configuration error: ' + err.message); }
});
$('stop').addEventListener('click', stopTest);
$('engine').addEventListener('change', () => {
  if (activeManualUrl) manualPlay(activeManualUrl);
  else if (currentIndex >= 0) attempt(currentIndex, true);
});
$('manualForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const url = $('manualUrl').value.trim();
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('HTTP(S) URLs only');
    manualPlay(url);
  } catch (err) { log('Invalid direct HLS URL: ' + err.message); }
});
$('copyDiagnostics').addEventListener('click', async () => {
  const output = [
    'HLS Session Test v3 (no raw token URLs)',
    'Source host: ' + (() => { try { return new URL($('url').value).hostname; } catch (_) { return 'unknown'; } })(),
    'Session: ' + $('sid').textContent,
    'Player engine setting: ' + $('engine').value,
    'HLS.js ready: ' + Boolean(window.Hls && Hls.isSupported()),
    'Native HLS ready: ' + Boolean($('video').canPlayType('application/vnd.apple.mpegurl')),
    'Player status: ' + $('playerStatus').textContent,
    'HLS candidates: ' + candidates.length,
    'Blocked popups / ads / redirects: ' + $('blocked').textContent,
    ...candidates.map((c, i) =>
      `Candidate ${i + 1}: ${c.candidate.host}${c.candidate.path}, HTTP ${c.httpStatus ?? '?'} (${c.kind}), URL #${c.candidate.urlFingerprint}, token #${c.candidate.tokenFingerprint || 'none'}`),
    'Errors: ' + (errorHistory.join(' | ') || 'none')
  ].join('\n');
  try { await navigator.clipboard.writeText(output); log('Safe diagnostics copied.'); }
  catch (_) { log('Clipboard unavailable: check event log above.'); }
});
