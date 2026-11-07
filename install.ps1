param(
    [string]$CustomTargetDir = $env:AGY_TEST_TARGET_DIR,
    [string]$CustomConfigFile = $env:AGY_TEST_CONFIG_FILE
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$scriptDir = $PSScriptRoot
$homeDir = [System.Environment]::GetFolderPath('UserProfile')
$pluginsDir = Join-Path $homeDir ".gemini\config\plugins"
$targetDir = if ($CustomTargetDir) { $CustomTargetDir } else { Join-Path $pluginsDir "antigravity-context-ring" }
$configFile = if ($CustomConfigFile) { $CustomConfigFile } else { Join-Path $homeDir ".gemini\config\config.json" }

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   Antigravity Context Ring Installer     " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 0. 精准终止历史残留 Sidecar 孤儿进程（严格白名单）
Write-Host "[0/3] Terminating orphan Sidecar processes..." -ForegroundColor Yellow
try {
    Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object { 
        $cmd = $_.CommandLine
        if ([string]::IsNullOrWhiteSpace($cmd)) { return $false }
        if (-not [string]::IsNullOrWhiteSpace($CustomTargetDir)) {
            $normCmd = $cmd.Replace('\', '/').ToLower()
            $normTarget = $CustomTargetDir.Trim().Replace('\', '/').ToLower()
            if ($normCmd.IndexOf($normTarget) -lt 0) { return $false }
        } elseif ($cmd.Replace('\', '/').ToLower().IndexOf('clean_test_sandbox') -ge 0) {
            return $false
        }
        $hasFlag = ($cmd -match '(?:^|\s)--sidecar=antigravity-context-ring(?:\s|$)')
        $hasPath = ($cmd -match 'antigravity-context-ring' -and $cmd -match 'main\.mjs')
        $hasRingMain = ($cmd -match 'sidecars[\\/]ring[\\/]main\.mjs' -or $cmd -match 'main\.mjs')
        (($hasFlag -and $hasRingMain) -or $hasPath) -and ($_.ProcessId -ne $PID)
    } | ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
    }
} catch {
    # 受限或沙箱策略下可能无法访问 CIM，忽略并继续
}

# 1. 确保插件目录存在
Write-Host "[1/3] Preparing plugin directories..." -ForegroundColor Yellow
$targetParent = Split-Path -Parent $targetDir
if ($targetParent -and -not (Test-Path $targetParent -ErrorAction SilentlyContinue)) {
    try { New-Item -ItemType Directory -Force -Path $targetParent | Out-Null } catch {}
}
if (-not (Test-Path $targetDir -ErrorAction SilentlyContinue)) {
    New-Item -ItemType Directory -Force -Path $targetDir | Out-Null
}

# 2. 拷贝运行时模块
Write-Host "[2/3] Deploying runtime files..." -ForegroundColor Yellow
$itemsToCopy = @("assets", "sidecars", "plugin.json")
foreach ($item in $itemsToCopy) {
    $src = Join-Path $scriptDir $item
    if (Test-Path $src) {
        Copy-Item -Recurse -Force $src $targetDir
    } else {
        throw "Missing core installation file: $item"
    }
}

# 3. 更新 config.json 启用插件
Write-Host "[3/3] Activating plugin in config.json..." -ForegroundColor Yellow
if (Test-Path $configFile) {
    $raw = Get-Content $configFile -Raw -Encoding UTF8
    $config = $raw | ConvertFrom-Json
} else {
    $config = [PSCustomObject]@{ plugins = [PSCustomObject]@{} }
}

if (-not $config.PSObject.Properties['plugins']) {
    $config | Add-Member -NotePropertyName 'plugins' -NotePropertyValue ([PSCustomObject]@{})
}
if (-not $config.plugins.PSObject.Properties['antigravity-context-ring']) {
    $config.plugins | Add-Member -NotePropertyName 'antigravity-context-ring' -NotePropertyValue ([PSCustomObject]@{ enabled = $true })
} else {
    $config.plugins.'antigravity-context-ring'.enabled = $true
}

$jsonContent = $config | ConvertTo-Json -Depth 20
[System.IO.File]::WriteAllText($configFile, $jsonContent, (New-Object System.Text.UTF8Encoding($false)))

# 4. 若 Antigravity 宿主正在运行，自动无感拉起与宿主共存亡的 Sidecar 守护进程（测试隔离模式跳过自动拉起）
$antigravityProc = Get-Process antigravity -ErrorAction SilentlyContinue
if ($antigravityProc -and -not $CustomTargetDir) {
    Write-Host "[4/4] Antigravity host is running, starting Sidecar daemon..." -ForegroundColor Cyan
    $mainScript = Join-Path $targetDir "sidecars\ring\main.mjs"
    Start-Process -FilePath "node.exe" -ArgumentList @("`"$mainScript`"", "--sidecar=antigravity-context-ring") -WindowStyle Hidden
    Write-Host "Sidecar daemon started and bound to Antigravity host!" -ForegroundColor Green
}

Write-Host "------------------------------------------" -ForegroundColor Green
Write-Host "[SUCCESS] Installation complete! Target: $targetDir" -ForegroundColor Green
Write-Host "Note: Sidecar daemon is bound to the Antigravity host lifecycle." -ForegroundColor Cyan
Write-Host "------------------------------------------" -ForegroundColor Green
