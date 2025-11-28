// Minimal Electron shell that runs the automation engine CLI
'use strict';

let app, BrowserWindow, ipcMain, dialog, globalShortcut;
try {
  // In real Electron runtime, this provides { app, BrowserWindow, ... }
  ({ app, BrowserWindow, ipcMain, dialog, globalShortcut } = require('electron'));
} catch {}
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

let mainWindow = null;

if (!process.env.NODE_ENV) {
  process.env.NODE_ENV = (app && app.isPackaged) ? 'production' : 'development';
}

const resolveEngineRoot = () => {
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath || path.resolve(__dirname), 'engine');
  }
  return path.resolve(__dirname, '..', 'automation-engine');
};

const resolveAppIcon = () => {
  if (app && app.isPackaged) {
    return path.join(process.resourcesPath || path.resolve(__dirname), 'icon.ico');
  }
  return path.resolve(__dirname, '..', 'icon.ico');
};

// Dev auto-reload (only when not packaged)
const isPackaged = app ? app.isPackaged : false;
if (!isPackaged) {
  try {
    require('electron-reloader')(module, {
      ignore: ['dist', 'resources', 'node_modules']
    });
  } catch {}
}

// Simple JSON store for settings in userData
function getUserDataDir() {
  if (app && typeof app.getPath === 'function') return app.getPath('userData');
  return path.resolve(__dirname, '.userData');
}
function settingsPath() { return path.join(getUserDataDir(), 'settings.json'); }
function loadSettings() {
  try { return JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')); } catch { return {}; }
}
function saveSettings(data) {
  const dir = getUserDataDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(settingsPath(), JSON.stringify(data, null, 2), 'utf-8');
}

function resolveEngineScript() {
  const root = resolveEngineRoot();
  return path.join(root, 'src', 'cli.js');
}

function runEngineFromElectron(argv, extraEnv = {}) {
  const enginePath = resolveEngineScript();
  const args = argv.length > 0 ? argv : ['--demo'];

  const childEnv = { ...process.env, ELECTRON_RUN_AS_NODE: '1', ...extraEnv };
  const ps = spawn(process.execPath, [enginePath, ...args], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: childEnv
  });

  ps.stdout.setEncoding('utf8');
  ps.stdout.on('data', chunk => {
    const lines = String(chunk).split(/\r?\n/);
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const evt = JSON.parse(line);
        // For now, just log to console. Later, bridge to renderer or write JSONL file.
        console.log('[engine]', evt);
      } catch {
        console.log('[engine-raw]', line);
      }
    }
  });

  ps.stderr.setEncoding('utf8');
  ps.stderr.on('data', chunk => console.error('[engine-stderr]', String(chunk).trim()));

  ps.on('close', code => {
    console.log(`[engine] exit code ${code}`);
    // In Electron mode, do not exit the whole app here.
    // The caller (IPC handler) will handle notifying the renderer.
  });

  return ps;
}

