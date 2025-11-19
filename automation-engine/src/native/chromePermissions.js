"use strict";

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function tmpScriptPath(){
  const dir = path.join(os.tmpdir(), 'chrome-permission-uia');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `allow_local_network_${Date.now()}.ps1`);
}

function buildScript(){
  return `
param(
  [string]$ButtonCSV = '',
  [string]$WindowCSV = '',
  [int]$TimeoutSec = 60
)

Add-Type -AssemblyName UIAutomationClient

function Split-CSV([string]$s){ if([string]::IsNullOrWhiteSpace($s)){ return @() } else { return ($s -split '\\|') } }
$Buttons = Split-CSV $ButtonCSV
$Windows = Split-CSV $WindowCSV
if($Buttons.Count -eq 0){ $Buttons = @('허용','Allow') }
if($Windows.Count -eq 0){ $Windows = @('Chrome','SRM','KEPCO') }

$deadline = (Get-Date).AddSeconds($TimeoutSec)

function Click-Permission{
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty,
    [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  for($i=0; $i -lt $wins.Count; $i++){
    $w = $wins.Item($i)
    $name = $w.Current.Name
    $class = $w.Current.ClassName
    $okWin = $false
    foreach($kw in $Windows){ if(-not [string]::IsNullOrWhiteSpace($kw) -and $name -like ('*' + $kw + '*')) { $okWin = $true; break } }
    if(-not $okWin){ continue }
    $searchRoot = $w
    foreach($btnName in $Buttons){
      if([string]::IsNullOrWhiteSpace($btnName)){ continue }
      $btnCond = New-Object System.Windows.Automation.AndCondition(
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $btnName)),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)))
      $btn = $searchRoot.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $btnCond)
      if($btn -ne $null){
        try {
          ($btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke()
          return $true
        } catch {}
      }
    }
  }
  return $false
}

while((Get-Date) -lt $deadline){
  if(Click-Permission){ Write-Output '{"ok":true}'; exit 0 }
  Start-Sleep -Milliseconds 300
}
Write-Output '{"ok":false,"error":"timeout"}'
exit 0
`;
}

function clickChromePermissionPopup(opts = {}, emit){
  return new Promise((resolve) => {
    const script = buildScript();
    const scriptPath = tmpScriptPath();
    fs.writeFileSync(scriptPath, script, 'utf-8');
    const buttons = (opts.buttonLabels || ['허용','Allow']).join('|');
    const windows = (opts.windowKeywords || ['Chrome','KEPCO','SRM']).join('|');
    const timeout = Number(opts.timeoutSec || 60);
    const ps = spawn('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File', scriptPath,
      '-ButtonCSV', buttons,
      '-WindowCSV', windows,
      '-TimeoutSec', `${timeout}`
    ], { windowsHide: true });
    let stdout = '';
    ps.stdout.on('data', chunk => { stdout += chunk.toString(); });
    ps.stderr.on('data', chunk => {
      const msg = chunk.toString().trim();
      if (msg) emit && emit({ type:'log', level:'warn', msg:`[chrome-permission] ${msg}` });
    });
    ps.on('exit', () => {
      try { fs.unlinkSync(scriptPath); } catch {}
      let json = {};
      try { json = JSON.parse(stdout.trim()); }
      catch { json = { ok:false, error:'invalid_json', raw: stdout.trim() }; }
      resolve(json);
    });
  });
}

module.exports = { clickChromePermissionPopup };
