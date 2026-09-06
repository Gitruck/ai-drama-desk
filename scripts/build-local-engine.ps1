param(
  [Parameter(Mandatory = $true)]
  [string]$PortableArchive,
  [Parameter(Mandatory = $true)]
  [string]$OutputDir,
  [string]$Version = '0.32.0-gitruck.1',
  [string]$ComfyVersion = '0.32.0',
  [string]$ArchiveBaseUrl = 'https://github.com/Gitruck/ai-drama-desk/releases/download/local-engine-v0.32.0',
  [string]$SevenZip = 'C:\Program Files\7-Zip\7z.exe'
)

$ErrorActionPreference = 'Stop'
$sourceArchive = [System.IO.Path]::GetFullPath($PortableArchive)
$destination = [System.IO.Path]::GetFullPath($OutputDir)
if (!(Test-Path -LiteralPath $sourceArchive -PathType Leaf)) { throw "找不到 ComfyUI Portable：$sourceArchive" }
if (!(Test-Path -LiteralPath $SevenZip -PathType Leaf)) { throw "找不到 7-Zip：$SevenZip" }
New-Item -ItemType Directory -Force -Path $destination | Out-Null

$stage = Join-Path $destination ('.local-engine-build-' + [Guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $stage | Out-Null
try {
  & $SevenZip x $sourceArchive "-o$stage" -y | Out-Host
  if ($LASTEXITCODE -ne 0) { throw "解压 ComfyUI Portable 失败（7-Zip 退出码 $LASTEXITCODE）。" }

  $payload = Get-ChildItem -LiteralPath $stage -Directory | Where-Object {
    (Test-Path -LiteralPath (Join-Path $_.FullName 'python_embeded\python.exe')) -and
    (Test-Path -LiteralPath (Join-Path $_.FullName 'ComfyUI\main.py'))
  } | Select-Object -First 1
  if (!$payload) {
    if ((Test-Path -LiteralPath (Join-Path $stage 'python_embeded\python.exe')) -and (Test-Path -LiteralPath (Join-Path $stage 'ComfyUI\main.py'))) {
      $payloadPath = $stage
    } else {
      throw '解压结果不是受支持的 ComfyUI Windows Portable 目录结构。'
    }
  } else {
    $payloadPath = $payload.FullName
  }

  $sitePackages = Join-Path $payloadPath 'python_embeded\Lib\site-packages'
  @(
    'comfyui_workflow_templates*',
    'comfyui_embedded_docs*',
    'sageattention*',
    'triton*'
  ) | ForEach-Object {
    Get-ChildItem -LiteralPath $sitePackages -Filter $_ -Force -ErrorAction SilentlyContinue | Remove-Item -Recurse -Force
  }
  @(
    'ComfyUI\tests', 'ComfyUI\tests-unit', 'ComfyUI\script_examples', 'ComfyUI\input\example.png',
    'ComfyUI\README.md', 'ComfyUI\CONTRIBUTING.md', 'ComfyUI\SECURITY.md', 'ComfyUI\QUANTIZATION.md',
    'update', 'update_comfyui.bat', 'run_cpu.bat', 'run_nvidia_gpu.bat'
  ) | ForEach-Object {
    $target = Join-Path $payloadPath $_
    if (Test-Path -LiteralPath $target) { Remove-Item -LiteralPath $target -Recurse -Force }
  }
  Get-ChildItem -LiteralPath $payloadPath -Directory -Recurse -Filter '__pycache__' -Force -ErrorAction SilentlyContinue |
    Sort-Object FullName -Descending | Remove-Item -Recurse -Force

  $archiveName = "local-engine-windows-nvidia-$Version.zip"
  $archivePath = Join-Path $destination $archiveName
  if (Test-Path -LiteralPath $archivePath) { Remove-Item -LiteralPath $archivePath -Force }
  Push-Location $payloadPath
  try {
    & $SevenZip a -tzip $archivePath '.\*' -mx=9 -mmt=on | Out-Host
    if ($LASTEXITCODE -ne 0) { throw "压缩本地引擎失败（7-Zip 退出码 $LASTEXITCODE）。" }
  } finally {
    Pop-Location
  }

  $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  $archiveBytes = (Get-Item -LiteralPath $archivePath).Length
  $installedBytes = (Get-ChildItem -LiteralPath $payloadPath -File -Recurse | Measure-Object -Property Length -Sum).Sum
  $manifest = [ordered]@{
    schemaVersion = 1
    version = $Version
    comfyVersion = $ComfyVersion
    platform = 'windows-x64-nvidia'
    archiveUrl = "$($ArchiveBaseUrl.TrimEnd('/'))/$archiveName"
    archiveSha256 = $hash
    archiveBytes = $archiveBytes
    installedBytes = $installedBytes
    rootDirectory = ''
    excludes = @('comfyui-workflow-templates', 'comfyui-embedded-docs', 'sageattention', 'triton', 'tests', 'script-examples')
  }
  $manifestPath = Join-Path $destination 'local-engine-windows-nvidia.json'
  $manifest | ConvertTo-Json -Depth 5 | Set-Content -LiteralPath $manifestPath -Encoding UTF8
  Write-Host "本地引擎构建完成：$archivePath"
  Write-Host "版本清单：$manifestPath"
  Write-Host ("压缩包：{0:N2} GB；安装后：{1:N2} GB" -f ($archiveBytes / 1GB), ($installedBytes / 1GB))
} finally {
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
}
