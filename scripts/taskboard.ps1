[CmdletBinding()]
param(
  [ValidateSet('start', 'stop', 'restart', 'status', 'logs')]
  [string]$Action = 'start',
  [switch]$NoBrowser,
  [ValidateRange(1, 300)]
  [int]$StartupTimeoutSeconds = 30
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
$Root = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$RuntimeDir = Join-Path $Root '.taskboard-runtime'
$PidFile = Join-Path $RuntimeDir 'server.json'
$StdOutLog = Join-Path $RuntimeDir 'server.out.log'
$StdErrLog = Join-Path $RuntimeDir 'server.err.log'
$ServerEntry = Join-Path $Root 'apps\server\dist\server.js'
$Port = 47824
if ($env:TASKBOARD_PORT -and $env:TASKBOARD_PORT -match '^\d+$') { $Port = [int]$env:TASKBOARD_PORT }
if ($Port -lt 1 -or $Port -gt 65535) { throw "Invalid TASKBOARD_PORT: $Port (expected 1-65535)." }
$HostName = if ($env:TASKBOARD_HOST) { $env:TASKBOARD_HOST.Trim() } else { '127.0.0.1' }
$BaseUrl = "http://$($HostName):$Port"
$HealthUrl = "$BaseUrl/api/openapi.json"

function Write-Info([string]$Message) { Write-Host "[Taskboard] $Message" -ForegroundColor Cyan }
function Write-Warn([string]$Message) { Write-Host "[Taskboard] $Message" -ForegroundColor Yellow }
function Ensure-RuntimeDir {
  if (-not (Test-Path -LiteralPath $RuntimeDir)) { New-Item -ItemType Directory -Path $RuntimeDir -Force | Out-Null }
}
function Get-PortListeners {
  try {
    return @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
  } catch {
    try {
      $lines = & netstat.exe -ano -p tcp 2>$null
      $ids = @()
      foreach ($line in $lines) {
        if ($line -match '^\s*TCP\s+\S+:' + $Port + '\s+\S+\s+LISTENING\s+(\d+)\s*$') { $ids += [int]$Matches[1] }
      }
      return @($ids | Select-Object -Unique)
    } catch { return @() }
  }
}
function Test-TaskboardHealth {
  try {
    $response = Invoke-WebRequest -Uri $HealthUrl -Method Get -TimeoutSec 3 -UseBasicParsing
    if ([int]$response.StatusCode -lt 200 -or [int]$response.StatusCode -ge 300) { return $false }
    $document = $response.Content | ConvertFrom-Json -ErrorAction Stop
    return [bool]($document.openapi -and $document.paths)
  } catch { return $false }
}
function Get-ManagedProcess {
  if (-not (Test-Path -LiteralPath $PidFile)) { return $null }
  try {
    $record = Get-Content -LiteralPath $PidFile -Raw | ConvertFrom-Json -ErrorAction Stop
    $processId = [int]$record.pid
    $proc = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction Stop
    if (-not $proc) { return $null }
    if (-not $proc.CommandLine -or $proc.CommandLine.IndexOf($ServerEntry, [StringComparison]::OrdinalIgnoreCase) -lt 0) { return $null }
    if ($record.creationDate -and [string]$proc.CreationDate -ne [string]$record.creationDate) { return $null }
    return [pscustomobject]@{ Process = $proc; Record = $record }
  } catch { return $null }
}
function Show-Status {
  $managed = Get-ManagedProcess
  $healthy = Test-TaskboardHealth
  if ($healthy) { Write-Info "HTTP health check passed: $HealthUrl" } else { Write-Warn "No healthy Taskboard API responded at $HealthUrl" }
  if ($managed) {
    Write-Info "Managed server PID: $($managed.Process.ProcessId)"
    Write-Info "Started at: $($managed.Record.startedAt)"
  } elseif (Test-Path -LiteralPath $PidFile) {
    Write-Warn 'PID record is stale or mismatched; it will not be used to kill any process.'
  } else { Write-Info 'No verified Taskboard process is recorded by this launcher.' }
  $listeners = @(Get-PortListeners)
  if ($listeners.Count -gt 0) { Write-Info "Listener PID(s) on port $($Port): $($listeners -join ', ')" }
  else { Write-Info "No listener found on port $Port (or listener inspection is unavailable)." }
  if ($healthy) { return 0 }
  return 1
}
function Show-Logs {
  foreach ($file in @($StdOutLog, $StdErrLog)) {
    if (Test-Path -LiteralPath $file) {
      Write-Host ''
      Write-Host "===== $file =====" -ForegroundColor DarkCyan
      Get-Content -LiteralPath $file -Tail 100
    } else { Write-Warn "Log not found: $file" }
  }
}
function Stop-ManagedServer {
  $managed = Get-ManagedProcess
  if (-not $managed) {
    if (Test-Path -LiteralPath $PidFile) { Write-Warn 'No verified process matches the saved PID record. Nothing was killed.' }
    else { Write-Info 'No server started by this launcher was found.' }
    return
  }
  $processId = [int]$managed.Process.ProcessId
  Write-Info "Stopping managed Taskboard process PID $processId ..."
  Stop-Process -Id $processId -Force -ErrorAction Stop
  $deadline = (Get-Date).AddSeconds(10)
  do {
    Start-Sleep -Milliseconds 250
    $stillThere = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
  } while ($stillThere -and (Get-Date) -lt $deadline)
  if ($stillThere) { throw "Process $processId did not exit within 10 seconds. No other process was killed." }
  Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
  Write-Info 'Taskboard process stopped.'
}
function Get-CommandPath([string]$Name) {
  $command = Get-Command $Name -ErrorAction SilentlyContinue | Where-Object { $_.CommandType -eq 'Application' } | Select-Object -First 1
  if (-not $command) { return $null }
  return $command.Source
}
function Get-NodeInfo {
  $nodePath = Get-CommandPath 'node'
  if (-not $nodePath) { throw 'Node.js was not found in PATH. Install Node.js >=22.5.0, reopen the terminal, and run start.bat again.' }
  $versionText = (& $nodePath --version 2>$null | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^v?(\d+)\.(\d+)\.(\d+)') { throw "Could not read Node.js version from '$nodePath'." }
  $major = [int]$Matches[1]
  $minor = [int]$Matches[2]
  if (($major -lt 22) -or ($major -eq 22 -and $minor -lt 5)) { throw "Node.js >=22.5.0 is required; found $versionText." }
  return [pscustomobject]@{ Path = $nodePath; Version = $versionText }
}
function Get-PnpmPath {
  $pnpm = Get-CommandPath 'pnpm'
  if (-not $pnpm) { throw 'pnpm was not found in PATH. Install pnpm 9+ (for example: corepack enable), reopen the terminal, and try again.' }
  $versionText = (& $pnpm --version 2>$null | Select-Object -First 1)
  if ($LASTEXITCODE -ne 0 -or $versionText -notmatch '^(\d+)\.') { throw "Could not read pnpm version from '$pnpm'." }
  if ([int]$Matches[1] -lt 9) { throw "pnpm 9+ is required; found $versionText." }
  return $pnpm
}
function Invoke-Pnpm([string]$PnpmPath, [string[]]$Arguments, [string]$Purpose) {
  Write-Info "$Purpose ..."
  Push-Location $Root
  try {
    & $PnpmPath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "Command failed (exit $LASTEXITCODE): pnpm $($Arguments -join ' ')" }
  } finally { Pop-Location }
}
function Ensure-Build([string]$PnpmPath) {
  $needsBuild = -not (Test-Path -LiteralPath $ServerEntry)
  if (-not $needsBuild -and -not (Test-Path -LiteralPath (Join-Path $Root 'apps\web\dist\index.html'))) { $needsBuild = $true }
  if ($needsBuild) { Invoke-Pnpm $PnpmPath @('build') 'Build output is missing; building all packages' }
  if (-not (Test-Path -LiteralPath $ServerEntry)) { throw "Build completed but server entry was not created: $ServerEntry" }
}
function Start-Taskboard {
  Ensure-RuntimeDir
  if (Test-TaskboardHealth) {
    Write-Info "Taskboard is already healthy at $BaseUrl"
    if (-not $NoBrowser) { Start-Process $BaseUrl }
    return 0
  }
  $listeners = @(Get-PortListeners)
  if ($listeners.Count -gt 0) {
    $details = foreach ($listenerId in $listeners) {
      $p = Get-CimInstance Win32_Process -Filter "ProcessId = $listenerId" -ErrorAction SilentlyContinue
      if ($p) { "PID $listenerId ($($p.Name): $($p.CommandLine))" }
      else { "PID $listenerId (details unavailable)" }
    }
    throw "Port $Port is already occupied, but it did not answer the Taskboard health check. Nothing was killed. $($details -join '; '). Set TASKBOARD_PORT to a free port or stop the conflicting process yourself."
  }
  $node = Get-NodeInfo
  $pnpm = Get-PnpmPath
  Write-Info "Node.js $($node.Version)"
  Write-Info "Root: $Root"
  if (-not (Test-Path -LiteralPath (Join-Path $Root 'node_modules'))) {
    Write-Warn 'Dependencies are not installed.'
    $answer = Read-Host 'Run pnpm install now? This requires network access (Y/N)'
    if ($answer -notmatch '^(y|yes)$') { throw 'Startup cancelled. Run pnpm install in the project directory, then retry.' }
    Invoke-Pnpm $pnpm @('install') 'Installing dependencies'
  }
  Ensure-Build $pnpm
  Remove-Item -LiteralPath $StdOutLog, $StdErrLog -Force -ErrorAction SilentlyContinue
  # Launch Node directly so the saved PID is the server process, not a cmd/pnpm wrapper.
  $process = Start-Process -FilePath $node.Path -ArgumentList @('"' + $ServerEntry + '"') -WorkingDirectory $Root -RedirectStandardOutput $StdOutLog -RedirectStandardError $StdErrLog -PassThru -WindowStyle Hidden
  Start-Sleep -Milliseconds 300
  $cimProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction SilentlyContinue
  if (-not $cimProcess) { Show-Logs; throw 'Taskboard exited immediately after launch. See logs above.' }
  $record = [ordered]@{
    pid = $process.Id
    creationDate = [string]$cimProcess.CreationDate
    startedAt = (Get-Date).ToString('o')
    root = $Root
    entry = $ServerEntry
    url = $BaseUrl
  }
  $record | ConvertTo-Json | Set-Content -LiteralPath $PidFile -Encoding UTF8
  Write-Info "Waiting up to $StartupTimeoutSeconds seconds for $HealthUrl ..."
  $deadline = (Get-Date).AddSeconds($StartupTimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    $stillRunning = Get-CimInstance Win32_Process -Filter "ProcessId = $($process.Id)" -ErrorAction SilentlyContinue
    if (-not $stillRunning) {
      Show-Logs
      Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
      throw 'Taskboard process exited before becoming healthy. See logs above.'
    }
    if (Test-TaskboardHealth) {
      Write-Info "Taskboard is ready: $BaseUrl"
      Write-Info "Logs: $StdOutLog and $StdErrLog"
      if (-not $NoBrowser) { Start-Process $BaseUrl }
      return 0
    }
    Start-Sleep -Milliseconds 500
  }
  Write-Warn "Taskboard did not become healthy within $StartupTimeoutSeconds seconds."
  Show-Logs
  throw 'Startup timed out. The process was not killed automatically; inspect logs and verify the saved PID before running -Action stop.'
}
try {
  switch ($Action) {
    'start'   { exit (Start-Taskboard) }
    'stop'    { Stop-ManagedServer; exit 0 }
    'restart' { Stop-ManagedServer; exit (Start-Taskboard) }
    'status'  { exit (Show-Status) }
    'logs'    { Show-Logs; exit 0 }
  }
} catch {
  Write-Host ''
  Write-Host "[Taskboard] ERROR: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
