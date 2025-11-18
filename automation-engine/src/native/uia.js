"use strict";

const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function tmpScriptPath(outDir){
  const dir = outDir || path.join(os.tmpdir(), 'cert-uia');
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, `uia_kica_${Date.now()}.ps1`);
}

function buildPowerShellScript(){
  // ASCII-only PowerShell; all localized labels are passed as parameters.
  return `
param(
  [string]$SubjectPattern = '',
  [string]$IssuerPattern = '',
  [string]$SerialPattern = '',
  [string]$Media = '',
  [string]$Pin = '',
  [string]$PathHint = '',
  [int]$TimeoutSec = 30,
  [string]$CertWinCSV = '',
  [string]$BrowseBtnCSV = '',
  [string]$DlgTitlesCSV = '',
  [string]$DlgOkCSV = '',
  [string]$DetailBtnCSV = '',
  [string]$DetailWinCSV = '',
  [string]$Manual = '0',
  [string]$SignalPath = ''
)

Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

function Split-CSV([string]$s){ if([string]::IsNullOrWhiteSpace($s)){ return @() } else { return ($s -split '\\|') } }

function Normalize-Text([string]$s){
  if([string]::IsNullOrWhiteSpace($s)){ return '' }
  $n = $s.ToLowerInvariant()
  $n = $n -replace '\\s',''
  $n = $n -replace '\\(주\\)','주식회사'
  $n = $n -replace '㈜','주식회사'
  $n = $n -replace '주식회사',''
  $n = $n -replace '유한회사',''
  $n = $n -replace '\uC8FC\uC2DD\uD68C\uC0AC',''
  $n = $n -replace '\uC720\uD55C\uD68C\uC0AC',''
  return $n
}

$CertWinTitles = Split-CSV $CertWinCSV
$BrowseBtnLabels = Split-CSV $BrowseBtnCSV
$DlgTitles = Split-CSV $DlgTitlesCSV
$DlgOkLabels = Split-CSV $DlgOkCSV
$DetailBtnLabels = Split-CSV $DetailBtnCSV
$DetailWinTitles = Split-CSV $DetailWinCSV

function Wait-Until($cond, $timeoutSec){
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while((Get-Date) -lt $deadline){ if (& $cond){ return $true } Start-Sleep -Milliseconds 200 }
  return $false
}

function Get-WindowByTitles($titles){
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  for($i=0; $i -lt $wins.Count; $i++){
    $w = $wins.Item($i)
    $n = $w.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
    foreach($t in $titles){ if(-not [string]::IsNullOrWhiteSpace($t) -and $n -like ('*' + $t + '*')) { return $w } }
  }
  return $null
}

function Fallback-FindCertWindow(){
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  for($i=0; $i -lt $wins.Count; $i++){
    $w = $wins.Item($i)
    # Heuristic: has an Edit (PIN), a confirm button, and a DataGrid/List
    $hasEdit = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit))) -ne $null
    $hasButton = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))) -ne $null
    $hasList = $w.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
      (New-Object System.Windows.Automation.OrCondition(
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::DataGrid)),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Table)),
        (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::List))
      ))) -ne $null
    if($hasEdit -and $hasButton -and $hasList){ return $w }
  }
  return $null
}

function Click-ByAnyName($root, $names){
  foreach($name in $names){
    $cond = New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)),
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))
    )
    $btn = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
    if($btn -ne $null){ ($btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke(); return $true }
  }
  return $false
}

function Close-Window($w){
  try {
    $wp = $w.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
    if($wp -ne $null){ $wp.Close(); return }
  } catch {}
  [System.Windows.Forms.SendKeys]::SendWait('%{F4}')
}

function Select-Certificate($root, $subjectLike, $issuerLike){
  $normSubject = Normalize-Text($subjectLike)
  $normIssuer = Normalize-Text($issuerLike)
  $listCond = New-Object System.Windows.Automation.OrCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::DataGrid)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Table)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::List))
  )
  $list = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $listCond)
  if($list -eq $null){ return $false }
  $rows = $list.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::DataItem)))
  if($rows.Count -eq 0){ $rows = $list.FindAll([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem))) }
  for($i=0; $i -lt $rows.Count; $i++){
    $r = $rows.Item($i)
    $txts = $r.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))
    $acc = ''
    for($j=0; $j -lt $txts.Count; $j++){ $acc += ($txts.Item($j).Current.Name + ' ') }
    $normAcc = Normalize-Text($acc)
    $matchSubject = ([string]::IsNullOrWhiteSpace($subjectLike) -or $acc -like ('*' + $subjectLike + '*') -or ((-not [string]::IsNullOrWhiteSpace($normSubject)) -and $normAcc.Contains($normSubject)))
    $matchIssuer = ([string]::IsNullOrWhiteSpace($issuerLike) -or $acc -like ('*' + $issuerLike + '*') -or ((-not [string]::IsNullOrWhiteSpace($normIssuer)) -and $normAcc.Contains($normIssuer)))
    if($matchSubject -and $matchIssuer){
      $sel = $r.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $sel.Select()
      if([string]::IsNullOrWhiteSpace($SerialPattern)) { return $true }
      # If SerialPattern is provided, open detail and verify
      if($DetailBtnLabels.Count -gt 0){ [void](Click-ByAnyName $root $DetailBtnLabels) }
      Start-Sleep -Milliseconds 200
      $ok = Wait-Until { (Get-WindowByTitles $DetailWinTitles) -ne $null } 3
      if($ok){
        $dw = Get-WindowByTitles $DetailWinTitles
        if($dw -ne $null){
          $txts2 = $dw.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))
          $blob=''
          for($k=0;$k -lt $txts2.Count;$k++){ $blob += ($txts2.Item($k).Current.Name + ' ') }
          if($blob -like ('*' + $SerialPattern + '*')){ return $true }
          Close-Window $dw
        }
      }
      # Not matched; continue trying next row
    }
  }
  return $false
}

function Try-IterateByDetails($root, $subjectLike, $issuerLike){
  $normSubject = Normalize-Text($subjectLike)
  $normIssuer = Normalize-Text($issuerLike)
  # Find list and all rows
  $listCond = New-Object System.Windows.Automation.OrCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::DataGrid)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Table)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::List))
  )
  $list = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $listCond)
  if($list -eq $null){ return $false }
  $rows = $list.FindAll([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)))
  if($rows.Count -eq 0){
    $rows = $list.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::DataItem)))
  }
  if($rows.Count -eq 0){
    # Fallback to keyboard when rows not accessible
    try { $list.SetFocus() } catch {}
    [System.Windows.Forms.SendKeys]::SendWait('{HOME}')
    Start-Sleep -Milliseconds 120
    for($i=0; $i -lt 200; $i++){
      if($DetailBtnLabels.Count -gt 0){ [void](Click-ByAnyName $root $DetailBtnLabels) }
      Start-Sleep -Milliseconds 200
      $ok = Wait-Until { (Get-WindowByTitles $DetailWinTitles) -ne $null } 2
      if($ok){
        $dw = Get-WindowByTitles $DetailWinTitles
        if($dw -ne $null){
          $txts2 = $dw.FindAll([System.Windows.Automation.TreeScope]::Descendants,
            (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))
          $blob=''
          for($k=0;$k -lt $txts2.Count;$k++){ $blob += ($txts2.Item($k).Current.Name + ' ') }
      $normBlob = Normalize-Text($blob)
      $okSub = ([string]::IsNullOrWhiteSpace($subjectLike) -or $blob -like ('*' + $subjectLike + '*') -or ((-not [string]::IsNullOrWhiteSpace($normSubject)) -and $normBlob.Contains($normSubject)))
      $okIss = ([string]::IsNullOrWhiteSpace($issuerLike) -or $blob -like ('*' + $issuerLike + '*') -or ((-not [string]::IsNullOrWhiteSpace($normIssuer)) -and $normBlob.Contains($normIssuer)))
          $okSer = ([string]::IsNullOrWhiteSpace($SerialPattern) -or $blob -like ('*' + $SerialPattern + '*'))
          if($okSub -and $okIss -and $okSer){ Close-Window $dw; return $true }
          Close-Window $dw
        }
      }
      try { $list.SetFocus() } catch {}
      [System.Windows.Forms.SendKeys]::SendWait('{DOWN}')
      Start-Sleep -Milliseconds 120
    }
    return $false
  }

  # Directly iterate UIA rows with SelectionItemPattern
  for($i=0; $i -lt $rows.Count; $i++){
    $r = $rows.Item($i)
    try {
      $sel = $r.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $sel.Select()
    } catch {}
    if($DetailBtnLabels.Count -gt 0){ [void](Click-ByAnyName $root $DetailBtnLabels) }
    Start-Sleep -Milliseconds 200
    $ok = Wait-Until { (Get-WindowByTitles $DetailWinTitles) -ne $null } 2
    if($ok){
      $dw = Get-WindowByTitles $DetailWinTitles
      if($dw -ne $null){
        $txts2 = $dw.FindAll([System.Windows.Automation.TreeScope]::Descendants,
          (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))
        $blob=''
        for($k=0;$k -lt $txts2.Count;$k++){ $blob += ($txts2.Item($k).Current.Name + ' ') }
        $normBlob = Normalize-Text($blob)
        $okSub = ([string]::IsNullOrWhiteSpace($subjectLike) -or $blob -like ('*' + $subjectLike + '*') -or ((-not [string]::IsNullOrWhiteSpace($normSubject)) -and $normBlob.Contains($normSubject)))
        $okIss = ([string]::IsNullOrWhiteSpace($issuerLike) -or $blob -like ('*' + $issuerLike + '*') -or ((-not [string]::IsNullOrWhiteSpace($normIssuer)) -and $normBlob.Contains($normIssuer)))
        $okSer = ([string]::IsNullOrWhiteSpace($SerialPattern) -or $blob -like ('*' + $SerialPattern + '*'))
        if($okSub -and $okIss -and $okSer){ Close-Window $dw; return $true }
        Close-Window $dw
      }
    }
  }
  return $false
}

function Set-Pin($root, [string]$pin){
  $edit = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsEnabledProperty, $true))
    ))
  )
  if($edit -eq $null){ return $false }
  $value = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
  $value.SetValue($pin)
  return $true
}

function Choose-PathIfNeeded($root, [string]$path){
  if([string]::IsNullOrWhiteSpace($path)){ return $true }
  # Avoid clicking the media button named '인증서 찾기' at top; rely on generic labels
  if($BrowseBtnLabels.Count -gt 0){ [void](Click-ByAnyName $root $BrowseBtnLabels) }
  Start-Sleep -Milliseconds 200
  $ok = Wait-Until { (Get-WindowByTitles $DlgTitles) -ne $null } 5
  if(-not $ok){ return $false }
  $dlg = Get-WindowByTitles $DlgTitles
  if($dlg -eq $null){ return $false }
  $edit = $dlg.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsEnabledProperty, $true))
    )));
  if($edit -ne $null){
    $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue($path)
  } else {
    [System.Windows.Forms.SendKeys]::SendWait('^l')
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait($path)
  }
  if($DlgOkLabels.Count -gt 0){ [void](Click-ByAnyName $dlg $DlgOkLabels) } else { [System.Windows.Forms.SendKeys]::SendWait("{ENTER}") }
  Start-Sleep -Milliseconds 300
  return $true
}

$ok = Wait-Until { (Get-WindowByTitles $CertWinTitles) -ne $null -or (Fallback-FindCertWindow) -ne $null } $TimeoutSec
if(-not $ok){
  # Dump window titles for debugging
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  $arr = @()
  for($i=0; $i -lt $wins.Count; $i++){
    $w = $wins.Item($i)
    $n = $w.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
    $arr += $n
  }
  $obj = @{ ok = $false; error = 'cert_window_not_found'; windows = $arr }
  ($obj | ConvertTo-Json -Compress | Out-String).Trim() | Write-Output
  exit 2
}
$win = Get-WindowByTitles $CertWinTitles
if($win -eq $null){ $win = Fallback-FindCertWindow }

if($Manual -eq '1'){
  # Bring to front and optionally select media, then wait for user to finish
  try {
    $wp = $win.GetCurrentPattern([System.Windows.Automation.WindowPattern]::Pattern)
    if($wp -ne $null){ $wp.SetWindowVisualState([System.Windows.Automation.WindowVisualState]::Normal) }
  } catch {}
  if($Media -ne ''){ [void](Click-ByAnyName $win @($Media)); Start-Sleep -Milliseconds 150 }
  # Inform caller we're in manual wait mode (intermediate log)
  Write-Output '{"ok":true,"wait":"manual"}'
  # Wait up to extended time for the window to close
  $maxSec = [Math]::Max(60, $TimeoutSec)
  $done = Wait-Until { ((Get-WindowByTitles $CertWinTitles) -eq $null -and (Fallback-FindCertWindow) -eq $null) -or ((-not [string]::IsNullOrWhiteSpace($SignalPath)) -and (Test-Path $SignalPath)) } $maxSec
  if((-not [string]::IsNullOrWhiteSpace($SignalPath)) -and (Test-Path $SignalPath)) { try { Remove-Item -Force $SignalPath | Out-Null } catch {} }
  if($done){ Write-Output '{"ok":true,"user":"done"}'; exit 0 } else { Write-Output '{"ok":false,"error":"user_timeout"}'; exit 4 }
}

if($Media -ne ''){ [void](Click-ByAnyName $win @($Media)); Start-Sleep -Milliseconds 200 }
$null = Choose-PathIfNeeded $win $PathHint
$selOk = Select-Certificate $win $SubjectPattern $IssuerPattern
if(-not $selOk){
  # Try keyboard iteration with details window validation
  $selOk = Try-IterateByDetails $win $SubjectPattern $IssuerPattern
}
if(-not $selOk){
  # Try to collect first few row texts for debugging
  $listCond = New-Object System.Windows.Automation.OrCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::DataGrid)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Table)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::List))
  )
  $list = $win.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $listCond)
  $rowsDump = @()
  if($list -ne $null){
    $rows = $list.FindAll([System.Windows.Automation.TreeScope]::Children, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::ListItem)))
    for($i=0; $i -lt [Math]::Min(5, $rows.Count); $i++){
      $r = $rows.Item($i)
      $txts = $r.FindAll([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Text)))
      $acc = ''
      for($j=0; $j -lt $txts.Count; $j++){ $acc += ($txts.Item($j).Current.Name + ' ') }
      $rowsDump += $acc
    }
  }
  $obj = @{ ok = $false; error = 'cert_item_not_found'; rows = $rowsDump }
  ($obj | ConvertTo-Json -Compress | Out-String).Trim() | Write-Output
  exit 3
}

if($Pin -ne ''){ [void](Set-Pin $win $Pin) }
if($DlgOkLabels.Count -gt 0){ [void](Click-ByAnyName $win $DlgOkLabels) } else { [System.Windows.Forms.SendKeys]::SendWait("{ENTER}") }
Start-Sleep -Milliseconds 300
Write-Output '{"ok":true}'
`;} 