if (app && typeof app.whenReady === 'function') {
  // Normal Electron mode
  app.whenReady().then(() => {
    // Create BrowserWindow (UI)
    const win = new BrowserWindow({
      width: 1180,
      height: 820,
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
      },
      icon: resolveAppIcon()
    });
    mainWindow = win;
    win.removeMenu?.();
    const devServerUrl = process.env.VITE_DEV_SERVER_URL;
    if (devServerUrl) {
      win.loadURL(devServerUrl);
    } else {
      win.loadFile(path.join(__dirname, 'renderer', 'dist', 'index.html'));
    }

    // IPC: settings load/save
    ipcMain.handle('settings:load', () => loadSettings());
    ipcMain.handle('settings:save', (_evt, data) => { saveSettings(data); return { ok: true }; });
    // IPC: open file/folder dialog for certificate path
    ipcMain.handle('dialog:selectPath', async (_evt, opts) => {
      if (!dialog) return { ok:false, error:'dialog unavailable' };
      const res = await dialog.showOpenDialog(win, {
        properties: ['openDirectory','dontAddToRecent'],
        title: opts?.title || '인증서 경로 선택',
        buttonLabel: '폴더 선택',
        defaultPath: opts?.defaultPath || undefined
      });
      if (res.canceled || !res.filePaths?.length) return { ok:false, canceled:true };
      return { ok:true, path: res.filePaths[0] };
    });

    // IPC: inspect certificate under a CN folder or a direct signCert.der path
    ipcMain.handle('cert:inspect', async (_evt, inputPath) => {
      try {
        const psScript = `
param([string]$P)
Add-Type -AssemblyName System.Security
function Find-SignCert([string]$p){
  if(-not (Test-Path $p)) { return $null }
  if((Get-Item $p).PSIsContainer){
    $cand1 = Join-Path $p 'SIGNCERT/signCert.der'
    if(Test-Path $cand1){ return $cand1 }
    $f = Get-ChildItem -Path $p -Recurse -ErrorAction SilentlyContinue -Include 'signCert.*','kmCert.der' | Select-Object -First 1
    if($f){ return $f.FullName } else { return $null }
  } else {
    if($p -like '*.der'){ return $p } else { return $null }
  }
}
$sc = Find-SignCert $P
if(-not $sc){ Write-Output '{"ok":false,"error":"signCert_not_found"}'; exit 1 }
$x = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $sc
$obj = @{ ok=$true; signCert=$sc; subject=$x.Subject; issuer=$x.Issuer; serial=$x.SerialNumber }
($obj | ConvertTo-Json -Compress | Out-String).Trim() | Write-Output
`;
        const ps = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-Command', psScript, '--', '-P', inputPath], { stdio:['ignore','pipe','pipe'] });
        let out=''; let err='';
        ps.stdout.on('data', d=> out += String(d));
        ps.stderr.on('data', d=> err += String(d));
        const res = await new Promise(resolve => ps.on('close', code => resolve({ code })));
        const last = (out||'').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0] || '{}';
        const json = JSON.parse(last);
        return json;
      } catch (e) {
        return { ok:false, error: String(e.message||e) };
      }
    });

    // IPC: run job (build temp job file from payload)
    let currentPs = null;
    ipcMain.handle('engine:run', (_evt, payload) => {
      if (currentPs) return { ok: false, error: 'Engine already running' };
      const jobDir = path.join(getUserDataDir(), 'jobs');
      fs.mkdirSync(jobDir, { recursive: true });
      const jobPath = path.join(jobDir, `job_${Date.now()}.json`);
      fs.writeFileSync(jobPath, JSON.stringify(payload, null, 2), 'utf-8');
      const args = ['--job', jobPath];
      const browsersDir = path.join(getUserDataDir(), 'ms-playwright');
      try { fs.mkdirSync(browsersDir, { recursive: true }); } catch {}
      currentPs = runEngineFromElectron(args, { PLAYWRIGHT_BROWSERS_PATH: browsersDir });
      currentPs.stdout?.on('data', chunk => {
        const lines = String(chunk).split(/\r?\n/);
        for (const line of lines) {
          if (!line.trim()) continue;
          let evt = null;
          try { evt = JSON.parse(line); } catch { evt = { type: 'raw', line }; }
          win.webContents.send('engine:event', evt);
        }
      });
      currentPs.on('close', code => {
        try {
          if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
            win.webContents.send('engine:exit', { code });
          }
        } catch {}
        currentPs = null;
      });
      return { ok: true };
    });

    ipcMain.handle('engine:stop', () => {
      if (!currentPs) return { ok: false, error: 'Not running' };
      try { currentPs.kill(); } catch {}
      return { ok: true };
    });

    ipcMain.handle('devtools:open', () => {
      const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : win;
      if (!target) return { ok: false, error: 'window unavailable' };
      try {
        target.webContents.openDevTools({ mode: 'detach' });
        return { ok: true };
      } catch (err) {
        return { ok: false, error: (err && err.message) || String(err) };
      }
    });


    if (globalShortcut) {
      globalShortcut.register('Alt+F12', () => {
        const target = mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
        if (target) {
          try { target.webContents.openDevTools({ mode: 'detach' }); } catch {}
        }
      });
    }

    app.on('window-all-closed', () => { app.quit(); });
    app.on('will-quit', () => { try { globalShortcut?.unregisterAll(); } catch {} });
  });
} else {
  // Fallback: run as plain Node (useful in limited CI/sandbox)
  const engineArgs = process.argv.slice(2);
  const enginePath = resolveEngineScript();
  const ps = spawn(process.execPath, [enginePath, ...engineArgs], { stdio: ['ignore', 'pipe', 'inherit'] });
  ps.stdout.on('data', chunk => process.stdout.write(String(chunk)));
  ps.on('close', code => process.exit(code ?? 0));
}
