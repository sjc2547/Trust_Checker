const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const VERSION = '0.1.0';
const DEFAULT_TARGET_URL = 'https://www.qingxiflow.com/app';
const DEFAULT_OUTPUT_ROOT = path.join(__dirname, 'artifacts');
const DEFAULT_VIEWPORT = { width: 1440, height: 960 };
const DEFAULT_CAPTURE_INTERVAL_MS = 1000;
const DEFAULT_SUSPICIOUS_BODY_BYTES = 1024;
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);
const DEFAULT_HIGH_RISK_THIRD_PARTY_DOMAINS = [
  'sentry.io',
  'ingest.sentry.io',
  'google-analytics.com',
  'googletagmanager.com',
  'mixpanel.com',
  'segment.com',
  'amplitude.com',
  'hotjar.com',
  'fullstory.com',
];
// Default ignore rules (control-plane paths that don't involve file processing).
// These are the built-in baselines; audit-ignore.json extends them at runtime.
const BUILTIN_IGNORE_EXACT_PATHS = new Set([
  '/api/auth/me',
  '/api/demo/capability',
  '/api/analytics/events',
  '/api/health',
  '/api/version',
  '/api/payment/config',
  '/api/license/public-key',
  '/api/auth/public-key',
  '/api/auth/region',
  '/api/auth/captcha',
  '/api/audit-logs',
  '/api/enterprise-interest',
  '/api/enterprise-interests',
  '/api/beta/login',
  '/api/beta/reserve',
  '/cdn-cgi/rum',
]);
const BUILTIN_IGNORE_PREFIXES = [
  '/api/auth/',
  '/api/license/',
  '/api/payment/',
  '/api/export/',
  '/api/import/',
  '/api/audit-logs/',
  '/cdn-cgi/',
];

const DEFAULT_IGNORE_FILE_PATH = path.join(__dirname, 'ref', 'audit-ignore.json');

function loadIgnoreRules(ignoreFilePath) {
  const filePath = ignoreFilePath || DEFAULT_IGNORE_FILE_PATH;
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      exactPaths: Array.isArray(parsed.exactPaths) ? parsed.exactPaths.filter(Boolean) : [],
      prefixPaths: Array.isArray(parsed.prefixPaths) ? parsed.prefixPaths.filter(Boolean) : [],
      urlPatterns: Array.isArray(parsed.urlPatterns)
        ? parsed.urlPatterns.filter(Boolean).map((p) => {
            try { return new RegExp(p); } catch (_) { return null; }
          }).filter(Boolean)
        : [],
      trustedThirdPartyDomains: Array.isArray(parsed.trustedThirdPartyDomains)
        ? parsed.trustedThirdPartyDomains.filter(Boolean)
        : [],
      highRiskThirdPartyDomains: Array.isArray(parsed.highRiskThirdPartyDomains)
        ? parsed.highRiskThirdPartyDomains.filter(Boolean)
        : [],
      _source: filePath,
    };
  } catch (_) {
    return { exactPaths: [], prefixPaths: [], urlPatterns: [], trustedThirdPartyDomains: [], highRiskThirdPartyDomains: [], _source: null };
  }
}

function mergeIgnoreRules(fileRules = {}) {
  const exactPaths = new Set([
    ...BUILTIN_IGNORE_EXACT_PATHS,
    ...(fileRules.exactPaths || []),
  ]);
  const prefixPaths = [
    ...BUILTIN_IGNORE_PREFIXES,
    ...(fileRules.prefixPaths || []).filter((p) => !BUILTIN_IGNORE_PREFIXES.includes(p)),
  ];
  const urlPatterns = fileRules.urlPatterns || [];
  return { exactPaths, prefixPaths, urlPatterns };
}

function isIgnoredControlPlanePath(pathname, fullUrl, rules) {
  if (!pathname) return false;
  const exact = rules ? rules.exactPaths : BUILTIN_IGNORE_EXACT_PATHS;
  const prefixes = rules ? rules.prefixPaths : BUILTIN_IGNORE_PREFIXES;
  const patterns = rules ? (rules.urlPatterns || []) : [];
  if (exact.has(pathname)) return true;
  if (prefixes.some((prefix) => pathname.startsWith(prefix))) return true;
  if (fullUrl && patterns.length > 0 && patterns.some((re) => re.test(fullUrl))) return true;
  return false;
}

function defaultRecordVideo({ headless }) {
  return !(process.platform === 'darwin' && !headless);
}

function checkTag(check) {
  if (check.status === 'pass') return '[PASS]';
  if (check.status === 'fail') return '[FAIL]';
  if (check.status === 'warn') return '[WARN]';
  return '[INFO]';
}