async function selectCertificateAndConfirm(options, emit){
  const outDir = options?.outDir || path.join(os.tmpdir(), 'cert-uia');
  const psPath = tmpScriptPath(outDir);
  // Write with UTF-16LE BOM — reliably parsed by Windows PowerShell 5.x for non-ASCII
  const script = buildPowerShellScript();
  fs.writeFileSync(psPath, '\uFEFF' + script, 'utf16le');
  const signalPath = options?.signalPath || path.join(os.tmpdir(), 'cert-uia-manual.signal');
  try { if (fs.existsSync(signalPath)) fs.unlinkSync(signalPath); } catch {}
  const args = [
    '-NoProfile','-ExecutionPolicy','Bypass',
    '-File', psPath,
    '-SubjectPattern', options?.subjectMatch || '',
    '-IssuerPattern', options?.issuerMatch || '',
    '-SerialPattern', options?.serialMatch || '',
    '-Media', options?.media || '',
    '-Pin', options?.pin || '',
    '-PathHint', options?.path || '',
    '-TimeoutSec', String(options?.timeoutSec || 30),
    '-CertWinCSV', (options?.labels?.certWindowTitles || []).join('|'),
    '-BrowseBtnCSV', (options?.labels?.browseBtnLabels || []).join('|'),
    '-DlgTitlesCSV', (options?.labels?.dialogTitles || []).join('|'),
    '-DlgOkCSV', (options?.labels?.dialogOkLabels || []).join('|'),
    '-DetailBtnCSV', (options?.labels?.detailBtnLabels || []).join('|'),
    '-DetailWinCSV', (options?.labels?.detailWinTitles || []).join('|'),
    '-Manual', (options?.manual ? '1' : '0'),
    '-SignalPath', signalPath
  ];
  return await new Promise((resolve) => {
    const ps = spawn('powershell.exe', args, { stdio: ['ignore','pipe','pipe'] });
    let out=''; let err='';
    ps.stdout.on('data', d=>{ out += String(d); });
    ps.stderr.on('data', d=>{ err += String(d); });
    ps.on('close', code => {
      let res = null;
      try { res = JSON.parse((out||'').trim().split(/\r?\n/).filter(Boolean).slice(-1)[0]||'{}'); } catch {}
      if (emit) emit({ type:'log', level: code===0?'info':'error', msg:`[UIA] exit ${code}, out=${out.trim()} err=${err.trim()}` });
      if (res && typeof res.ok === 'boolean') return resolve(res);
      resolve({ ok: code===0, error: err || 'UIA unknown result' });
    });
  });
}

module.exports = { selectCertificateAndConfirm };
