# Trust Checker

Trust Checker is a small, open-source verification tool for auditing whether QX Flow processes files locally in the browser without uploading raw file data to a backend.

It is intentionally narrow:

- capture every network request during an audit window
- capture in-page file selection and memory-read hooks
- optionally record the browser session into a timestamped video artifact
- write a plain-text report plus JSON evidence files

## What This Version Delivers

This directory is designed to be publishable as a standalone tool.

It includes two runnable entrypoints:

- CLI mode for technical users who want source code, terminal control, and raw evidence files
- local GUI mode for business users who prefer a button-based flow without touching code after startup

Both modes share the same audit core in `./trust-checker-core.js`.

## Artifact Output

Each audit session creates a timestamped folder under `docs/Trust_Checker/artifacts/` with these files:

- `audit-report.txt`: plain-text report for audit, approval or evidence retention
- `audit-summary.json`: machine-readable verdict summary
- `network-requests.json`: every request captured during the audit window
- `file-events.json`: every file-selection and FileReader or Blob memory-read event captured during the audit window
- `audit-video.mp4`: browser recording when video capture is enabled and `ffmpeg` is available
- `video-frames/`: timestamped JPEG frame sequence used to assemble the video

## Quick Start

### 1. Install dependencies

From this `Trust_Checker` directory:

```bash
npm install
```

This standalone package has its own `package.json`. If you publish Trust Checker separately, keep its runtime dependencies and its `package-lock.json` in this folder, instead of depending on the main QX Flow webapp package manifest.

`puppeteer-core` is used as the browser controller. Trust Checker auto-detects Chrome or Chromium on macOS, Windows and Linux. If auto-detection fails, pass the browser path explicitly with `--chromePath` or set `TRUST_CHECKER_CHROME_PATH`.

On macOS, when Chrome is launched in normal interactive mode, video capture is disabled by default because repeated screenshots can cause visible window jitter. If you still need the MP4 artifact, enable it explicitly with `--video`.

### 2. CLI mode

```bash
npm run trust:checker -- --url https://qingxiflow.com/app
```

Flow:

1. Trust Checker opens the target page in Chrome and starts the audit window immediately by default.
2. Upload a file and process it in QX Flow.
3. Press Enter to stop the audit and write the report.

If you still want the old prepare-then-start flow for sign-in or setup, add `--manualStart`.

Useful flags:

```bash
  node "./trust-checker.js" \
  --url https://www.qingxiflow.com/app \
  --outputRoot "./artifacts" \
  --chromePath "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --trustedDomains "fonts.gstatic.com,fonts.googleapis.com" \
  --highRiskDomains "sentry.io,google-analytics.com"
```

If you want video on macOS anyway:

```bash
npm run trust:checker -- --video
```

If you need to pause before the audit begins:

```bash
npm run trust:checker -- --manualStart
```

### 3. GUI mode

```bash
npm run trust:checker:gui
```

This starts a local control panel at `http://127.0.0.1:3399` and opens it in your default browser.

Flow:

1. Click `Start Audit`.
2. Trust Checker launches QX Flow in Chrome and starts monitoring immediately.
3. Upload a file and process it in the launched browser.
4. Return to the control panel and click `Stop Audit`.
5. Open the generated artifact folder for the report and evidence files.

### 4. Optional static pre-scan

Before dynamic audit, you can quickly scan built assets for network-related calls:

```bash
npm run trust:checker:static-scan -- dist artifacts
```

This writes a report under `artifacts/static-scan-<timestamp>/static-scan.txt`.

## How The Verdict Is Computed

Trust Checker does not rely on marketing copy or privacy-policy text. It builds conclusions only from browser-observable evidence.

### Pass criteria

- `No data upload detected`: no upload-like request body and no POST/PUT/PATCH/DELETE request seen in the audit window
- `No API calls during file processing`: no untrusted cross-origin data-channel request (XHR/fetch/websocket/beacon/long-query/write methods) seen after file selection
- `File only processed in browser memory`: a file-selection event and at least one FileReader or Blob memory-read event are observed, with no upload-like request
- `No data stored on cloud`: no remote upload-like request is observed

Additional warning checks:

- `No suspicious high-risk third-party leakage`: warns when requests to high-risk domains (for example analytics or error tracking) include larger payloads, long query strings, beacon traffic, or websocket sends.

### Important boundary

Same-origin control-plane requests such as auth bootstrap, license key fetches, payment or version bootstrap, and analytics beacons are recorded into the evidence files, but they are not treated as file-upload failures. Trust Checker still reports remote writes and file-like upload traffic that are not part of that control plane.

If one evidence point cannot be proven from the captured hooks, Trust Checker reports it as `INFO`, not `WARN`. That means the result is inconclusive for that single point, not that risky behavior was detected.

## Recommended Audit Procedure

1. Start from a clean browser session.
2. Open QX Flow and finish any login steps before arming the audit window when using CLI mode.
3. Start the audit.
4. Upload a representative CSV, JSON or Excel file.
5. Apply one or more rules.
6. Stop the audit immediately after processing finishes.
7. Archive `audit-report.txt`, `audit-summary.json` and the video.

## Packaging Strategy

This codebase now supports the two delivery paths requested in the original brief.

### Technical users

Use this standalone folder directly:

- `trust-checker.js`
- `trust-checker-core.js`
- `trust-checker-gui.js`
- `build-release.js`
- `package.json`
- `package-lock.json`

### Business users

Use the GUI wrapper in `./trust-checker-gui.js` as the packaging entrypoint.

Recommended release process:

1. Run `npm run trust:checker:release` from this folder.
2. The script creates a portable release folder under `dist/` and also writes a ZIP package.
3. It bundles the current Node.js runtime automatically.
4. If Chrome or `ffmpeg` are detected locally, they can also be copied into `runtime/chrome/` and `runtime/ffmpeg/`.

Example:

```bash
npm run trust:checker:release -- \
  --chromePath "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --ffmpegPath "/usr/local/bin/ffmpeg"
```

Generated output:

- `dist/QXFlowTrustChecker-portable-.../`
- `dist/QXFlowTrustChecker-portable-....zip`
- launchers for macOS, Linux and Windows

Non-technical users can start the GUI by double-clicking `Launch Trust Checker.command` on macOS or the matching launcher for their OS.

## Notes And Limits

- The browser recording captures the browser page, not the native operating-system file chooser.
- If `ffmpeg` is not available, Trust Checker still saves raw video frames and all JSON or text evidence.
- This tool can prove what the browser did during the observed audit window. It does not prove what happened outside that window.
- If you audit the public production site, same-origin QX Flow control-plane requests are recorded as evidence but do not automatically count as file upload failures.

## Current Version

- Version: `0.1.0`
- Core stack: `Node.js + Puppeteer Core + ffmpeg`
- External naming: `QX Flow` in English,domain `qingxiflow.com`
- Scope: local audit evidence, not full endpoint reverse engineering