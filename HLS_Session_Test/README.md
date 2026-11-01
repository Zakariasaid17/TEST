# One-session HLS detector — small test app

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
