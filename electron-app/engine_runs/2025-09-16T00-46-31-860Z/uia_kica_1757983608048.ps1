
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
Add-Type -AssemblyName System.Windows.Forms

param(
  [string]$SubjectPattern = '',
  [string]$IssuerPattern = '',
  [string]$Media = '하드디스크',
  [string]$Pin = '',
  [string]$PathHint = '',
  [int]$TimeoutSec = 30
)

function Wait-Until($cond, $timeoutSec){
  $deadline = (Get-Date).AddSeconds($timeoutSec)
  while((Get-Date) -lt $deadline){ if (& $cond){ return $true } Start-Sleep -Milliseconds 200 }
  return $false
}

function Get-WindowLike([string]$nameLike){
  $root = [System.Windows.Automation.AutomationElement]::RootElement
  $cond = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Window)
  $wins = $root.FindAll([System.Windows.Automation.TreeScope]::Children, $cond)
  for($i=0; $i -lt $wins.Count; $i++){
    $w = $wins.Item($i)
    $n = $w.GetCurrentPropertyValue([System.Windows.Automation.AutomationElement]::NameProperty)
    if(($n -like "*인증서 선택*") -or ($n -like "*공동인증서*")) { return $w }
  }
  return $null
}

function Click-ByName($root, [string]$name){
  $cond = New-Object System.Windows.Automation.AndCondition(
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, $name)),
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button))
  )
  $btn = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, $cond)
  if($btn -ne $null){
    $invoke = $btn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)
    $invoke.Invoke()
    return $true
  }
  return $false
}

function Select-Certificate($root, $subjectLike, $issuerLike){
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
    if(($subjectLike -eq '' -or $acc -like ('*' + $subjectLike + '*')) -and ($issuerLike -eq '' -or $acc -like ('*' + $issuerLike + '*'))){
      $sel = $r.GetCurrentPattern([System.Windows.Automation.SelectionItemPattern]::Pattern)
      $sel.Select()
      return $true
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
  # Try to click a button like '인증서 찾기' or '찾기'
  $btnNames = @('인증서 찾기','찾기','찾아보기','열기','경로','경로 변경')
  foreach($bn in $btnNames){ if(Click-ByName $root $bn){ break } }
  Start-Sleep -Milliseconds 200
  # Common File/Folder Dialog
  $ok = Wait-Until { (Get-WindowLike '열기') -ne $null -or (Get-WindowLike '폴더 선택') -ne $null -or (Get-WindowLike '찾아보기') -ne $null } 5
  if(-not $ok){ return $false }
  $dlg = (Get-WindowLike '열기'); if($dlg -eq $null){ $dlg = (Get-WindowLike '폴더 선택') }; if($dlg -eq $null){ $dlg = (Get-WindowLike '찾아보기') }
  if($dlg -eq $null){ return $false }
  # Prefer an enabled Edit control (파일 이름 or 경로 입력)
  $edit = $dlg.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.AndCondition(
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Edit)),
      (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::IsEnabledProperty, $true))
    )));
  if($edit -ne $null){
    $vp = $edit.GetCurrentPattern([System.Windows.Automation.ValuePattern]::Pattern)
    $vp.SetValue($path)
  } else {
    # Fallback: focus address bar then send keys
    [System.Windows.Forms.SendKeys]::SendWait('^l')
    Start-Sleep -Milliseconds 100
    [System.Windows.Forms.SendKeys]::SendWait($path)
  }
  # Click OK/열기/폴더 선택/선택 (some dialogs use these labels)
  $okBtn = $dlg.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '확인')))
  if($okBtn -eq $null){ $okBtn = $dlg.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '열기'))) }
  if($okBtn -eq $null){ $okBtn = $dlg.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '폴더 선택'))) }
  if($okBtn -eq $null){ $okBtn = $dlg.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '선택'))) }
  if($okBtn -eq $null){ $okBtn = $dlg.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '열기(O)'))) }
  if($okBtn -eq $null){ $okBtn = $dlg.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::NameProperty, '확인(O)'))) }
  if($okBtn -ne $null){ ($okBtn.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern)).Invoke() } else { [System.Windows.Forms.SendKeys]::SendWait("{ENTER}") }
  Start-Sleep -Milliseconds 300
  return $true
}

$ok = Wait-Until { (Get-WindowLike '인증서 선택') -ne $null } $TimeoutSec
if(-not $ok){ Write-Output '{"ok":false, "error":"인증서 선택 창을 찾지 못했습니다."}'; exit 2 }
$win = Get-WindowLike '인증서 선택'

if($Media -ne ''){ [void](Click-ByName $win $Media); Start-Sleep -Milliseconds 200 }
$null = Choose-PathIfNeeded $win $PathHint
$selOk = Select-Certificate $win $SubjectPattern $IssuerPattern
if(-not $selOk){ Write-Output '{"ok":false, "error":"인증서 목록에서 항목을 찾지 못했습니다."}'; exit 3 }

if($Pin -ne ''){ [void](Set-Pin $win $Pin) }
[void](Click-ByName $win '확인')
Start-Sleep -Milliseconds 300
Write-Output '{"ok":true}'