const INSTRUMENTATION_SOURCE = `
(() => {
  if (globalThis.__trustCheckerInstalled) return;
  globalThis.__trustCheckerInstalled = true;

  const emit = (payload) => {
    try {
      if (typeof globalThis.__trustCheckerRecordFileEvent === 'function') {
        globalThis.__trustCheckerRecordFileEvent(payload);
      }
    } catch (_) {}
  };

  const compactFile = (file) => {
    if (!file) return null;
    return {
      name: typeof file.name === 'string' ? file.name : null,
      size: Number(file.size || 0),
      type: typeof file.type === 'string' ? file.type : '',
      lastModified: Number(file.lastModified || 0),
    };
  };

  const compactBlob = (blob) => {
    if (!blob) return null;
    return {
      size: Number(blob.size || 0),
      type: typeof blob.type === 'string' ? blob.type : '',
    };
  };

  const selectorFor = (element) => {
    if (!element || !element.tagName) return null;
    const parts = [String(element.tagName || '').toLowerCase()];
    if (element.id) parts.push('#' + element.id);
    if (element.name) parts.push('[name="' + String(element.name).replace(/"/g, '\\"') + '"]');
    if (element.classList && element.classList.length) {
      parts.push('.' + Array.from(element.classList).slice(0, 3).join('.'));
    }
    return parts.join('');
  };

  document.addEventListener('change', (event) => {
    const target = event && event.target;
    if (!target || target.tagName !== 'INPUT' || target.type !== 'file') return;
    emit({
      kind: 'file-selected',
      ts: Date.now(),
      pageUrl: location.href,
      selector: selectorFor(target),
      files: Array.from(target.files || []).map(compactFile),
    });
  }, true);

  const wrap = (owner, methodName, kind, detailFactory) => {
    const original = owner && owner[methodName];
    if (!original || original.__trustCheckerWrapped) return;
    const wrapped = function(...args) {
      try {
        emit({
          kind,
          ts: Date.now(),
          pageUrl: location.href,
          ...(typeof detailFactory === 'function' ? detailFactory.call(this, args) : {}),
        });
      } catch (_) {}
      return original.apply(this, args);
    };
    wrapped.__trustCheckerWrapped = true;
    owner[methodName] = wrapped;
  };

  wrap(FileReader.prototype, 'readAsArrayBuffer', 'file-reader-read-as-array-buffer', function(args) {
    return { file: compactBlob(args[0]) };
  });
  wrap(FileReader.prototype, 'readAsText', 'file-reader-read-as-text', function(args) {
    return { file: compactBlob(args[0]) };
  });
  wrap(FileReader.prototype, 'readAsDataURL', 'file-reader-read-as-data-url', function(args) {
    return { file: compactBlob(args[0]) };
  });
  wrap(FileReader.prototype, 'readAsBinaryString', 'file-reader-read-as-binary-string', function(args) {
    return { file: compactBlob(args[0]) };
  });

  wrap(Blob.prototype, 'arrayBuffer', 'blob-array-buffer', function() {
    return { blob: compactBlob(this) };
  });
  wrap(Blob.prototype, 'text', 'blob-text', function() {
    return { blob: compactBlob(this) };
  });
  wrap(Blob.prototype, 'stream', 'blob-stream', function() {
    return { blob: compactBlob(this) };
  });

  if (typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function') {
    const originalCreateObjectURL = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function(target) {
      try {
        emit({
          kind: 'create-object-url',
          ts: Date.now(),
          pageUrl: location.href,
          blob: compactBlob(target),
        });
      } catch (_) {}
      return originalCreateObjectURL(target);
    };
  }

  if (typeof Navigator !== 'undefined' && Navigator.prototype && typeof Navigator.prototype.sendBeacon === 'function') {
    wrap(Navigator.prototype, 'sendBeacon', 'send-beacon', function(args) {
      const body = args[1];
      let bodySize = 0;
      if (typeof body === 'string') bodySize = body.length;
      else if (body && typeof body.size === 'number') bodySize = body.size;
      else if (body && typeof body.byteLength === 'number') bodySize = body.byteLength;
      return {
        beaconUrl: String(args[0] || ''),
        bodySize: Number(bodySize || 0),
        bodyPreview: typeof body === 'string' ? body.slice(0, 1200) : null,
      };
    });
  }

  if (typeof FormData !== 'undefined' && FormData.prototype) {
    wrap(FormData.prototype, 'append', 'form-data-append', function(args) {
      const value = args[1];
      const filename = typeof args[2] === 'string' ? args[2] : null;
      const valueType = value && value.constructor ? value.constructor.name : typeof value;
      const valueSize = value && typeof value.size === 'number'
        ? Number(value.size)
        : typeof value === 'string'
          ? value.length
          : value && typeof value.byteLength === 'number'
            ? Number(value.byteLength)
            : 0;
      return {
        fieldName: String(args[0] || ''),
        valueType,
        valueSize,
        filename,
      };
    });
  }
})();
`;

