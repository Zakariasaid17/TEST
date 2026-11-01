# HLS Session Test v4 — Buffer-First Player Fix

**Purpose:** For each visitor, open one isolated server-side Chromium context, watch HLS manifest requests from the source and its iframes, block common advertising hosts/popups, and attempt to play the detected playlist in the visitor's browser. Compare URL/token fingerprints between a phone and a desktop. This is a diagnostic proof of concept, **not** a universal ad-free stream player, a DRM bypass, or a CDN proxy.

## Local run

Python 3.11+ required.

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python -m playwright install chromium
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

Go to http://localhost:8000. Click **Try built-in sample** to confirm the detector is working. Then paste a video webpage URL you are allowed to inspect.

If system Chromium is already installed, use `CHROMIUM_PATH=/usr/bin/chromium python -m uvicorn main:app --host 0.0.0.0 --port 8000`.

## Online test (two devices)

Upload these project files to GitHub Codespaces or another Python-capable hosting service.

1. Install dependencies in a terminal using the commands above.
2. Set the cloud preview/forwarded port **8000** to publicly accessible only for short-lived trusted testing. Do **not** deploy this unauthenticated prototype as an open public service.
3. Open the forwarded web URL from phone and desktop. Run the same input source URL once on each device.
4. Compare **Token parameter fingerprint** and **Stream URL fingerprint** on the two devices.

Both backend browser sessions run in the hosting provider's network; the source sees that **server's IP**, not each device's IP. To test truly device-origin IP-bound tokens, this approach is insufficient.

If hosting platform requires `PORT`, run `PORT=$PORT python -m uvicorn main:app --host 0.0.0.0 --port "$PORT"`. The **Try built-in sample** feature uses the server's localhost and configured port.

## Updated player checks (v3)

- **HLS.js is selected automatically** when supported; the native-playback dropdown has been removed to prevent accidental Safari native selection.
- **The app waits for buffered video (`FRAG_BUFFERED` or `canplay`) before calling `video.play()`**, instead of trying immediately after parsing the playlist.
- New diagnostic stages distinguish playlist detection, manifest parsing, first media buffer, and browser playback attempts.
- The backend reports each manifest response's HTTP status and whether it appears to be a master or media playlist.
- Automatic selection waits briefly for response metadata, then prioritizes successful master manifests before other candidates. All other candidates are still selectable and tried automatically on failure.
- The Advanced direct-HLS test uses a copied media URL entirely within your browser to isolate player/origin restrictions from the Playwright detection step; the copied URL is not sent to the backend.
- The built-in localhost sample URL is remapped to the publicly forwarded Codespaces origin so a phone can load it.
- Failure reasons appear under **Test events**. Use **Copy safe diagnostics** without exposing raw tokens.
- If external playback is refused by CORS, authorization, expiration or IP binding, the test reports the failure; it does not bypass those controls.

## What results mean

- **Different token fingerprints**: The two sessions observed different token-like query parameters, not proof that either URL works in an external browser.
- **Identical fingerprint**: Perhaps one common URL, cached authorization, IP-based token, or detection captured the wrong request.
- **HLS detected / playback failed**: Could be CORS, missing required cookies/headers, token bound to backend IP, expiration, encryption/DRM or geographic restrictions.
- **No HLS**: The player might use a different media format, require genuine user interaction or block headless browser use.
- HLS.js requires CORS permission from the media server. No CORS/header/DRM bypass is implemented.
- Autoplay initially starts **muted** because browsers often block automatic sound.

## Security limits

The backend rejects private and loopback URL targets except the exact built-in local mock route. It also checks outbound URL hosts and blocks requests to known ad domains. This is best effort: **not a production hardened SSRF isolation boundary**; Chromium DNS resolution can differ from validation. Before public use, place browsers behind network-level egress filtering, authenticate users, enforce quotas, constrain network capabilities, and review source-provider terms. Session IDs are random bearer identifiers; short-lived only. Media URLs containing credentials are transmitted to their owner's web browser and are not stored permanently.

This test does not remove advertisements embedded into media segments. It also cannot promise that filtering will not affect source playback.

## Files

- `main.py`: FastAPI / Playwright backend, SSE, token fingerprinting, popup filters.
- `static/index.html`: one-page tester and HLS.js player.
- `mock/watch`: built-in sample that requests a unique token-bearing HLS manifest per session.
- `mock/video/`: short synthetic sample HLS media included in ZIP.

## License for mock media

The mock video is locally synthesized with FFmpeg test patterns and contains no third-party footage or audio.

## Fastest two-device test via GitHub Codespaces

1. Create a GitHub repository and upload this folder's contents, including `.devcontainer` (GitHub web upload can upload multiple files).
2. Open **Code → Codespaces → Create codespace**. The devcontainer downloads a browser-enabled Python image and installs requirements.
3. In the Codespaces terminal run `./start.sh`.
4. On the **PORTS** panel, forward port 8000 and set visibility to **Public** only while you're testing. Copy the forwarded `https://...app.github.dev` URL and open it on both devices.
5. Test **Try built-in sample** first, then the real source URL. For a cloud-hosted preview, autoplay, HLS.js loading and stream CORS still depend on the browser and source.
6. Keep the forwarded port Private and stop the Codespace when finished.

**Do not use an open public Codespaces port for arbitrary untrusted URL submissions.** This prototype lacks authentication, rate limiting by user and network-level SSRF containment.

## Updating existing GitHub Codespace from v3

1. Extract `HLS_Session_Test_v4.zip` and upload its **project files** to your repository in a folder named `HLS_Session_Test_v4`, then commit.
2. In your **existing** Codespace, run `git pull`, then `cd /workspaces/TEST/HLS_Session_Test_v3` (adjust the repository path if different).
3. Stop the old v2 server with `fuser -k 8000/tcp` **only if you own that listener**.
4. Start v3 with `bash start.sh`. Reopen port 8000 and hard-refresh the preview page.
5. The player selects **HLS.js automatically**. Verify **Try built-in sample**, then run your streaming webpage test.
6. If the external stream still fails, open **Advanced** and paste the same working HLS URL from the demo; that distinguishes frontend/origin restrictions from extraction or candidate-ranking problems.

## Checks

```bash
python -m pytest -q
node tests/test_player.cjs
```

These are logic tests, not proof that an external source plays. Browser navigation was restricted in the development test environment. The same URL working at `hlsjs.video-dev.org` does not by itself prove that a different host/origin will be accepted by the media CDN.
