param(
  [int]$Port = 7799,
  [switch]$Force
)

$ErrorActionPreference = 'Stop'
$url = "http://127.0.0.1:$Port/api/v1/app/shutdown"

try {
  Invoke-WebRequest -UseBasicParsing -Method Post -Uri $url -Headers @{ 'X-Gitruck-Launcher' = '1' } -TimeoutSec 3 | Out-Null
  $deadline = (Get-Date).AddSeconds(8)
  do {
    Start-Sleep -Milliseconds 200
    $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  } while ($listener -and (Get-Date) -lt $deadline)
  if ($listener) { throw "The desk accepted shutdown, but port $Port is still in use." }
  Write-Host "Gitruck AI Drama Desk stopped safely. Port $Port is free."
  exit 0
} catch {
  $listener = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
  if (!$listener) {
    Write-Host "Port $Port is already free."
    exit 0
  }

  $pids = @($listener | Select-Object -ExpandProperty OwningProcess -Unique)
  if (!$Force) {
    Write-Error "Safe shutdown failed (jobs may be active, or this may be an older build). Port $Port PID(s): $($pids -join ', '). If interruption is acceptable, run: npm run desk:stop:force"
    exit 1
  }

  foreach ($processId in $pids) {
    $process = Get-CimInstance Win32_Process -Filter "ProcessId=$processId"
    $command = [string]$process.CommandLine
    if ($command -notmatch 'gitruck-ai-drama-desk|Gitruck AI Drama Desk|server[\\/]index\.ts') {
      Write-Error "PID $processId does not look like Gitruck AI Drama Desk; refusing to stop it: $command"
      exit 1
    }
  }

  foreach ($processId in $pids) { Stop-Process -Id $processId -Force }
  Write-Host "Gitruck AI Drama Desk was force-stopped (PID: $($pids -join ', ')). Port $Port is free."
}
