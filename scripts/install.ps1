# Zhiro · 职路 — install without Node (Windows, PowerShell 5.1+).
#   irm https://github.com/mazjq/zhiro/releases/latest/download/install.ps1 | iex
# Puts the official Node 22 (checked against nodejs.org's SHA-256 list) and Zhiro into %LOCALAPPDATA%\Zhiro\versions\<time>\,
# switches %LOCALAPPDATA%\Zhiro\current to it only when everything is in place, and adds %LOCALAPPDATA%\Zhiro\bin to
# your PATH. Running it again upgrades; the previous version stays. Your data is elsewhere and untouched.
# Options (environment): ZHIRO_HOME, ZHIRO_PACKAGE (a .tgz path or URL), ZHIRO_NODE_DIST, ZHIRO_NO_PATH=1 (leave PATH alone).
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"   # Invoke-WebRequest is many times slower with the progress bar
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Root = if ($env:ZHIRO_HOME) { $env:ZHIRO_HOME } else { Join-Path $env:LOCALAPPDATA "Zhiro" }
$Pkg = if ($env:ZHIRO_PACKAGE) { $env:ZHIRO_PACKAGE } else { "https://github.com/mazjq/zhiro/releases/latest/download/zhiro.tgz" }
$Dist = if ($env:ZHIRO_NODE_DIST) { $env:ZHIRO_NODE_DIST } else { "https://nodejs.org/dist/latest-v22.x" }
$Arch = switch ($env:PROCESSOR_ARCHITECTURE) { "AMD64" { "x64" } "ARM64" { "arm64" } default { throw "unsupported CPU: $env:PROCESSOR_ARCHITECTURE" } }

$Tmp = Join-Path ([IO.Path]::GetTempPath()) ("zhiro-install-" + [Guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force $Tmp | Out-Null
try {
  Write-Host "-> Node 22 for win-$Arch"
  $Sums = (Invoke-WebRequest -UseBasicParsing "$Dist/SHASUMS256.txt").Content
  $Line = ($Sums -split "`n") | Where-Object { $_ -match "node-v[0-9.]+-win-$Arch\.zip$" } | Select-Object -First 1
  if (-not $Line) { throw "no Node build for win-$Arch at $Dist" }
  $Want, $File = ($Line.Trim() -split "\s+")
  Invoke-WebRequest -UseBasicParsing "$Dist/$File" -OutFile (Join-Path $Tmp $File)
  if ((Get-FileHash (Join-Path $Tmp $File) -Algorithm SHA256).Hash.ToLower() -ne $Want.ToLower()) { throw "Node download does not match its SHA-256; nothing was changed" }

  $Target = Join-Path $Root ("versions\" + (Get-Date -Format "yyyyMMddHHmmss"))
  New-Item -ItemType Directory -Force (Join-Path $Target "app") | Out-Null
  Expand-Archive (Join-Path $Tmp $File) -DestinationPath $Tmp -Force
  Move-Item (Join-Path $Tmp ($File -replace "\.zip$", "")) (Join-Path $Target "node")
  $Node = Join-Path $Target "node\node.exe"

  Write-Host "-> Zhiro from $Pkg"
  if ($Pkg -match "^https?://") { Invoke-WebRequest -UseBasicParsing $Pkg -OutFile (Join-Path $Tmp "zhiro.tgz"); $Pkg = Join-Path $Tmp "zhiro.tgz" }
  Set-Content -Path (Join-Path $Target "app\package.json") -Value "{}" -Encoding ascii
  $env:PATH = (Join-Path $Target "node") + ";" + $env:PATH
  Push-Location (Join-Path $Target "app")
  try { & $Node (Join-Path $Target "node\node_modules\npm\bin\npm-cli.js") install --no-audit --no-fund --loglevel=error $Pkg; $ok = $LASTEXITCODE -eq 0 } finally { Pop-Location }
  if (-not $ok) { Remove-Item -Recurse -Force $Target; throw "npm install failed; nothing was changed" }
  $Cli = Join-Path $Target "app\node_modules\zhiro\bin\zhiro.cjs"
  & $Node $Cli --version | Out-Null
  if ($LASTEXITCODE -ne 0) { Remove-Item -Recurse -Force $Target; throw "the new version does not start; nothing was changed" }

  # switch only now: everything above is in place and starts. `current` is a directory junction; removing it never
  # touches what it points to.
  $Current = Join-Path $Root "current"
  if (Test-Path $Current) { cmd /c rmdir "$Current" | Out-Null }
  New-Item -ItemType Junction -Path $Current -Target $Target | Out-Null
  $Bin = Join-Path $Root "bin"
  New-Item -ItemType Directory -Force $Bin | Out-Null
  Set-Content -Path (Join-Path $Bin "zhiro.cmd") -Encoding ascii -Value "@`"%~dp0..\current\node\node.exe`" `"%~dp0..\current\app\node_modules\zhiro\bin\zhiro.cjs`" %*"
  # keep the new version and the one before it (one still running keeps its files; try again next time)
  Get-ChildItem (Join-Path $Root "versions") -Directory | Sort-Object Name | Select-Object -SkipLast 2 | ForEach-Object { try { Remove-Item -Recurse -Force $_.FullName } catch { } }

  $UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
  if (-not $env:ZHIRO_NO_PATH -and -not (($UserPath -split ";") -contains $Bin)) { [Environment]::SetEnvironmentVariable("Path", ($Bin + ";" + $UserPath).TrimEnd(";"), "User") }
  $env:PATH = $Bin + ";" + $env:PATH

  $Version = & (Join-Path $Bin "zhiro.cmd") --version
  Write-Host ""
  Write-Host "OK Zhiro $Version installed in $Root"
  Write-Host "  Start it:  zhiro      (open a new terminal first if 'zhiro' is not found)"
  Write-Host "  Already running? Restart it to use the new version."
} finally {
  Remove-Item -Recurse -Force $Tmp -ErrorAction SilentlyContinue
}
