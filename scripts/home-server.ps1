param([switch]$SmokeTest, [switch]$TestYouTube, [switch]$ResumeSession, [switch]$StartServer)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$nodePath = (Get-Command node -ErrorAction Stop).Source
$script:webProcess = $null
$script:websiteUrl = 'https://akkarapong821.github.io/Chord-Shift/index.html?page=melody'
$script:localServerUrl = 'http://127.0.0.1:39842'
$logDir = Join-Path $projectDir '.tools'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null
$script:windowMutex = $null
$script:startEvent = $null
$controllerPidFile = Join-Path $logDir 'home-controller.pid'
if (-not $SmokeTest) {
    $hasher = [System.Security.Cryptography.SHA256]::Create()
    try { $rootHash = [BitConverter]::ToString($hasher.ComputeHash([Text.Encoding]::UTF8.GetBytes($projectDir.ToLowerInvariant()))).Replace('-', '').Substring(0, 16) }
    finally { $hasher.Dispose() }
    $script:windowMutex = New-Object System.Threading.Mutex($false, ('Local\MelodyTabHome-' + $rootHash))
    try { $ownsWindow = $script:windowMutex.WaitOne(0) }
    catch [System.Threading.AbandonedMutexException] { $ownsWindow = $true }
    if (-not $ownsWindow) {
        if ($StartServer) {
            # Reuse the existing controller and start its server if stopped.
            # Browser navigation always requires clicking Open website.
            $existingEvent = [System.Threading.EventWaitHandle]::OpenExisting('Local\MelodyTabHomeStart-' + $rootHash)
            try { [void]$existingEvent.Set() } finally { $existingEvent.Dispose() }
        }
        # A second launch brings back this project's existing control window.
        # It never starts another web server or changes another app's port.
        if (Test-Path -LiteralPath $controllerPidFile) {
            $ownerPid = [int]([IO.File]::ReadAllText($controllerPidFile).Trim())
            $ownerInfo = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $ownerPid) -ErrorAction SilentlyContinue
            if ($ownerInfo -and $ownerInfo.CommandLine.Contains((Join-Path $PSScriptRoot 'home-server.ps1'))) {
                $ownerProcess = Get-Process -Id $ownerPid -ErrorAction SilentlyContinue
                if ($ownerProcess -and $ownerProcess.MainWindowHandle -ne [IntPtr]::Zero) {
                    Add-Type -TypeDefinition 'using System; using System.Runtime.InteropServices; public static class MelodyHomeWindow { [DllImport("user32.dll")] public static extern bool ShowWindowAsync(IntPtr h, int command); [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h); }'
                    [MelodyHomeWindow]::ShowWindowAsync($ownerProcess.MainWindowHandle, 9) | Out-Null
                    [MelodyHomeWindow]::SetForegroundWindow($ownerProcess.MainWindowHandle) | Out-Null
                }
            }
        }
        $script:windowMutex.Dispose()
        exit
    }
    $script:startEvent = New-Object System.Threading.EventWaitHandle($false, [System.Threading.EventResetMode]::AutoReset, ('Local\MelodyTabHomeStart-' + $rootHash))
    [IO.File]::WriteAllText($controllerPidFile, [string]$PID)
}

function Stop-HomeServer {
    # These handles belong only to processes created by this window.
    foreach ($ownedProcess in @($script:webProcess)) {
        if ($null -ne $ownedProcess -and -not $ownedProcess.HasExited) {
            # Stop this window's process tree, including an active separator
            # or downloader, without targeting unrelated Python/Node services.
            Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/taskkill.exe') -ArgumentList @('/PID', [string]$ownedProcess.Id, '/T', '/F') -WindowStyle Hidden -Wait | Out-Null
            $ownedProcess.WaitForExit(5000) | Out-Null
        }
    }
    $script:webProcess = $null
}

