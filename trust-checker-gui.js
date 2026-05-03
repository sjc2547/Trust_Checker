#!/usr/bin/env node

const http = require('http');
const path = require('path');
const { execFile } = require('child_process');
const minimist = require('minimist');
const {
  VERSION,
  DEFAULT_TARGET_URL,
  DEFAULT_OUTPUT_ROOT,
  TrustAuditSession,
} = require('./trust-checker-core');

const args = minimist(process.argv.slice(2), {
  string: ['host', 'port', 'targetUrl', 'outputRoot', 'chromePath'],
  default: {
    host: '127.0.0.1',
    port: '3399',
  },
});

const defaultSettings = {
  targetUrl: args.targetUrl || DEFAULT_TARGET_URL,
  outputRoot: args.outputRoot ? path.resolve(args.outputRoot) : DEFAULT_OUTPUT_ROOT,
  chromePath: args.chromePath || '',
};

let currentSession = null;
let latestResult = null;
let latestError = null;

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (error) {
        reject(error);
      }
    });
    req.on('error', reject);
  });
}

function openBrowser(url) {
  const command = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'cmd'
      : 'xdg-open';
  const argv = process.platform === 'win32' ? ['/c', 'start', '', url] : [url];
  execFile(command, argv, () => {});
}

function renderPage() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Trust Checker</title>
  <style>
    :root {
      --bg: #f4efe7;
      --panel: rgba(255, 252, 248, 0.92);
      --ink: #18222f;
      --muted: #5f6c7b;
      --accent: #0f766e;
      --warn: #b45309;
      --border: rgba(24, 34, 47, 0.12);
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: "Avenir Next", "Segoe UI", sans-serif;
      color: var(--ink);
      background:
        radial-gradient(circle at top left, rgba(15, 118, 110, 0.16), transparent 32%),
        radial-gradient(circle at bottom right, rgba(180, 83, 9, 0.16), transparent 28%),
        var(--bg);
      padding: 24px;
    }
    .shell {
      max-width: 980px;
      margin: 0 auto;
      display: grid;
      gap: 20px;
    }
    .panel {
      background: var(--panel);
      backdrop-filter: blur(14px);
      border: 1px solid var(--border);
      border-radius: 20px;
      padding: 24px;
      box-shadow: 0 18px 40px rgba(24, 34, 47, 0.08);
    }
    h1, h2 { margin: 0 0 12px; }
    p { margin: 0; line-height: 1.6; }
    .hero {
      display: grid;
      gap: 12px;
    }
    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
      gap: 16px;
    }
    label {
      display: block;
      font-size: 13px;
      color: var(--muted);
      margin-bottom: 6px;
      text-transform: uppercase;
      letter-spacing: 0.08em;
    }
    input {
      width: 100%;
      padding: 12px 14px;
      border-radius: 12px;
      border: 1px solid var(--border);
      background: rgba(255, 255, 255, 0.92);
      color: var(--ink);
      font-size: 14px;
    }
    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 12px;
      margin-top: 18px;
    }
    button {
      border: 0;
      border-radius: 999px;
      padding: 12px 18px;
      font-size: 14px;
      font-weight: 700;
      cursor: pointer;
      transition: transform 160ms ease, opacity 160ms ease;
    }
    button:hover { transform: translateY(-1px); }
    .primary { background: var(--accent); color: white; }
    .secondary { background: white; color: var(--ink); border: 1px solid var(--border); }
    .danger { background: #f59e0b; color: white; }
    .check {
      padding: 14px;
      border-radius: 14px;
      background: rgba(255, 255, 255, 0.72);
      border: 1px solid var(--border);
    }
    pre {
      margin: 0;
      padding: 16px;
      border-radius: 14px;
      background: #17202a;
      color: #eef2f7;
      overflow: auto;
      min-height: 220px;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .muted { color: var(--muted); }
  </style>
</head>
<body>
  <div class="shell">
    <section class="panel hero">
      <div class="muted">Open-source local audit tool</div>
      <h1>Trust Checker</h1>
      <p>Launch QingxiFlow, watch every request, record the browser session, and generate a plain-text verification report that can be shared with compliance or management.</p>
      <p class="muted">On macOS, normal interactive sessions disable video capture by default so the Chrome window remains stable while you operate it.</p>
    </section>

    <section class="panel">
      <h2>Audit Session</h2>
      <div class="grid">
        <div>
          <label for="targetUrl">Target URL</label>
          <input id="targetUrl" value="${defaultSettings.targetUrl}" />
        </div>
        <div>
          <label for="outputRoot">Output Root</label>
          <input id="outputRoot" value="${defaultSettings.outputRoot}" />
        </div>
        <div>
          <label for="chromePath">Chrome Path (optional)</label>
          <input id="chromePath" value="${defaultSettings.chromePath}" placeholder="Auto-detect if empty" />
        </div>
      </div>
      <div class="actions">
        <button class="primary" id="startBtn">Start Audit</button>
        <button class="danger" id="stopBtn">Stop Audit</button>
        <button class="secondary" id="refreshBtn">Refresh Status</button>
      </div>
    </section>

    <section class="grid">
      <div class="panel check"><strong>1.</strong> Network requests are captured with method, URL and body preview.</div>
      <div class="panel check"><strong>2.</strong> File selection and FileReader or Blob memory reads are instrumented in-page.</div>
      <div class="panel check"><strong>3.</strong> Video capture is optional. On macOS interactive runs it is off by default to avoid browser jitter.</div>
      <div class="panel check"><strong>4.</strong> A plain-text report and JSON evidence files are written into an artifact folder.</div>
    </section>

    <section class="panel">
      <h2>Status</h2>
      <pre id="status">Loading…</pre>
    </section>
  </div>
  <script>
    async function updateStatus() {
      const response = await fetch('/api/status');
      const data = await response.json();
      document.getElementById('status').textContent = JSON.stringify(data, null, 2);
    }

    async function postJson(path, body) {
      const response = await fetch(path, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body || {}),
      });
      const data = await response.json();
      document.getElementById('status').textContent = JSON.stringify(data, null, 2);
    }

    document.getElementById('startBtn').addEventListener('click', async () => {
      await postJson('/api/start', {
        targetUrl: document.getElementById('targetUrl').value,
        outputRoot: document.getElementById('outputRoot').value,
        chromePath: document.getElementById('chromePath').value,
      });
    });

    document.getElementById('stopBtn').addEventListener('click', async () => {
      await postJson('/api/stop');
    });

    document.getElementById('refreshBtn').addEventListener('click', updateStatus);
    updateStatus();
    setInterval(updateStatus, 2500);
  </script>
