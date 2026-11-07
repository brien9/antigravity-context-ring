# Antigravity Context Ring Uninstaller
param(
    [string]$CustomTargetDir = $env:AGY_TEST_TARGET_DIR,
    [string]$CustomConfigFile = $env:AGY_TEST_CONFIG_FILE
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$OutputEncoding = [System.Text.Encoding]::UTF8

$homeDir = [System.Environment]::GetFolderPath('UserProfile')
$targetDir = if ($CustomTargetDir) { $CustomTargetDir } else { Join-Path $homeDir ".gemini\config\plugins\antigravity-context-ring" }
$configFile = if ($CustomConfigFile) { $CustomConfigFile } else { Join-Path $homeDir ".gemini\config\config.json" }

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "   Antigravity Context Ring Uninstaller   " -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# 0. 精准终止正在运行的 Sidecar 守护进程（严格白名单）
Write-Host "[0/2] Terminating running Sidecar daemon..." -ForegroundColor Yellow
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
Start-Sleep -Milliseconds 600

# 1. 禁用配置
if (Test-Path $configFile) {
    Write-Host "[1/2] Updating plugin configuration to disabled..." -ForegroundColor Yellow
    try {
        $raw = Get-Content $configFile -Raw -Encoding UTF8
        $config = $raw | ConvertFrom-Json
        if ($config.PSObject.Properties['plugins'] -and $config.plugins.PSObject.Properties['antigravity-context-ring']) {
            $config.plugins.'antigravity-context-ring'.enabled = $false
            $jsonContent = $config | ConvertTo-Json -Depth 20
            [System.IO.File]::WriteAllText($configFile, $jsonContent, (New-Object System.Text.UTF8Encoding($false)))
        }
    } catch {
        Write-Warning "Skipped updating config.json due to error."
    }
}

# 2. 移除插件文件（带句柄释放重试）
Write-Host "[2/2] Cleaning up plugin files..." -ForegroundColor Yellow
if (Test-Path $targetDir) {
    for ($i = 0; $i -lt 5; $i++) {
        try {
            Remove-Item -Recurse -Force $targetDir -ErrorAction Stop
            break
        } catch {
            Start-Sleep -Milliseconds 500
        }
    }
}

Write-Host "------------------------------------------" -ForegroundColor Green
Write-Host "[SUCCESS] Plugin uninstalled successfully!" -ForegroundColor Green
Write-Host "Note: Restart Antigravity to restore clean default UI." -ForegroundColor Cyan
Write-Host "------------------------------------------" -ForegroundColor Green