function Start-HomeServer {
    if ($script:webProcess -and -not $script:webProcess.HasExited) { return }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDir 'dist/index.html'))) { throw 'Build the website first: npm run build' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDir '.tools/yt-dlp.exe'))) { throw 'Install the YouTube downloader first: npm run setup:youtube' }
    $portUsed = Get-NetTCPConnection -LocalPort 39842 -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($portUsed) {
        # Recover only an orphaned server proven to serve this project's exact
        # build. Never kill an unknown service just because it uses our port.
        $webInfo = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $portUsed.OwningProcess)
        $oldParent = Get-CimInstance Win32_Process -Filter ('ProcessId = ' + $webInfo.ParentProcessId) -ErrorAction SilentlyContinue
        $sameBuild = $false
        try {
            $health = Invoke-RestMethod 'http://127.0.0.1:39842/api/health' -TimeoutSec 3
            $page = Invoke-WebRequest -UseBasicParsing 'http://127.0.0.1:39842/index.html?page=melody' -TimeoutSec 3
            $sameBuild = $health.service -eq 'melody-tab' -and $page.Content -eq [IO.File]::ReadAllText((Join-Path $projectDir 'dist/index.html'))
        } catch { }
        if ($sameBuild -and $webInfo.Name -eq 'node.exe' -and $webInfo.CommandLine -match 'server[\\/]index\.js' -and -not $oldParent) {
            $script:webProcess = Get-Process -Id $webInfo.ProcessId
            Stop-HomeServer
            Start-Sleep -Milliseconds 700
        } else {
            throw 'Another application or home-server window is using port 39842. The existing service was left running.'
        }
    }
    try {
        $oldPort = $env:PORT; $oldBind = $env:HOST
        try {
            $env:PORT = '39842'; $env:HOST = '127.0.0.1'
            $script:webProcess = Start-Process -FilePath $nodePath -ArgumentList 'server/index.js' -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'home-web.log') -RedirectStandardError (Join-Path $logDir 'home-web-error.log')
        } finally { $env:PORT = $oldPort; $env:HOST = $oldBind }
        $ready = $false
        for ($attempt = 0; $attempt -lt 20; $attempt++) {
            if ($script:webProcess.HasExited) { throw 'The web server exited. See .tools/home-web-error.log' }
            try {
                $health = Invoke-RestMethod -Uri 'http://127.0.0.1:39842/api/health' -TimeoutSec 1
                if ($health.service -eq 'melody-tab') { $ready = $true; break }
            } catch { Start-Sleep -Milliseconds 250 }
        }
        if (-not $ready) { throw 'The local web server did not start.' }
        # Loopback only: this desktop app does not open a phone or LAN endpoint.
    } catch { Stop-HomeServer; throw }
}

