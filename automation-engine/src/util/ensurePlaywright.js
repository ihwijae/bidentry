"use strict";

const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const ENGINE_ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_DIR = path.join(os.homedir(), '.bidentry-ms-playwright');
const BUNDLED_DIR = path.join(ENGINE_ROOT, 'node_modules', 'playwright');

function platformExecutable(base) {
  const candidates = fs.existsSync(base) ? fs.readdirSync(base) : [];
  for (const entry of candidates) {
    if (!entry || !entry.startsWith('chromium-')) continue;
    const folder = path.join(base, entry);
    let exe = null;
    if (process.platform === 'win32') exe = path.join(folder, 'chrome-win', 'chrome.exe');
    else if (process.platform === 'darwin') exe = path.join(folder, 'chrome-mac', 'Chromium.app', 'Contents', 'MacOS', 'Chromium');
    else exe = path.join(folder, 'chrome-linux', 'chrome');
    if (exe && fs.existsSync(exe)) return exe;
  }
  return null;
}

function installBrowsers(targetDir, log) {
  return new Promise((resolve, reject) => {
    try { fs.mkdirSync(targetDir, { recursive: true }); } catch {}
    let installScript = null;
    let pkgRoot = null;
    try {
      const playwrightPkg = require.resolve('playwright/package.json', { paths: [ENGINE_ROOT, __dirname] });
      pkgRoot = path.dirname(playwrightPkg);
      installScript = path.join(pkgRoot, 'cli.js');
    } catch {}
    if (!installScript || !fs.existsSync(installScript)) {
      return reject(new Error('Playwright CLI not found. Ensure dependencies are installed.'));
    }
    const env = {
      ...process.env,
      PLAYWRIGHT_BROWSERS_PATH: targetDir,
      PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '',
      ELECTRON_RUN_AS_NODE: '1'
    };
    const ps = spawn(process.execPath, [installScript, 'install', 'chromium'], { env, stdio: 'inherit' });
    ps.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error('Playwright browser install failed'));
    });
    ps.on('error', reject);
  });
}

async function ensurePlaywright(browsersPath, log) {
  let target = browsersPath || process.env.PLAYWRIGHT_BROWSERS_PATH;
  if (!target && fs.existsSync(path.join(BUNDLED_DIR, 'browsers.json'))) {
    target = path.join(BUNDLED_DIR, '.local-browsers');
    process.env.PLAYWRIGHT_BROWSERS_PATH = target;
    return { browsersPath: target };
  }
  if (!target && process.env.APPDATA) {
    target = path.join(process.env.APPDATA, 'AutomationShell', 'ms-playwright');
  }
  if (!target) target = DEFAULT_DIR;
  if (platformExecutable(target)) return { browsersPath: target };
  if (typeof log === 'function') log(`[PLAYWRIGHT] 브라우저 파일이 없어 설치를 진행합니다. (${target})`);
  await installBrowsers(target, log);
  if (typeof log === 'function') log('[PLAYWRIGHT] 브라우저 설치 완료');
  return { browsersPath: target };
}

module.exports = { ensurePlaywright, DEFAULT_DIR };
