param(
  [Parameter(Mandatory = $true)]
  [ValidateSet('install', 'start', 'stop')]
  [string]$Action,
  [Parameter(Mandatory = $true)]
  [string]$EngineHome,
  [Parameter(Mandatory = $true)]
  [string]$ModelsDir,
  [Parameter(Mandatory = $true)]
  [string]$ManifestUrl
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$engineRoot = [System.IO.Path]::GetFullPath($EngineHome)
$stateFile = Join-Path $engineRoot 'state.json'
$currentDir = Join-Path $engineRoot 'current'
$modelsDir = [System.IO.Path]::GetFullPath($ModelsDir)
$downloadsDir = Join-Path $engineRoot 'downloads'
$stagingDir = Join-Path $engineRoot 'staging'
$logDir = Join-Path $engineRoot 'logs'

function Write-State {
  param(
    [string]$Phase,
    [string]$Message,
    [Nullable[int]]$Progress,
    [Nullable[int]]$Pid,
    [string]$Version,
    [string]$ComfyVersion
  )
  New-Item -ItemType Directory -Force -Path $engineRoot | Out-Null
  $payload = [ordered]@{
    phase = $Phase
    message = $Message
    updatedAt = [DateTime]::UtcNow.ToString('o')
  }
  if ($null -ne $Progress) { $payload.progress = $Progress.Value }
  if ($null -ne $Pid) { $payload.pid = $Pid.Value }
  if ($Version) { $payload.version = $Version }
  if ($ComfyVersion) { $payload.comfyVersion = $ComfyVersion }
  $temporary = "$stateFile.tmp"
  $payload | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $temporary -Encoding UTF8
  Move-Item -LiteralPath $temporary -Destination $stateFile -Force
}

function Read-State {
  if (!(Test-Path -LiteralPath $stateFile)) { return $null }
  return Get-Content -Raw -LiteralPath $stateFile | ConvertFrom-Json
}

function Test-ProcessAlive {
  param([Nullable[int]]$Pid)
  if ($null -eq $Pid -or $Pid.Value -lt 1) { return $false }
  return $null -ne (Get-Process -Id $Pid.Value -ErrorAction SilentlyContinue)
}

function Quote-ProcessArgument {
  param([string]$Value)
  if ($Value -notmatch '[\s"]') { return $Value }
  return '"' + $Value.Replace('"', '\"') + '"'
}

function Remove-PrunablePackages {
  param([string]$Root)
  $sitePackages = Join-Path $Root 'python_embeded\Lib\site-packages'
  if (!(Test-Path -LiteralPath $sitePackages)) { throw '本地引擎包缺少 python_embeded\Lib\site-packages。' }
  $patterns = @(
    'comfyui_workflow_templates*',
    'comfyui_embedded_docs*',
    'comfyui_embedded_docs*.dist-info',
    'sageattention*',
    'sageattention*.dist-info',
    'triton*',
    'triton*.dist-info'
  )
  foreach ($pattern in $patterns) {
    Get-ChildItem -LiteralPath $sitePackages -Filter $pattern -Force -ErrorAction SilentlyContinue | ForEach-Object {
      Remove-Item -LiteralPath $_.FullName -Recurse -Force
    }
  }

  $sourcePrune = @(
    'ComfyUI\tests',
    'ComfyUI\tests-unit',
    'ComfyUI\script_examples',
    'ComfyUI\input\example.png',
    'ComfyUI\README.md',
    'ComfyUI\CONTRIBUTING.md',
    'ComfyUI\SECURITY.md',
    'ComfyUI\QUANTIZATION.md'
  )
  foreach ($relativePath in $sourcePrune) {
    $target = Join-Path $Root $relativePath
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  }
}

function Get-BuiltInManifest {
  return [pscustomobject]@{
    schemaVersion = 1
    version = '0.32.0-official-cu130'
    comfyVersion = '0.32.0'
    platform = 'windows-x64-nvidia'
    archiveUrl = 'https://github.com/Comfy-Org/ComfyUI/releases/download/v0.32.0/ComfyUI_windows_portable_nvidia.7z'
    archiveSha256 = '642ba5e91c5f6310b11797acf79484d2248df5e09c6bb27696a25c99e68bdb72'
    archiveBytes = 2132254184
    installedBytes = 6500000000
    rootDirectory = 'ComfyUI_windows_portable'
    archiveFormat = '7z'
  }
}

function Install-Engine {
  New-Item -ItemType Directory -Force -Path $engineRoot, $modelsDir, $downloadsDir, $logDir | Out-Null
  $nvidiaSmi = Get-Command nvidia-smi.exe -ErrorAction SilentlyContinue
  if (!$nvidiaSmi -and !(Test-Path -LiteralPath "$env:WINDIR\System32\nvidia-smi.exe")) {
    throw '未检测到 NVIDIA 驱动。本地组件当前只提供 NVIDIA 版；请继续使用云端模型。'
  }
  Write-State -Phase 'downloading' -Message '正在读取本地引擎版本清单…' -Progress 1
  try {
    $manifest = Invoke-RestMethod -Uri $ManifestUrl -Method Get
  } catch {
    # 首个版本尚未发布自建精简组件时，仍可直接取 ComfyUI 官方包并在本机精简。
    # 官方 URL、大小与 SHA-256 固定在代码里，不信任下载响应提供的校验值。
    $manifest = Get-BuiltInManifest
  }
  if ($manifest.schemaVersion -ne 1 -or !$manifest.archiveUrl -or !$manifest.archiveSha256 -or !$manifest.version) {
    throw '本地引擎版本清单不完整或版本不受支持。'
  }
  $archiveUri = [Uri]$manifest.archiveUrl
  if ($archiveUri.Scheme -ne 'https') { throw '本地引擎下载地址必须使用 HTTPS。' }
  $requiredBytes = [int64]$manifest.archiveBytes + [int64]$manifest.installedBytes + 2GB
  $driveRoot = [System.IO.Path]::GetPathRoot($engineRoot)
  $freeBytes = ([System.IO.DriveInfo]::new($driveRoot)).AvailableFreeSpace
  if ($freeBytes -lt $requiredBytes) {
    throw ("磁盘空间不足：至少需要 {0:N1} GB 可用空间。" -f ($requiredBytes / 1GB))
  }
  $archiveFormat = if ($manifest.archiveFormat) { [string]$manifest.archiveFormat } elseif ([string]$manifest.archiveUrl -match '\.7z$') { '7z' } else { 'zip' }
  $archiveFile = Join-Path $downloadsDir "local-engine-$($manifest.version).$archiveFormat"
  Write-State -Phase 'downloading' -Message '正在下载 Python、PyTorch、CUDA 与 ComfyUI 本地引擎；可以继续使用云端功能。' -Progress 5 -Version $manifest.version -ComfyVersion $manifest.comfyVersion

  $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
  if ($curl) {
    & $curl.Source '--fail' '--location' '--retry' '3' '--continue-at' '-' '--output' $archiveFile $manifest.archiveUrl
    if ($LASTEXITCODE -ne 0) { throw "本地引擎下载失败（curl 退出码 $LASTEXITCODE）。" }
  } else {
    Invoke-WebRequest -Uri $manifest.archiveUrl -OutFile $archiveFile
  }

  Write-State -Phase 'verifying' -Message '正在校验下载文件…' -Progress 72 -Version $manifest.version -ComfyVersion $manifest.comfyVersion
  $actualHash = (Get-FileHash -LiteralPath $archiveFile -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne ([string]$manifest.archiveSha256).ToLowerInvariant()) {
    throw "本地引擎校验失败；下载文件已保留，可重试续传。"
  }

  if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $stagingDir | Out-Null
  Write-State -Phase 'extracting' -Message '正在解压本地引擎…' -Progress 78 -Version $manifest.version -ComfyVersion $manifest.comfyVersion
  if ($archiveFormat -eq 'zip') {
    Expand-Archive -LiteralPath $archiveFile -DestinationPath $stagingDir -Force
  } elseif ($archiveFormat -eq '7z') {
    $bundledSevenZip = Join-Path $PSScriptRoot '..\..\tools\7z.exe'
    $sevenZip = if (Test-Path -LiteralPath $bundledSevenZip) { $bundledSevenZip } else { (Get-Command 7z.exe -ErrorAction SilentlyContinue).Source }
    if (!$sevenZip) { throw '缺少 7-Zip 解压器；请重新安装工作台主程序。' }
    & $sevenZip x $archiveFile "-o$stagingDir" -y | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "本地引擎解压失败（7-Zip 退出码 $LASTEXITCODE）。" }
  } else {
    throw "不支持的本地引擎压缩格式：$archiveFormat"
  }

  $payloadRoot = $stagingDir
  if ($manifest.rootDirectory) { $payloadRoot = Join-Path $stagingDir ([string]$manifest.rootDirectory) }
  if (!(Test-Path -LiteralPath (Join-Path $payloadRoot 'python_embeded\python.exe'))) { throw '本地引擎包缺少 python_embeded\python.exe。' }
  if (!(Test-Path -LiteralPath (Join-Path $payloadRoot 'ComfyUI\main.py'))) { throw '本地引擎包缺少 ComfyUI\main.py。' }

  Write-State -Phase 'pruning' -Message '正在移除示例媒体、嵌入文档、SageAttention 与 Triton…' -Progress 91 -Version $manifest.version -ComfyVersion $manifest.comfyVersion
  Remove-PrunablePackages -Root $payloadRoot
  $marker = [ordered]@{
    schemaVersion = 1
    version = $manifest.version
    comfyVersion = $manifest.comfyVersion
    installedAt = [DateTime]::UtcNow.ToString('o')
    archiveSha256 = $actualHash
    excluded = @('official-example-media', 'embedded-docs', 'sageattention', 'triton')
  }
  $marker | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath (Join-Path $payloadRoot 'installed.json') -Encoding UTF8

  $oldDir = Join-Path $engineRoot 'previous'
  if (Test-Path -LiteralPath $oldDir) { Remove-Item -LiteralPath $oldDir -Recurse -Force }
  if (Test-Path -LiteralPath $currentDir) { Move-Item -LiteralPath $currentDir -Destination $oldDir }
  Move-Item -LiteralPath $payloadRoot -Destination $currentDir
  if (Test-Path -LiteralPath $stagingDir) { Remove-Item -LiteralPath $stagingDir -Recurse -Force }
  if (Test-Path -LiteralPath $oldDir) { Remove-Item -LiteralPath $oldDir -Recurse -Force }
  Write-State -Phase 'installed' -Message '本地引擎已安装；模型目录仍为空，请按需添加开源模型。' -Progress 100 -Version $manifest.version -ComfyVersion $manifest.comfyVersion
}