function normalizeDomainList(input) {
  const values = Array.isArray(input) ? input : [input];
  return values
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean)
    .map((item) => item.replace(/^https?:\/\//, '').replace(/\/$/, ''));
}

function domainMatches(hostname, domains) {
  const host = String(hostname || '').toLowerCase();
  if (!host) return false;
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function detectSensitivePayload(postDataText) {
  const text = String(postDataText || '');
  if (!text) return { hasSensitiveData: false, signals: [] };

  const sensitivePatterns = [
    { name: 'email', regex: /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i },
    { name: 'cn-phone', regex: /(?:\+?86[-\s]?)?1[3-9]\d{9}/ },
    { name: 'us-ssn', regex: /\b\d{3}-\d{2}-\d{4}\b/ },
  ];

  const signals = [];
  for (const pattern of sensitivePatterns) {
    if (pattern.regex.test(text)) signals.push(pattern.name);
  }

  const base64Candidates = text.match(/[A-Za-z0-9+/]{40,}={0,2}/g) || [];
  for (const candidate of base64Candidates.slice(0, 3)) {
    try {
      const decoded = Buffer.from(candidate, 'base64').toString('utf8');
      if (!decoded) continue;
      const printableCount = (decoded.match(/[\x20-\x7E\n\r\t]/g) || []).length;
      const printableRatio = printableCount / decoded.length;
      if (printableRatio < 0.85) continue;
      for (const pattern of sensitivePatterns) {
        if (pattern.regex.test(decoded)) signals.push(`base64-${pattern.name}`);
      }
    } catch (_) {}
  }

  return {
    hasSensitiveData: signals.length > 0,
    signals: Array.from(new Set(signals)),
  };
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
  return dirPath;
}

function commandPath(binaryName) {
  const command = process.platform === 'win32' ? 'where' : 'which';
  const result = spawnSync(command, [binaryName], { encoding: 'utf8' });
  if (result.status !== 0) return null;
  const output = String(result.stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return output[0] || null;
}

function fileExists(filePath) {
  if (!filePath) return false;
  try {
    return fs.statSync(filePath).isFile();
  } catch (_) {
    return false;
  }
}

function bundledRuntimeCandidates(relativePath) {
  const execDir = path.dirname(process.execPath || '');
  const cwdDir = process.cwd();
  return [
    path.join(execDir, 'runtime', relativePath),
    path.join(execDir, relativePath),
    path.join(cwdDir, 'runtime', relativePath),
  ];
}

function chromeCandidates() {
  const candidates = [
    process.env.TRUST_CHECKER_CHROME_PATH,
    process.env.CHROME_PATH,
    ...bundledRuntimeCandidates(process.platform === 'darwin'
      ? 'chrome/Google Chrome.app/Contents/MacOS/Google Chrome'
      : process.platform === 'win32'
        ? 'chrome/chrome.exe'
        : 'chrome/chrome'),
  ];
  if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
    );
  } else if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.PROGRAMFILES || 'C:\\Program Files';
    const programFilesX86 = process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
    );
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/usr/bin/chromium-browser',
      '/usr/bin/chromium',
      '/snap/bin/chromium'
    );
  }
  for (const binaryName of ['google-chrome', 'google-chrome-stable', 'chromium-browser', 'chromium', 'chrome', 'msedge']) {
    candidates.push(commandPath(binaryName));
  }
  return candidates.filter(Boolean);
}

function detectChromeExecutable(explicitPath) {
  const candidates = [explicitPath, ...chromeCandidates()];
  const resolved = candidates.find(fileExists);
  if (!resolved) {
    throw new Error('Chrome or Chromium executable not found. Set TRUST_CHECKER_CHROME_PATH or pass --chromePath.');
  }
  return resolved;
}

function detectFfmpegExecutable() {
  const bundledRelative = process.platform === 'win32' ? 'ffmpeg/ffmpeg.exe' : 'ffmpeg/ffmpeg';
  const candidates = [
    process.env.TRUST_CHECKER_FFMPEG_PATH,
    ...bundledRuntimeCandidates(bundledRelative),
    commandPath('ffmpeg'),
  ].filter(Boolean);
  return candidates.find(fileExists) || null;
}

function sanitizeBodyPreview(postData) {
  if (!postData) return null;
  if (typeof postData !== 'string') return '[non-text body omitted]';
  const trimmed = postData.length > 1200 ? `${postData.slice(0, 1200)}…` : postData;
  return trimmed;
}

function isLocalHostname(hostname) {
  if (!hostname) return false;
  if (LOCAL_HOSTS.has(hostname)) return true;
  if (/^10\./.test(hostname)) return true;
  if (/^192\.168\./.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[0-1])\./.test(hostname)) return true;
  return false;
}

function nowIso() {
  return new Date().toISOString();
}

function makeTimestamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function formatBytes(bytes) {
  const value = Number(bytes || 0);
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = value;
  let index = 0;
  while (size >= 1024 && index < units.length - 1) {
    size /= 1024;
    index += 1;
  }
  return `${size.toFixed(size >= 10 || index === 0 ? 0 : 1)} ${units[index]}`;
}

function shortUrl(urlString) {
  try {
    const url = new URL(urlString);
    return `${url.origin}${url.pathname}`;
  } catch (_) {
    return urlString;
  }
}