</body>
</html>`;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(renderPage());
      return;
    }
    if (req.method === 'GET' && req.url === '/api/status') {
      sendJson(res, 200, {
        version: VERSION,
        defaults: defaultSettings,
        currentSession: currentSession ? currentSession.status() : null,
        latestResult,
        latestError,
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/start') {
      if (currentSession && currentSession.state === 'auditing') {
        sendJson(res, 409, { error: 'An audit is already running.', currentSession: currentSession.status() });
        return;
      }
      const body = await readBody(req);
      latestError = null;
      latestResult = null;
      currentSession = new TrustAuditSession({
        targetUrl: body.targetUrl || defaultSettings.targetUrl,
        outputRoot: body.outputRoot || defaultSettings.outputRoot,
        chromePath: body.chromePath || defaultSettings.chromePath || null,
      });
      await currentSession.launch();
      await currentSession.startAudit();
      sendJson(res, 200, {
        message: 'Audit started. Use the launched browser to upload a file and process it, then click Stop Audit here.',
        currentSession: currentSession.status(),
      });
      return;
    }
    if (req.method === 'POST' && req.url === '/api/stop') {
      if (!currentSession || currentSession.state !== 'auditing') {
        sendJson(res, 400, { error: 'No running audit session.' });
        return;
      }
      latestResult = await currentSession.stopAudit();
      await currentSession.close();
      sendJson(res, 200, latestResult);
      return;
    }
    sendJson(res, 404, { error: 'Not found' });
  } catch (error) {
    latestError = { message: error.message || String(error) };
    sendJson(res, 500, { error: latestError.message });
  }
});

server.listen(Number(args.port), args.host, () => {
  const url = `http://${args.host}:${args.port}`;
  console.log(`Trust Checker GUI v${VERSION} running at ${url}`);
  openBrowser(url);
});