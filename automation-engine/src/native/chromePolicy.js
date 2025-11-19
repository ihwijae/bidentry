"use strict";

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function tmpScriptPath(){
  const dir = path.join(os.tmpdir(), 'chrome-policy');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `set_local_network_${Date.now()}.ps1`);
}

function buildScript(){
  return `
param(
  [string]$OriginsCSV = '',
  [int]$TimeoutSec = 30
)

$origins = @()
if(-not [string]::IsNullOrWhiteSpace($OriginsCSV)){
  $tmp = $OriginsCSV -split '\\|'
  foreach($o in $tmp){ if(-not [string]::IsNullOrWhiteSpace($o)){ $origins += $o.Trim() } }
}
$origins = $origins | Sort-Object -Unique
if($origins.Count -eq 0){ Write-Output '{"ok":true,"msg":"no_origins"}'; exit 0 }

$paths = @('HKCU:\\SOFTWARE\\Policies\\Google\\Chrome','HKCU:\\SOFTWARE\\Policies\\Chromium')
foreach($p in $paths){
  try {
    if(-not (Test-Path $p)) { New-Item -Path $p -Force | Out-Null }
    Remove-ItemProperty -Path $p -Name 'InsecurePrivateNetworkRequestsAllowedForUrls' -ErrorAction SilentlyContinue
    New-ItemProperty -Path $p -Name 'InsecurePrivateNetworkRequestsAllowedForUrls' -PropertyType MultiString -Value $origins -Force | Out-Null
  } catch {
    Write-Output ('{"ok":false,"error":"' + $_.Exception.Message.Replace('"','\"') + '"}')
    exit 0
  }
}
Write-Output '{"ok":true}'
exit 0
`;
}

function ensureChromeLocalNetworkPolicy(origins = [], emit){
  const filtered = (Array.isArray(origins) ? origins : []).map(o => String(o || '').trim()).filter(Boolean);
  if (!filtered.length) return Promise.resolve({ ok: true, skipped: true });
  return new Promise((resolve) => {
    const script = buildScript();
    const scriptPath = tmpScriptPath();
    fs.writeFileSync(scriptPath, script, 'utf-8');
    const joined = filtered.join('|');
    const ps = spawn('powershell.exe', [
      '-NoProfile','-ExecutionPolicy','Bypass','-File', scriptPath,
      '-OriginsCSV', joined,
      '-TimeoutSec', '30'
    ], { windowsHide: true });
    let stdout = '';
    ps.stdout.on('data', chunk => { stdout += chunk.toString(); });
    ps.stderr.on('data', chunk => {
      const msg = chunk.toString().trim();
      if (msg) emit && emit({ type:'log', level:'warn', msg:`[chrome-policy] ${msg}` });
    });
    ps.on('exit', () => {
      try { fs.unlinkSync(scriptPath); } catch {}
      let json = {};
      try { json = JSON.parse(stdout.trim()); }
      catch { json = { ok:false, error:'invalid_json', raw: stdout.trim() }; }
      if (!json.ok) {
        emit && emit({ type:'log', level:'warn', msg:`[browser] Chrome 정책 설정 실패: ${json.error || json.raw || 'unknown'}` });
      } else {
        emit && emit({ type:'log', level:'info', msg:`[browser] Chrome 정책에 로컬 네트워크 허용 등록 (${filtered.join(', ')})` });
      }
      resolve(json);
    });
  });
}

module.exports = { ensureChromeLocalNetworkPolicy };
