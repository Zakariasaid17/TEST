"""Single-visitor-at-a-time HLS URL observation test.

This is a diagnostic tool, not a token bypass/proxy or general-purpose CDN repeater.
Use only with sources you have permission to inspect and play.
"""
import asyncio
from contextlib import asynccontextmanager
from dataclasses import dataclass, field
import hashlib
import ipaddress
import json
import os
from pathlib import Path
import re
import secrets
import socket
import time
from urllib.parse import urlparse, parse_qsl

from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import HTMLResponse, StreamingResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from playwright.async_api import async_playwright, Error as PlaywrightError

ROOT = Path(__file__).parent
TTL_SECONDS = 240
MAX_SESSIONS = 4
MAX_REQUESTS = 400
ALLOWED_ORIGIN = os.environ.get('PUBLIC_BASE_URL', '')  # optional, for logging/documentation
AD_DOMAINS = (
    'doubleclick.net', 'googlesyndication.com', 'googleadservices.com',
    'adnxs.com', 'popads.net', 'propellerads.com', 'exoclick.com',
    'onclickads.net', 'trafficjunky.net', 'taboola.com', 'outbrain.com',
    'adskeeper.co.uk', 'adsterra.com', 'popcash.net',
)
STREAM_HINT = re.compile(r'\.m3u8(?:[?#]|$)', re.IGNORECASE)
HLS_MIME = re.compile(r'(mpegurl|x-mpegurl)', re.IGNORECASE)
TOKEN_PARAM = re.compile(r'(token|auth|sign|sig|signature|jwt|session|expires?|policy|key)', re.I)
DNS_CACHE: dict[str, tuple[float, bool]] = {}


class TestRequest(BaseModel):
    url: str = Field(min_length=10, max_length=2048)


@dataclass
class Session:
    id: str
    url: str
    created_at: float = field(default_factory=time.monotonic)
    status: str = 'queued'
    events: list[dict] = field(default_factory=list)
    subscribers: list[asyncio.Queue] = field(default_factory=list)
    seen: set[str] = field(default_factory=set)
    browser_context: object | None = None
    request_count: int = 0
    blocked_ads: int = 0
    blocked_popups: int = 0
    blocked_redirects: int = 0
    candidate_count: int = 0
    task: asyncio.Task | None = None

    def publish(self, event_type: str, payload: dict):
        entry = {'event': event_type, 'data': payload}
        self.events.append(entry)
        if len(self.events) > 100:
            self.events.pop(0)
        for queue in list(self.subscribers):
            if not queue.full():
                queue.put_nowait(entry)

    def update(self, text: str):
        self.status = text
        self.publish('status', {'status': text})


sessions: dict[str, Session] = {}
playwright_engine = None
browser = None


def mock_url(url: str) -> bool:
    """Precisely scoped built-in local test route only."""
    u = urlparse(url)
    port = str(os.getenv('PORT', '8000'))
    return (u.scheme == 'http' and u.hostname in ('127.0.0.1',)
            and str(u.port or 80) == port
            and (u.path == '/mock/watch' or u.path.startswith('/mock/video/')))


async def url_allowed(url: str) -> bool:
    try:
        parsed = urlparse(url)
        if parsed.scheme not in ('http', 'https') or not parsed.hostname or parsed.username or parsed.password:
            return False
        if mock_url(url):
            return True
        hostname = parsed.hostname.lower().rstrip('.')
        if hostname in ('localhost', 'localhost.localdomain') or hostname.endswith('.local'):
            return False
        try:
            ip = ipaddress.ip_address(hostname)
            return ip.is_global
        except ValueError:
            pass
        cached = DNS_CACHE.get(hostname)
        if cached and time.monotonic() - cached[0] < 30:
            return cached[1]
        # Limit DNS lookup time and reject any non-global DNS answer.
        result = await asyncio.wait_for(
            asyncio.to_thread(socket.getaddrinfo, hostname, None, type=socket.SOCK_STREAM),
            timeout=4,
        )
        ok = bool(result) and all(ipaddress.ip_address(record[4][0]).is_global for record in result)
        DNS_CACHE[hostname] = (time.monotonic(), ok)
        return ok
    except (ValueError, socket.gaierror, TimeoutError, OSError):
        return False


def ad_host(hostname: str) -> bool:
    host = hostname.lower().rstrip('.')
    return any(host == ad or host.endswith('.' + ad) for ad in AD_DOMAINS)