function Start-Engine {
  $python = Join-Path $currentDir 'python_embeded\python.exe'
  $main = Join-Path $currentDir 'ComfyUI\main.py'
  if (!(Test-Path -LiteralPath $python) -or !(Test-Path -LiteralPath $main)) { throw '本地引擎未完整安装，请重新安装。' }
  $existing = Read-State
  if ($existing -and (Test-ProcessAlive -Pid $existing.pid)) {
    Write-State -Phase 'running' -Message '本地引擎正在运行。' -Pid $existing.pid -Version $existing.version -ComfyVersion $existing.comfyVersion
    return
  }
  New-Item -ItemType Directory -Force -Path $modelsDir, $logDir | Out-Null
  Write-State -Phase 'starting' -Message '正在启动 ComfyUI 本地引擎…' -Progress 10
  $stdout = Join-Path $logDir 'comfyui.stdout.log'
  $stderr = Join-Path $logDir 'comfyui.stderr.log'
  $arguments = @(
    $main,
    '--listen', '127.0.0.1',
    '--port', '8188',
    '--disable-auto-launch',
    '--models-directory', $modelsDir,
    '--output-directory', (Join-Path $engineRoot 'output'),
    '--input-directory', (Join-Path $engineRoot 'input'),
    '--temp-directory', (Join-Path $engineRoot 'temp'),
    '--user-directory', (Join-Path $engineRoot 'user'),
    '--use-ck-attention',
    '--fast', 'fp16_accumulation',
    '--reserve-vram', '2.0'
  )
  $argumentLine = ($arguments | ForEach-Object { Quote-ProcessArgument -Value ([string]$_) }) -join ' '
  $process = Start-Process -FilePath $python -ArgumentList $argumentLine -WorkingDirectory (Join-Path $currentDir 'ComfyUI') -WindowStyle Hidden -RedirectStandardOutput $stdout -RedirectStandardError $stderr -PassThru
  Write-State -Phase 'running' -Message '本地引擎正在运行；模型按需放入独立模型目录。' -Pid $process.Id
}

function Stop-Engine {
  $state = Read-State
  if (!$state -or !(Test-ProcessAlive -Pid $state.pid)) {
    Write-State -Phase 'installed' -Message '本地引擎已停止。'
    return
  }
  $process = Get-Process -Id $state.pid -ErrorAction Stop
  $expectedPython = [System.IO.Path]::GetFullPath((Join-Path $currentDir 'python_embeded\python.exe'))
  $actualProcess = [System.IO.Path]::GetFullPath($process.Path)
  if ($actualProcess -ne $expectedPython) { throw '记录的进程不是本地引擎进程，已拒绝停止。' }
  Write-State -Phase 'stopping' -Message '正在停止本地引擎…' -Pid $process.Id
  Stop-Process -Id $process.Id
  $process.WaitForExit(10000)
  if (!$process.HasExited) { Stop-Process -Id $process.Id -Force }
  Write-State -Phase 'installed' -Message '本地引擎已停止。'
}

try {
  switch ($Action) {
    'install' { Install-Engine }
    'start' { Start-Engine }
    'stop' { Stop-Engine }
  }
} catch {
  Write-State -Phase 'failed' -Message $_.Exception.Message
  exit 1
}
