param(
  [string]$OutputDir = '.\dist\windows',
  [string]$Version = '0.2.0-beta.1',
  [string]$BunPath = "$env:USERPROFILE\.bun\bin\bun.exe",
  [string]$FfmpegBin = 'C:\file\ffmpeg\bin',
  [string]$SevenZipDir = 'C:\Program Files\7-Zip'
)

$ErrorActionPreference = 'Stop'
$repo = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$destination = [System.IO.Path]::GetFullPath((Join-Path $repo $OutputDir))
$stage = Join-Path $destination 'Gitruck AI Drama Desk'
  if (!(Test-Path -LiteralPath $BunPath -PathType Leaf)) { throw "找不到 Bun：$BunPath" }
  if (!(Test-Path -LiteralPath (Join-Path $FfmpegBin 'ffmpeg.exe'))) { throw "找不到 FFmpeg：$FfmpegBin" }
  if (!(Test-Path -LiteralPath (Join-Path $SevenZipDir '7z.exe'))) { throw "找不到 7-Zip：$SevenZipDir" }

Push-Location $repo
try {
  & $BunPath run build
  if ($LASTEXITCODE -ne 0) { throw '前端构建失败。' }
  New-Item -ItemType Directory -Force -Path $destination | Out-Null
  if (Test-Path -LiteralPath $stage) { Remove-Item -LiteralPath $stage -Recurse -Force }
  New-Item -ItemType Directory -Force -Path (Join-Path $stage 'app'), (Join-Path $stage 'app\scripts'), (Join-Path $stage 'runtime'), (Join-Path $stage 'tools') | Out-Null

  $serverOut = Join-Path $stage 'app\server.js'
  & $BunPath build '.\server\index.ts' --target=bun --external=sharp --outfile $serverOut
  if ($LASTEXITCODE -ne 0) { throw '服务端构建失败。' }
  Copy-Item -LiteralPath $BunPath -Destination (Join-Path $stage 'runtime\bun.exe')
  Copy-Item -LiteralPath '.\web\dist' -Destination (Join-Path $stage 'app\web\dist') -Recurse
  Copy-Item -LiteralPath '.\templates' -Destination (Join-Path $stage 'app\templates') -Recurse
  Copy-Item -LiteralPath '.\scripts\local-engine.ps1' -Destination (Join-Path $stage 'app\scripts\local-engine.ps1')

  $productionModules = @('sharp', 'detect-libc', 'semver', '@img\colour', '@img\sharp-win32-x64')
  foreach ($module in $productionModules) {
    $source = Join-Path $repo "node_modules\$module"
    $target = Join-Path $stage "app\node_modules\$module"
    New-Item -ItemType Directory -Force -Path (Split-Path $target -Parent) | Out-Null
    Copy-Item -LiteralPath $source -Destination $target -Recurse
  }

  Copy-Item -LiteralPath (Join-Path $FfmpegBin 'ffmpeg.exe'), (Join-Path $FfmpegBin 'ffprobe.exe') -Destination (Join-Path $stage 'tools')
  Get-ChildItem -LiteralPath $FfmpegBin -Filter '*.dll' | Copy-Item -Destination (Join-Path $stage 'tools')
  Copy-Item -LiteralPath (Join-Path $SevenZipDir '7z.exe'), (Join-Path $SevenZipDir '7z.dll'), (Join-Path $SevenZipDir 'License.txt') -Destination (Join-Path $stage 'tools')

  $csc = 'C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe'
  if (!(Test-Path -LiteralPath $csc)) { throw '找不到 Windows .NET Framework C# 编译器。' }
  & $csc /nologo /target:winexe /optimize+ /reference:System.Windows.Forms.dll "/out:$stage\Gitruck AI Drama Desk.exe" '.\packaging\Launcher.cs'
  if ($LASTEXITCODE -ne 0) { throw '启动器构建失败。' }

  $buildId = "$Version-$((Get-Date).ToUniversalTime().ToString('yyyyMMddHHmmss'))-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
  $release = [ordered]@{
    name = 'Gitruck AI Drama Desk'
    version = $Version
    buildId = $buildId
    mode = 'cloud-first'
    includesLocalInferenceRuntime = $false
    localInference = 'installed-on-first-enable'
  }
  $release | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $stage 'release.json') -Encoding UTF8

  $zip = Join-Path $destination "gitruck-ai-drama-desk-$Version-windows-x64-cloud.zip"
  if (Test-Path -LiteralPath $zip) { Remove-Item -LiteralPath $zip -Force }
  Compress-Archive -LiteralPath $stage -DestinationPath $zip -CompressionLevel Optimal
  $size = (Get-Item -LiteralPath $zip).Length
  $hash = (Get-FileHash -LiteralPath $zip -Algorithm SHA256).Hash.ToLowerInvariant()
  Write-Host "云端主包：$zip"
  Write-Host ("压缩体积：{0:N1} MB" -f ($size / 1MB))
  Write-Host "SHA-256：$hash"
} finally {
  Pop-Location
}