def masked_candidate(url: str) -> dict:
    p = urlparse(url)
    pairs = parse_qsl(p.query, keep_blank_values=True)
    token_pairs = [(key, value) for key, value in pairs if TOKEN_PARAM.search(key)]
    # SHA-256 fingerprints allow comparison without showing raw credentials.
    f = lambda s: hashlib.sha256(s.encode()).hexdigest()[:16]
    return {
        'host': p.hostname,
        'path': p.path[:160],
        'urlFingerprint': f(url),
        'tokenFingerprint': f(json.dumps(token_pairs, sort_keys=True)) if token_pairs else None,
        'tokenPresent': bool(token_pairs),
        'queryPresent': bool(p.query),
    }


async def maybe_close_popup(session: Session, popup):
    session.blocked_popups += 1
    session.publish('filters', {'popups': session.blocked_popups, 'ads': session.blocked_ads, 'redirects': session.blocked_redirects})
    try:
        await popup.close()
    except Exception:
        pass


async def execute_test(session: Session):
    context = None
    page = None
    source_host = urlparse(session.url).hostname.lower()

    def capture(url: str):
        if url in session.seen:
            return
        session.seen.add(url)
        session.candidate_count += 1
        session.publish('candidate', {'url': url, 'candidate': masked_candidate(url), 'count': session.candidate_count})
        session.update('HLS detected — trying player')

    try:
        session.update('Creating isolated browser context')
        context = await browser.new_context(
            viewport={'width': 1280, 'height': 800},
            ignore_https_errors=False,
            accept_downloads=False,
            service_workers='block',
        )
        session.browser_context = context
        page = await context.new_page()
        context.on('page', lambda new_page: asyncio.create_task(maybe_close_popup(session, new_page)) if new_page != page else None)

        async def route_filter(route):
            req = route.request
            url = req.url
            try:
                session.request_count += 1
                if session.request_count > MAX_REQUESTS:
                    await route.abort('blockedbyclient')
                    return
                target = urlparse(url)
                # Prevent homepage takeovers to unrelated sites.
                if req.is_navigation_request() and req.frame == page.main_frame and target.hostname and target.hostname.lower() != source_host:
                    session.blocked_redirects += 1
                    session.publish('filters', {'popups': session.blocked_popups, 'ads': session.blocked_ads, 'redirects': session.blocked_redirects})
                    await route.abort('blockedbyclient')
                    return
                if target.hostname and ad_host(target.hostname):
                    session.blocked_ads += 1
                    session.publish('filters', {'popups': session.blocked_popups, 'ads': session.blocked_ads, 'redirects': session.blocked_redirects})
                    await route.abort('blockedbyclient')
                    return
                if not await url_allowed(url):
                    await route.abort('blockedbyclient')
                    return
                await route.continue_()
            except Exception:
                try:
                    await route.abort('blockedbyclient')
                except Exception:
                    pass

        await context.route('**/*', route_filter)

        def on_request(request):
            if STREAM_HINT.search(request.url):
                capture(request.url)

        def on_response(response):
            try:
                if HLS_MIME.search(response.headers.get('content-type', '')):
                    capture(response.url)
            except Exception:
                pass

        context.on('request', on_request)
        context.on('response', on_response)

        session.update('Opening source webpage')
        try:
            await page.goto(session.url, wait_until='domcontentloaded', timeout=20000)
        except PlaywrightError as exc:
            session.publish('notice', {'message': 'Initial navigation: ' + str(exc).splitlines()[0][:220]})

        if page and not page.is_closed():
            session.update('Attempting to start source video')
            selectors = [
                'video',
                'button[aria-label*="play" i]',
                '[aria-label="Play"]',
                '.vjs-big-play-button',
                '.jw-icon-display',
                '.plyr__control[data-plyr="play"]',
                '.play-button',
                '#play',
            ]
            # Conservative Play click attempts; never click arbitrary overlays.
            for frame in list(page.frames):
                for selector in selectors:
                    try:
                        loc = frame.locator(selector).first
                        if await loc.count() and await loc.is_visible(timeout=350):
                            await loc.click(timeout=1100, force=True)
                            await asyncio.sleep(0.3)
                            if session.candidate_count:
                                break
                    except Exception:
                        pass
                if session.candidate_count:
                    break

            # Some players only fetch when video.play() runs.
            if not session.candidate_count:
                for frame in list(page.frames):
                    try:
                        await frame.evaluate('''() => { const v = document.querySelector('video'); if (v) v.play().catch(()=>{}); }''')
                    except Exception:
                        pass

        # Leave time for slow player initialization and nested iframe requests.
        for _ in range(18):
            if session.candidate_count:
                await asyncio.sleep(2)
                break
            await asyncio.sleep(1)

        if not session.candidate_count:
            session.update('No HLS playlist observed (page may use other media technology or require manual interaction)')
        else:
            session.update(f'Detected {session.candidate_count} HLS candidate(s); playback depends on source permissions and CORS')
        session.publish('complete', {'candidates': session.candidate_count, 'popups': session.blocked_popups,
                                     'ads': session.blocked_ads, 'redirects': session.blocked_redirects})
        # Keep authorization session alive briefly, though browser cookies cannot be
        # automatically transferred into the end user's separate HLS.js browser.
        await asyncio.sleep(120)
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        session.update('Inspection failed')
        session.publish('error', {'message': str(exc)[:350]})
    finally:
        if context:
            try:
                await context.close()
            except Exception:
                pass
        session.browser_context = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global playwright_engine, browser
    playwright_engine = await async_playwright().start()
    executable = os.getenv('CHROMIUM_PATH', '')
    kwargs = {'executable_path': executable} if executable else {}
    browser = await playwright_engine.chromium.launch(
        headless=True, args=['--no-sandbox', '--disable-dev-shm-usage'], **kwargs
    )
    cleanup_task = asyncio.create_task(cleanup_loop())
    try:
        yield
    finally:
        cleanup_task.cancel()
        for s in list(sessions.values()):
            if s.task and not s.task.done():
                s.task.cancel()
        await asyncio.gather(*(s.task for s in sessions.values() if s.task), return_exceptions=True)
        await browser.close()
        await playwright_engine.stop()