function summarizeFileEvents(events) {
  const selected = [];
  const reads = [];
  const objectUrls = [];
  const formDataWrites = [];
  const beacons = [];
  for (const event of events) {
    if (event.kind === 'file-selected' && Array.isArray(event.files)) {
      for (const file of event.files) selected.push(file);
    }
    if (String(event.kind || '').startsWith('file-reader') || String(event.kind || '').startsWith('blob-')) {
      reads.push(event);
    }
    if (event.kind === 'create-object-url') objectUrls.push(event);
    if (event.kind === 'form-data-append') formDataWrites.push(event);
    if (event.kind === 'send-beacon') beacons.push(event);
  }
  return { selected, reads, objectUrls, formDataWrites, beacons };
}

function classifyRequest(item, targetOrigin, policy = {}) {
  const method = String(item.method || 'GET').toUpperCase();
  const headers = item.headers || {};
  const contentType = String(headers['content-type'] || headers['Content-Type'] || '').toLowerCase();
  const fileRules = policy.ignoreRules ? mergeIgnoreRules(policy.ignoreRules) : null;
  const trustedThirdPartyDomains = normalizeDomainList(
    (policy.ignoreRules && policy.ignoreRules.trustedThirdPartyDomains && policy.ignoreRules.trustedThirdPartyDomains.length > 0)
      ? [...(policy.trustedThirdPartyDomains || []), ...policy.ignoreRules.trustedThirdPartyDomains]
      : (policy.trustedThirdPartyDomains || [])
  );
  const highRiskThirdPartyDomains = normalizeDomainList(
    (policy.ignoreRules && policy.ignoreRules.highRiskThirdPartyDomains && policy.ignoreRules.highRiskThirdPartyDomains.length > 0)
      ? policy.ignoreRules.highRiskThirdPartyDomains
      : (policy.highRiskThirdPartyDomains || DEFAULT_HIGH_RISK_THIRD_PARTY_DOMAINS)
  );
  let parsedUrl = null;
  try {
    parsedUrl = new URL(item.url);
  } catch (_) {}
  const resourceType = String(item.resourceType || '').toLowerCase();
  const pathname = parsedUrl ? parsedUrl.pathname : item.url;
  const hostname = parsedUrl ? parsedUrl.hostname : '';
  const queryLength = parsedUrl ? String(parsedUrl.search || '').length : 0;
  const hasBody = Number(item.postDataSize || 0) > 0;
  const isRemote = parsedUrl ? !isLocalHostname(parsedUrl.hostname) && parsedUrl.protocol !== 'file:' : false;
  const isTargetOrigin = parsedUrl && targetOrigin ? parsedUrl.origin === targetOrigin : false;
  const isExternal = parsedUrl && targetOrigin ? parsedUrl.origin !== targetOrigin : isRemote;
  const isTrustedThirdParty = isExternal && domainMatches(hostname, trustedThirdPartyDomains);
  const isHighRiskThirdParty = isExternal && domainMatches(hostname, highRiskThirdPartyDomains);
  const isIgnoredLocalApi = Boolean(isTargetOrigin && isIgnoredControlPlanePath(pathname, item.url, fileRules));
  const isApiEndpoint = pathname.includes('/api/');
  const isRealtime = ['websocket', 'eventsource', 'websocket-frame'].includes(resourceType) || method === 'WS-SEND';
  const isBeacon = resourceType === 'beacon' || method === 'BEACON';
  const hasUploadContentType = /multipart|octet-stream/.test(contentType);
  const hasMeaningfulBody = Number(item.postDataSize || 0) >= 256;
  const hasLargeBody = Number(item.postDataSize || 0) >= DEFAULT_SUSPICIOUS_BODY_BYTES;
  const payloadInsights = detectSensitivePayload(item.postDataSample || item.postDataPreview || '');
  const isPotentialDataChannel =
    ['xhr', 'fetch', 'websocket', 'eventsource', 'beacon', 'ping', 'websocket-frame'].includes(resourceType) ||
    ['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'BEACON', 'WS-SEND'].includes(method) ||
    hasBody ||
    queryLength >= 256;
  const isApiLike = !isIgnoredLocalApi && !isTrustedThirdParty && (
    isApiEndpoint ||
    isRealtime ||
    isBeacon ||
    (isExternal && isPotentialDataChannel)
  );
  const isUploadLike = !isIgnoredLocalApi && !isTrustedThirdParty && (
    hasUploadContentType ||
    (isRemote && ['POST', 'PUT', 'PATCH', 'DELETE', 'CONNECT', 'BEACON'].includes(method) && (hasBody || hasLargeBody)) ||
    (method === 'WS-SEND' && hasBody) ||
    (isApiEndpoint && !isRemote && (hasUploadContentType || hasMeaningfulBody)) ||
    (isExternal && payloadInsights.hasSensitiveData)
  );
  const isHighRiskThirdPartyLeak = isHighRiskThirdParty && (
    hasMeaningfulBody ||
    queryLength >= 128 ||
    method === 'BEACON' ||
    method === 'WS-SEND'
  );
  return {
    method,
    pathname,
    hostname,
    queryLength,
    isApiLike,
    isUploadLike,
    isRemote,
    isExternal,
    isTargetOrigin,
    isIgnoredLocalApi,
    isTrustedThirdParty,
    isHighRiskThirdParty,
    isHighRiskThirdPartyLeak,
    payloadInsights,
  };
}

function buildVerdict({ targetUrl, auditStartAt, auditStopAt, requests, fileEvents, browserInfo, videoPath, outputDir }) {
  const targetOrigin = (() => {
    try {
      return new URL(targetUrl).origin;
    } catch (_) {
      return null;
    }
  })();

  const requestDetails = requests.map((item) => ({
    ...item,
    classification: classifyRequest(item, targetOrigin, {
      trustedThirdPartyDomains: browserInfo?.trustedThirdPartyDomains,
      highRiskThirdPartyDomains: browserInfo?.highRiskThirdPartyDomains,
      ignoreRules: browserInfo?.ignoreRules,
    }),
  }));
  const fileSummary = summarizeFileEvents(fileEvents);
  const firstFileSelectionAt = fileEvents
    .filter((event) => event.kind === 'file-selected' && Number.isFinite(Number(event.ts)))
    .map((event) => Number(event.ts))
    .sort((left, right) => left - right)[0] || null;
  const requestWindow = requestDetails.filter((item) => {
    const ts = Number(item.ts);
    if (!Number.isFinite(ts)) return true;
    return firstFileSelectionAt ? ts >= firstFileSelectionAt : true;
  });
  const apiCalls = requestWindow.filter((item) => item.classification.isApiLike);
  const uploadSuspects = requestWindow.filter((item) => item.classification.isUploadLike);
  const remoteWrites = uploadSuspects.filter((item) => item.classification.isRemote);
  const highRiskLeakSuspects = requestWindow.filter((item) => item.classification.isHighRiskThirdPartyLeak);

  const checks = [
    {
      key: 'noDataUploadDetected',
      label: 'No data upload detected',
      status: uploadSuspects.length === 0 ? 'pass' : 'fail',
      passed: uploadSuspects.length === 0,
      detail: uploadSuspects.length === 0
        ? 'No upload-like request was observed after file selection.'
        : `${uploadSuspects.length} upload-like request(s) were observed.`,
    },
    {
      key: 'noApiCallsDuringProcessing',
      label: 'No API calls during file processing',
      status: apiCalls.length === 0 ? 'pass' : 'fail',
      passed: apiCalls.length === 0,
      detail: apiCalls.length === 0
        ? 'No API-like request was observed after file selection.'
        : `${apiCalls.length} API-like request(s) were observed.`,
    },
    {
      key: 'fileOnlyProcessedInBrowserMemory',
      label: 'File only processed in browser memory',
      status: (fileSummary.selected.length > 0 && fileSummary.reads.length > 0 && uploadSuspects.length === 0)
        ? 'pass'
        : (fileSummary.selected.length === 0 && uploadSuspects.length === 0 && apiCalls.length === 0)
          ? 'pass'
          : (fileSummary.selected.length > 0 && fileSummary.reads.length === 0 && fileSummary.objectUrls.length > 0 && uploadSuspects.length === 0)
            ? 'warn'
            : 'inconclusive',
      passed: (fileSummary.selected.length > 0 && fileSummary.reads.length > 0 && uploadSuspects.length === 0)
        || (fileSummary.selected.length === 0 && uploadSuspects.length === 0 && apiCalls.length === 0),
      detail: fileSummary.selected.length === 0
        ? (uploadSuspects.length === 0 && apiCalls.length === 0)
          ? 'No file-selection event was captured, but no upload or suspicious API calls were detected. (Using website example file is considered safe.)'
          : 'No file-selection event was captured, and suspicious activity was detected.'
        : fileSummary.reads.length === 0
          ? fileSummary.objectUrls.length > 0
            ? 'A file was selected and URL.createObjectURL was observed, but no FileReader/Blob memory-read hook fired.'
            : 'A file was selected, but no FileReader/Blob memory-read hook fired during the audit window.'
          : uploadSuspects.length === 0
            ? 'File selection and memory reads were observed, with no upload-like request.'
            : 'File activity was observed, but network activity prevents a clean local-only conclusion.',
    },
    {
      key: 'noDataStoredOnCloud',
      label: 'No data stored on cloud',
      status: remoteWrites.length === 0 ? 'pass' : 'fail',
      passed: remoteWrites.length === 0,
      detail: remoteWrites.length === 0
        ? 'No remote upload-like request was observed.'
        : `${remoteWrites.length} remote upload-like request(s) were observed.`,
    },
    {
      key: 'thirdPartyLeakageRisk',
      label: 'No suspicious high-risk third-party leakage',
      status: highRiskLeakSuspects.length === 0 ? 'pass' : 'warn',
      passed: highRiskLeakSuspects.length === 0,
      detail: highRiskLeakSuspects.length === 0
        ? 'No suspicious payload pattern to high-risk third-party domains was observed.'
        : `${highRiskLeakSuspects.length} suspicious request(s) toward high-risk third-party domains were observed.`,
    },
  ];

  const lines = [
    'Trust Checker Report',
    '====================',
    `Version: ${VERSION}`,
    `Target URL: ${targetUrl}`,
    `Audit started: ${auditStartAt}`,
    `Audit ended: ${auditStopAt}`,
    `Artifacts directory: ${outputDir}`,
    `Browser executable: ${browserInfo.executablePath}`,
    `Video artifact: ${videoPath ? videoPath : 'not generated'}`,
    '',
    'Verdict',
    '-------',
  ];

  for (const check of checks) {
    lines.push(`${checkTag(check)} ${check.label}`);
    lines.push(`  ${check.detail}`);
  }

  lines.push('', 'Observed Files', '--------------');
  if (fileSummary.selected.length === 0) {
    lines.push('No file-selection event captured.');
  } else {
    for (const file of fileSummary.selected) {
      lines.push(`- ${file.name || '(unnamed file)'} | ${formatBytes(file.size)} | ${file.type || 'unknown mime'}`);
    }
  }

  lines.push('', 'Observed Memory Reads', '---------------------');
  if (fileSummary.reads.length === 0) {
    lines.push('No FileReader/Blob memory-read hook captured.');
  } else {
    for (const event of fileSummary.reads) {
      const size = event.file?.size || event.blob?.size || 0;
      lines.push(`- ${event.kind} | ${formatBytes(size)} | ${event.pageUrl || ''}`.trim());
    }
  }

  lines.push('', 'Observed Object URL And FormData Activity', '----------------------------------------');
  lines.push(`createObjectURL events: ${fileSummary.objectUrls.length}`);
  lines.push(`FormData append events: ${fileSummary.formDataWrites.length}`);
  lines.push(`sendBeacon events: ${fileSummary.beacons.length}`);

  lines.push('', 'Observed Network Requests', '-------------------------');
  if (requestDetails.length === 0) {
    lines.push('No network request captured in the audit window.');
  } else {
    for (const item of requestDetails) {
      const tags = [];
      if (item.classification.isApiLike) tags.push('api');
      if (item.classification.isUploadLike) tags.push('upload-like');
      if (item.classification.isRemote) tags.push('remote');
      if (item.classification.isHighRiskThirdPartyLeak) tags.push('high-risk-third-party');
      lines.push(`- ${item.method} ${shortUrl(item.url)}${tags.length ? ` [${tags.join(', ')}]` : ''}`);
      if (item.postDataSize > 0) lines.push(`  body: ${formatBytes(item.postDataSize)}`);
      if (item.postDataPreview) lines.push(`  preview: ${item.postDataPreview}`);
      if (item.classification.payloadInsights?.hasSensitiveData) {
        lines.push(`  sensitive-signals: ${item.classification.payloadInsights.signals.join(', ')}`);
      }
    }
  }

  return {
    checks,
    requestDetails,
    fileSummary,
    remoteWrites,
    apiCalls,
    uploadSuspects,
    text: `${lines.join('\n')}\n`,
  };
}

class TrustAuditSession {
  constructor(options = {}) {
    this.options = {
      targetUrl: options.targetUrl || DEFAULT_TARGET_URL,
      outputRoot: path.resolve(options.outputRoot || DEFAULT_OUTPUT_ROOT),
      viewport: {
        width: Number(options.viewport?.width || options.width || DEFAULT_VIEWPORT.width),
        height: Number(options.viewport?.height || options.height || DEFAULT_VIEWPORT.height),
      },
      headless: Boolean(options.headless),
      chromePath: options.chromePath || null,
      label: options.label || '',
      slowMo: Number(options.slowMo || 0),
      keepBrowserOpen: Boolean(options.keepBrowserOpen),
      ignoreFile: options.ignoreFile || null,
      trustedThirdPartyDomains: normalizeDomainList(options.trustedThirdPartyDomains || []),
      highRiskThirdPartyDomains: normalizeDomainList(
        options.highRiskThirdPartyDomains || DEFAULT_HIGH_RISK_THIRD_PARTY_DOMAINS
      ),
      recordVideo: typeof options.recordVideo === 'boolean'
        ? options.recordVideo
        : defaultRecordVideo({ headless: Boolean(options.headless) }),
      captureIntervalMs: Math.max(250, Number(options.captureIntervalMs || DEFAULT_CAPTURE_INTERVAL_MS)),
    };
    this.sessionId = makeTimestamp();
    this.outputDir = ensureDir(path.join(this.options.outputRoot, this.sessionId));
    this.requests = [];
    this.fileEvents = [];
    this.requestCounter = 0;
    this.auditStartAt = null;
    this.auditStopAt = null;
    this.browser = null;
    this.page = null;
    this.frameCount = 0;
    this.framesDir = path.join(this.outputDir, 'video-frames');
    this.videoPath = null;
    this.ffmpegPath = detectFfmpegExecutable();
    this.captureIntervalMs = this.options.captureIntervalMs;
    this.captureActive = false;
    this.captureLoopPromise = null;
    this.cdpSession = null;
    this.webSocketUrlMap = new Map();
    this.ignoreRules = loadIgnoreRules(this.options.ignoreFile);
    this.browserInfo = {
      executablePath: null,
      product: 'chrome',
      trustedThirdPartyDomains: this.options.trustedThirdPartyDomains,
      highRiskThirdPartyDomains: this.options.highRiskThirdPartyDomains,
      ignoreRules: this.ignoreRules,
      ignoreFileSource: this.ignoreRules._source,
    };
    this.state = 'idle';
  }

  async launch() {
    if (this.state !== 'idle') return this.status();
    const chromePath = detectChromeExecutable(this.options.chromePath);
    const puppeteer = require('puppeteer-core');
    this.browserInfo.executablePath = chromePath;
    this.browser = await puppeteer.launch({
      executablePath: chromePath,
      headless: this.options.headless ? 'new' : false,
      defaultViewport: this.options.viewport,
      slowMo: this.options.slowMo,
      args: [
        `--window-size=${this.options.viewport.width},${this.options.viewport.height}`,
        '--no-default-browser-check',
        '--disable-background-timer-throttling',
        '--disable-renderer-backgrounding',
      ],
    });
    this.page = await this.browser.newPage();
    await this.page.exposeFunction('__trustCheckerRecordFileEvent', (payload) => {
      if (!this._inAuditWindow(Number(payload?.ts || Date.now()))) return;
      this.fileEvents.push(payload);
      if (payload?.kind === 'send-beacon' && payload?.beaconUrl) {
        let resolvedUrl = String(payload.beaconUrl || '');
        try {
          resolvedUrl = new URL(String(payload.beaconUrl || ''), String(payload.pageUrl || this.options.targetUrl)).toString();
        } catch (_) {}
        const bodyPreview = sanitizeBodyPreview(payload.bodyPreview || null);
        this.requests.push({
          id: ++this.requestCounter,
          ts: Number(payload.ts || Date.now()),
          url: resolvedUrl,
          method: 'BEACON',
          resourceType: 'beacon',
          headers: {},
          postDataSize: Number(payload.bodySize || 0),
          postDataPreview: bodyPreview,
          postDataSample: typeof payload.bodyPreview === 'string' ? payload.bodyPreview.slice(0, 8192) : '',
        });
      }
    });
    this.cdpSession = await this.page.target().createCDPSession();
    await this.cdpSession.send('Network.enable');
    this.cdpSession.on('Network.webSocketCreated', (event) => {
      this.webSocketUrlMap.set(event.requestId, event.url || '');
    });
    this.cdpSession.on('Network.webSocketFrameSent', (event) => {
      const ts = Date.now();
      if (!this._inAuditWindow(ts)) return;
      const payloadData = String(event?.response?.payloadData || '');
      const preview = sanitizeBodyPreview(payloadData);
      const url = this.webSocketUrlMap.get(event.requestId) || 'ws://unknown';
      this.requests.push({
        id: ++this.requestCounter,
        ts,
        url,
        method: 'WS-SEND',
        resourceType: 'websocket-frame',
        headers: {},
        postDataSize: Buffer.byteLength(payloadData || '', 'utf8'),
        postDataPreview: preview,
        postDataSample: payloadData.slice(0, 8192),
      });
    });
    await this.page.evaluateOnNewDocument(INSTRUMENTATION_SOURCE);
    this.page.on('request', (request) => {
      const ts = Date.now();
      if (!this._inAuditWindow(ts)) return;
      const postData = request.postData();
      const record = {
        id: ++this.requestCounter,
        ts,
        url: request.url(),
        method: request.method(),
        resourceType: request.resourceType(),
        headers: request.headers(),
        postDataSize: postData ? Buffer.byteLength(postData, 'utf8') : 0,
        postDataPreview: sanitizeBodyPreview(postData),
        postDataSample: typeof postData === 'string' ? postData.slice(0, 8192) : '',
      };
      this.requests.push(record);
    });
    await this.page.goto(this.options.targetUrl, { waitUntil: 'networkidle2' });
    await this.page.evaluate(INSTRUMENTATION_SOURCE);
    this.state = 'ready';
    this._writeMetadata('launch');
    return this.status();
  }

  status() {
    return {
      state: this.state,
      sessionId: this.sessionId,
      targetUrl: this.options.targetUrl,
      outputDir: this.outputDir,
      auditStartAt: this.auditStartAt,
      auditStopAt: this.auditStopAt,
      videoPath: this.videoPath,
      browserInfo: this.browserInfo,
      ffmpegAvailable: Boolean(this.ffmpegPath),
      recordVideo: this.options.recordVideo,
      requestCount: this.requests.length,
      fileEventCount: this.fileEvents.length,
    };
  }

  async startAudit() {
    if (!this.page) throw new Error('Session not launched yet.');
    if (this.state === 'auditing') return this.status();
    this.auditStartAt = nowIso();
    this.state = 'auditing';
    await this.page.evaluate(() => {
      document.body?.setAttribute('data-trust-checker-audit', 'running');
    }).catch(() => {});
    if (this.options.recordVideo) {
      await this._startScreencast();
    }
    this._writeMetadata('audit-start');
    return this.status();
  }

  async stopAudit() {
    if (this.state !== 'auditing') {
      throw new Error('Audit is not running.');
    }
    this.auditStopAt = nowIso();
    if (this.options.recordVideo) {
      await this._stopScreencast();
    }
    const verdict = buildVerdict({
      targetUrl: this.options.targetUrl,
      auditStartAt: this.auditStartAt,
      auditStopAt: this.auditStopAt,
      requests: this.requests,
      fileEvents: this.fileEvents,
      browserInfo: this.browserInfo,
      videoPath: this.videoPath,
      outputDir: this.outputDir,
    });

    fs.writeFileSync(path.join(this.outputDir, 'network-requests.json'), JSON.stringify(verdict.requestDetails, null, 2));
    fs.writeFileSync(path.join(this.outputDir, 'file-events.json'), JSON.stringify(this.fileEvents, null, 2));
    fs.writeFileSync(path.join(this.outputDir, 'audit-summary.json'), JSON.stringify({
      version: VERSION,
      sessionId: this.sessionId,
      targetUrl: this.options.targetUrl,
      auditStartAt: this.auditStartAt,
      auditStopAt: this.auditStopAt,
      videoPath: this.videoPath,
      checks: verdict.checks,
      policy: {
        trustedThirdPartyDomains: this.options.trustedThirdPartyDomains,
        highRiskThirdPartyDomains: this.options.highRiskThirdPartyDomains,
        ignoreFileSource: this.ignoreRules._source,
      },
    }, null, 2));
    fs.writeFileSync(path.join(this.outputDir, 'audit-report.txt'), verdict.text);
    this.state = 'finished';
    this._writeMetadata('audit-stop');
    return {
      ...this.status(),
      checks: verdict.checks,
      reportPath: path.join(this.outputDir, 'audit-report.txt'),
      requestsPath: path.join(this.outputDir, 'network-requests.json'),
      fileEventsPath: path.join(this.outputDir, 'file-events.json'),
      summaryPath: path.join(this.outputDir, 'audit-summary.json'),
    };
  }

  async close() {
    if (this.cdpSession) {
      try {
        await this.cdpSession.detach();
      } catch (_) {}
    }
    this.cdpSession = null;
    if (this.browser && !this.options.keepBrowserOpen) {
      await this.browser.close();
    }
    this.browser = null;
    this.page = null;
  }

  _inAuditWindow(ts) {
    if (!this.auditStartAt) return false;
    const start = Date.parse(this.auditStartAt);
    const stop = this.auditStopAt ? Date.parse(this.auditStopAt) : Number.POSITIVE_INFINITY;
    return ts >= start && ts <= stop;
  }

  async _startScreencast() {
    if (!this.page) return;
    ensureDir(this.framesDir);
    this.frameCount = 0;
    this.captureActive = true;
    this.captureLoopPromise = (async () => {
      while (this.captureActive && this.page) {
        const filePath = path.join(this.framesDir, `frame_${String(this.frameCount).padStart(6, '0')}.jpg`);
        this.frameCount += 1;
        try {
          await this.page.screenshot({
            path: filePath,
            type: 'jpeg',
            quality: 85,
            fullPage: false,
          });
        } catch (_) {
          this.frameCount -= 1;
        }
        await new Promise((resolve) => setTimeout(resolve, this.captureIntervalMs));
      }
    })();
  }

  async _stopScreencast() {
    if (!this.captureLoopPromise) return;
    this.captureActive = false;
    await this.captureLoopPromise;
    this.captureLoopPromise = null;
    if (this.ffmpegPath && this.frameCount > 0) {
      const fps = Math.max(1, Math.round(1000 / this.captureIntervalMs));
      const outputPath = path.join(this.outputDir, 'audit-video.mp4');
      const args = [
        '-y',
        '-framerate',
        String(fps),
        '-i',
        path.join(this.framesDir, 'frame_%06d.jpg'),
        '-vf',
        'fps=20,format=yuv420p',
        '-c:v',
        'libx264',
        '-pix_fmt',
        'yuv420p',
        outputPath,
      ];
      const result = spawnSync(this.ffmpegPath, args, { encoding: 'utf8' });
      if (result.status === 0) {
        this.videoPath = outputPath;
      }
    }
  }

  _writeMetadata(stage) {
    fs.writeFileSync(path.join(this.outputDir, 'session-meta.json'), JSON.stringify({
      version: VERSION,
      stage,
      state: this.state,
      sessionId: this.sessionId,
      targetUrl: this.options.targetUrl,
      auditStartAt: this.auditStartAt,
      auditStopAt: this.auditStopAt,
      browser: this.browserInfo,
      ffmpegAvailable: Boolean(this.ffmpegPath),
      recordVideo: this.options.recordVideo,
      host: os.hostname(),
      platform: process.platform,
      arch: process.arch,
      outputDir: this.outputDir,
    }, null, 2));
  }
}

module.exports = {
  VERSION,
  DEFAULT_TARGET_URL,
  DEFAULT_OUTPUT_ROOT,
  DEFAULT_IGNORE_FILE_PATH,
  TrustAuditSession,
  buildVerdict,
  checkTag,
  classifyRequest,
  loadIgnoreRules,
  mergeIgnoreRules,
  detectChromeExecutable,
  detectFfmpegExecutable,
  formatBytes,
};