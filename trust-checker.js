#!/usr/bin/env node

const readline = require('readline');
const minimist = require('minimist');
const {
  VERSION,
  DEFAULT_TARGET_URL,
  DEFAULT_OUTPUT_ROOT,
  TrustAuditSession,
  checkTag,
} = require('./trust-checker-core');

function printHelp() {
  console.log(`Trust Checker CLI v${VERSION}

Usage:
  npm run trust:checker -- --url http://127.0.0.1:3106/app?_forceEmail=1
  node "./trust-checker.js" --url https://www.qingxiflow.com/app

Options:
  --url          Target page to audit
  --outputRoot   Artifact root directory
  --chromePath   Chrome/Chromium executable path
  --headless     Run browser headless
  --width        Browser viewport width
  --height       Browser viewport height
  --slowMo       Puppeteer slowMo in milliseconds
  --video        Enable video capture during the audit window
  --no-video     Disable video capture during the audit window
  --manualStart  Wait for Enter before starting the audit window
  --keepBrowser  Keep browser open after report generation
  --trustedDomains   Comma-separated or repeated trusted third-party domains
  --highRiskDomains  Comma-separated or repeated high-risk third-party domains
  --ignoreFile       Path to a custom audit-ignore.json (default: ref/audit-ignore.json)
  --help         Show this help
`);
}

function waitForEnter(prompt) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(prompt, () => {
      rl.close();
      resolve();
    });
  });
}

function parseDomainListArg(value) {
  if (!value) return [];
  const items = Array.isArray(value) ? value : [value];
  return items
    .flatMap((item) => String(item || '').split(','))
    .map((item) => item.trim())
    .filter(Boolean);
}

async function main() {
  const args = minimist(process.argv.slice(2), {
    string: ['url', 'outputRoot', 'chromePath', 'trustedDomains', 'highRiskDomains', 'ignoreFile'],
    boolean: ['headless', 'help', 'keepBrowser', 'video'],
    default: {
      url: DEFAULT_TARGET_URL,
      outputRoot: DEFAULT_OUTPUT_ROOT,
    },
  });

  if (args.help) {
    printHelp();
    return;
  }

  const session = new TrustAuditSession({
    targetUrl: args.url,
    outputRoot: args.outputRoot,
    chromePath: args.chromePath,
    headless: args.headless,
    width: args.width,
    height: args.height,
    slowMo: args.slowMo,
    keepBrowserOpen: args.keepBrowser,
    recordVideo: typeof args.video === 'boolean' ? args.video : undefined,
    trustedThirdPartyDomains: parseDomainListArg(args.trustedDomains),
    highRiskThirdPartyDomains: parseDomainListArg(args.highRiskDomains),
    ignoreFile: args.ignoreFile || null,
  });

  const cleanup = async () => {
    try {
      await session.close();
    } catch (_) {}
  };

  process.on('SIGINT', async () => {
    console.error('\nInterrupted. Closing browser.');
    await cleanup();
    process.exit(1);
  });

  try {
    await session.launch();
    console.log(`Opened ${args.url}`);
    console.log(`Artifacts will be written to: ${session.outputDir}`);
    if (args.manualStart) {
      console.log('Prepare the page first. Sign in if needed, then return to this terminal.');
      await waitForEnter('Press Enter to start the audit window... ');
      await session.startAudit();
      console.log('Audit window is active. Upload a file and process it in the browser.');
    } else {
      await session.startAudit();
      console.log('Audit window started automatically. Upload a file and process it in the browser.');
      console.log('If you need the old prepare-then-start flow, run with --manualStart.');
    }
    await waitForEnter('Press Enter to stop the audit and write the report... ');
    const result = await session.stopAudit();
    console.log('Audit finished.');
    console.log(`Report: ${result.reportPath}`);
    console.log(`Requests: ${result.requestsPath}`);
    console.log(`File events: ${result.fileEventsPath}`);
    console.log(`Summary: ${result.summaryPath}`);
    if (result.videoPath) {
      console.log(`Video: ${result.videoPath}`);
    } else {
      console.log(session.options.recordVideo
        ? 'Video: not generated (ffmpeg not found or no frames captured)'
        : 'Video: disabled for this run');
    }
    for (const check of result.checks || []) {
      console.log(`${checkTag(check)} ${check.label}`);
    }
  } finally {
    await cleanup();
  }
}

main().catch((error) => {
  console.error(error.message || error);
  process.exit(1);
});