async def cleanup_loop():
    while True:
        await asyncio.sleep(10)
        for sid, session in list(sessions.items()):
            if time.monotonic() - session.created_at > TTL_SECONDS:
                if session.task and not session.task.done():
                    session.task.cancel()
                sessions.pop(sid, None)


app = FastAPI(title='Single-Session HLS URL Test', lifespan=lifespan)
app.mount('/static', StaticFiles(directory=ROOT / 'static'), name='static')
app.mount('/mock/video', StaticFiles(directory=ROOT / 'mock' / 'video'), name='mock_video')


@app.get('/', include_in_schema=False)
async def home():
    return FileResponse(ROOT / 'static' / 'index.html')


@app.get('/api/config')
async def config():
    return {'mockUrl': f"http://127.0.0.1:{os.getenv('PORT', '8000')}/mock/watch"}


@app.get('/api/health')
async def health():
    return {'ok': bool(browser and browser.is_connected()), 'activeTests': len(sessions)}


@app.post('/api/tests')
async def create_test(body: TestRequest):
    target = body.url.strip()
    if not await url_allowed(target):
        raise HTTPException(400, 'URL must be a resolvable public HTTP(S) URL (private networks blocked).')
    active = sum(1 for s in sessions.values() if s.task and not s.task.done())
    if active >= MAX_SESSIONS:
        raise HTTPException(429, 'Too many active tests. Try again after another test expires.')
    sid = secrets.token_urlsafe(24)
    sess = Session(id=sid, url=target)
    sessions[sid] = sess
    sess.task = asyncio.create_task(execute_test(sess))
    return {'id': sid, 'status': sess.status}


@app.get('/api/tests/{sid}/events')
async def stream_events(sid: str, request: Request):
    sess = sessions.get(sid)
    if not sess:
        raise HTTPException(404, 'Test expired or not found')

    async def generator():
        q = asyncio.Queue(maxsize=64)
        sess.subscribers.append(q)
        try:
            for entry in list(sess.events):
                yield f"event: {entry['event']}\ndata: {json.dumps(entry['data'])}\n\n"
            while not await request.is_disconnected():
                try:
                    entry = await asyncio.wait_for(q.get(), timeout=10)
                    yield f"event: {entry['event']}\ndata: {json.dumps(entry['data'])}\n\n"
                except asyncio.TimeoutError:
                    yield ': keepalive\n\n'
        finally:
            if q in sess.subscribers:
                sess.subscribers.remove(q)

    return StreamingResponse(generator(), media_type='text/event-stream', headers={'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no'})


@app.delete('/api/tests/{sid}')
async def cancel_test(sid: str):
    s = sessions.pop(sid, None)
    if not s:
        raise HTTPException(404, 'Unknown session')
    if s.task:
        s.task.cancel()
    return {'ok': True}


@app.get('/mock/watch', response_class=HTMLResponse, include_in_schema=False)
async def mock_watch():
    return '''<!doctype html><html><head><title>Mock HLS source</title></head><body>
    <h1>Test video source</h1><button id="play" onclick="run()">Play sample video</button>
    <script>
    async function run() {
      const token = crypto.randomUUID();
      const url = '/mock/video/master.m3u8?token=' + token;
      await fetch(url);
      document.body.insertAdjacentHTML('beforeend', '<p>Requested sample HLS manifest.</p>');
    }
    </script></body></html>'''