if ($SmokeTest) {
    try {
        Start-HomeServer
        $page = Invoke-WebRequest -UseBasicParsing -Uri $script:websiteUrl -TimeoutSec 15
        if ($page.StatusCode -ne 200 -or -not $page.Content.Contains('id="yt-btn"')) { throw 'GitHub website check failed.' }
        Write-Output "PASS: $script:websiteUrl"
        if ($TestYouTube) {
            $origin = $script:localServerUrl
            $audioFile = Join-Path $logDir 'home-youtube-test.m4a'
            $audioResponse = Invoke-WebRequest -UseBasicParsing -Uri ($origin + '/api/youtube?url=https%3A%2F%2Fwww.youtube.com%2Fwatch%3Fv%3Dz164pDlYtOk') -OutFile $audioFile -PassThru -TimeoutSec 75
            $receivedBytes = (Get-Item -LiteralPath $audioFile).Length
            if ($audioResponse.StatusCode -ne 200 -or $receivedBytes -le 0 -or $audioResponse.Headers['Content-Type'] -notlike 'audio/*') { throw 'YouTube audio check failed.' }
            Write-Output "PASS: YouTube audio $receivedBytes bytes"
        }
    } finally { Stop-HomeServer }
    exit
}

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
[System.Windows.Forms.Application]::EnableVisualStyles()
$form = New-Object System.Windows.Forms.Form
$form.Text = 'Melody Tab - Home Server'
$form.Size = New-Object System.Drawing.Size(640, 310)
$form.StartPosition = 'CenterScreen'
$form.FormBorderStyle = 'FixedDialog'
$form.MaximizeBox = $false
$form.Font = New-Object System.Drawing.Font('Segoe UI', 10)
$statusLabel = New-Object System.Windows.Forms.Label
$statusLabel.Text = 'Server OFF - click Start server when you want to use it.'
$statusLabel.Location = New-Object System.Drawing.Point(20, 20)
$statusLabel.Size = New-Object System.Drawing.Size(580, 55)
$form.Controls.Add($statusLabel)
$urlBox = New-Object System.Windows.Forms.TextBox
$urlBox.Location = New-Object System.Drawing.Point(20, 85)
$urlBox.Size = New-Object System.Drawing.Size(580, 30)
$urlBox.ReadOnly = $true
$form.Controls.Add($urlBox)
$startButton = New-Object System.Windows.Forms.Button
$startButton.Text = 'Start server'
$startButton.Location = New-Object System.Drawing.Point(20, 135)
$startButton.Size = New-Object System.Drawing.Size(135, 40)
$form.Controls.Add($startButton)
$stopButton = New-Object System.Windows.Forms.Button
$stopButton.Text = 'Stop server'
$stopButton.Location = New-Object System.Drawing.Point(165, 135)
$stopButton.Size = New-Object System.Drawing.Size(135, 40)
$stopButton.Enabled = $false
$form.Controls.Add($stopButton)
$openButton = New-Object System.Windows.Forms.Button
$openButton.Text = 'Open website'
$openButton.Location = New-Object System.Drawing.Point(310, 135)
$openButton.Size = New-Object System.Drawing.Size(145, 40)
$openButton.Enabled = $false
$form.Controls.Add($openButton)
$helpLabel = New-Object System.Windows.Forms.Label
$helpLabel.Text = 'Open website uses GitHub Pages. Keep this helper running on this computer for YouTube and guitar separation. Stop server or close this window when finished.'
$helpLabel.Location = New-Object System.Drawing.Point(20, 195)
$helpLabel.Size = New-Object System.Drawing.Size(580, 55)
$form.Controls.Add($helpLabel)
function Show-ServerOn {
    $urlBox.Text = $script:websiteUrl
    $statusLabel.Text = 'Server ON - click Open website to use Melody Tab.'
    $startButton.Enabled = $false; $stopButton.Enabled = $true; $openButton.Enabled = $true
}
$startButton.Add_Click({
    $startButton.Enabled = $false
    $statusLabel.Text = 'Starting...'
    $form.Refresh()
    try {
        Start-HomeServer
        Show-ServerOn
    } catch {
        $statusLabel.Text = 'Server OFF - ' + $_.Exception.Message
        $startButton.Enabled = $true
    }
})
$stopButton.Add_Click({
    Stop-HomeServer
    $statusLabel.Text = 'Server OFF - click Start server when you want to use it.'
    $startButton.Enabled = $true; $stopButton.Enabled = $false; $openButton.Enabled = $false
})
$openButton.Add_Click({ Start-Process $script:websiteUrl })
$form.Add_FormClosing({ Stop-HomeServer })
function Start-ReadyServer {
    try {
        Start-HomeServer
        Show-ServerOn
    } catch {
        $statusLabel.Text = 'Could not start Melody Tab - ' + $_.Exception.Message
        $startButton.Enabled = -not ($script:webProcess -and -not $script:webProcess.HasExited)
    }
}
$openTimer = New-Object System.Windows.Forms.Timer
$openTimer.Interval = 250
$openTimer.Add_Tick({
    if ($script:startEvent.WaitOne(0)) { Start-ReadyServer }
})
$openTimer.Start()
$form.Add_Shown({ if ($StartServer) { Start-ReadyServer } })
# A previous crashed controller can leave its children running. Recover that
# session; a fresh launch without an existing server still stays OFF.
if ($ResumeSession -or (Get-NetTCPConnection -LocalPort 39842 -State Listen -ErrorAction SilentlyContinue)) {
    try { Start-HomeServer; Show-ServerOn }
    catch { $statusLabel.Text = 'Server OFF - ' + $_.Exception.Message }
}
try { [void]$form.ShowDialog() } finally {
    $openTimer.Stop(); $openTimer.Dispose()
    if ($script:startEvent) { $script:startEvent.Dispose() }
    Stop-HomeServer
    if ($script:windowMutex) { $script:windowMutex.ReleaseMutex(); $script:windowMutex.Dispose() }
}
