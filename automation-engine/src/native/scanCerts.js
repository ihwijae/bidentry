"use strict";

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function buildScript() {
  return `
param([string]$RootsCSV = '')

function Split-CSV([string]$s){ if([string]::IsNullOrWhiteSpace($s)){ return @() } else { return ($s -split '\\|') } }

$roots = Split-CSV $RootsCSV
if($roots.Count -eq 0){
  $roots = @()
  $ll = Join-Path $env:USERPROFILE 'AppData/LocalLow/NPKI'
  $roam = Join-Path $env:APPDATA 'NPKI'
  $roots += $ll; $roots += $roam; $roots += 'C:/NPKI'
  # Probe drives for NPKI (USB, etc.)
  Get-PSDrive -PSProvider FileSystem | ForEach-Object {
    $p = Join-Path ($_.Root) 'NPKI'
    if (Test-Path $p) { $roots += $p }
  }
}

Add-Type -AssemblyName System.Security

$results = @()
foreach($r in $roots){
  if(-not (Test-Path $r)) { continue }
  try {
    $files = Get-ChildItem -Path $r -Recurse -ErrorAction SilentlyContinue -Include 'signCert.*','kmCert.der'
    foreach($f in $files){
      try {
        $certPath = $f.FullName
        $x = New-Object System.Security.Cryptography.X509Certificates.X509Certificate2 $certPath
        $subject = $x.Subject
        $issuer = $x.Issuer
        $serial = $x.SerialNumber
        $parent = Split-Path $certPath -Parent
        # If path ends with SIGNCERT or KM, CN is parent of that; else assume current is CN
        $bn = Split-Path $parent -Leaf
        if ($bn -match '^(SIGNCERT|KM|SIGNPRI|CRYPTPRI)$') { $cnDir = Split-Path $parent -Parent } else { $cnDir = $parent }
        $results += [PSCustomObject]@{ subject=$subject; issuer=$issuer; serial=$serial; signCert=$certPath; cnDir=$cnDir }
      } catch {}
    }
  } catch {}
}

$results | ConvertTo-Json -Compress
`;
}

async function scanLocalCerts(roots) {
  const script = buildScript();
  const tmpDir = path.join(os.tmpdir(), 'cert-scan');
  fs.mkdirSync(tmpDir, { recursive: true });
  const psPath = path.join(tmpDir, `scan_${Date.now()}.ps1`);
  // UTF-16LE with BOM for PowerShell 5.x compatibility
  fs.writeFileSync(psPath, '\uFEFF' + script, 'utf16le');
  const args = ['-NoProfile','-ExecutionPolicy','Bypass','-File', psPath, '-RootsCSV', (roots||[]).join('|')];
  return await new Promise((resolve) => {
    const ps = spawn('powershell.exe', args, { stdio:['ignore','pipe','pipe'] });
    let out='', err='';
    ps.stdout.on('data', d=> out += String(d));
    ps.stderr.on('data', d=> err += String(d));
    ps.on('close', code => {
      try {
        const json = JSON.parse((out||'').trim() || '[]');
        resolve({ ok:true, items: Array.isArray(json)? json: [], err });
      } catch(e){ resolve({ ok:false, items:[], err: err || e.message }); }
      try { fs.unlinkSync(psPath); } catch {}
    });
  });
}

module.exports = { scanLocalCerts };
