param([switch]$SmokeTest, [switch]$TestYouTube)
$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
$tailscalePath = Join-Path $env:ProgramFiles 'Tailscale\tailscale.exe'
$nodePath = (Get-Command node -ErrorAction Stop).Source
$script:webProcess = $null
$script:serveProcess = $null
$script:phoneUrl = ''
$logDir = Join-Path $projectDir '.tools'
New-Item -ItemType Directory -Path $logDir -Force | Out-Null

function Stop-HomeServer {
    # These handles belong only to processes created by this window.
    foreach ($ownedProcess in @($script:serveProcess, $script:webProcess)) {
        if ($null -ne $ownedProcess -and -not $ownedProcess.HasExited) {
            # Stop this window's process tree, including an active separator
            # or downloader, without targeting unrelated Python/Node services.
            Start-Process -FilePath (Join-Path $env:SystemRoot 'System32/taskkill.exe') -ArgumentList @('/PID', [string]$ownedProcess.Id, '/T', '/F') -WindowStyle Hidden -Wait | Out-Null
            $ownedProcess.WaitForExit(5000) | Out-Null
        }
    }
    $script:serveProcess = $null
    $script:webProcess = $null
}

function Start-HomeServer {
    if ($script:webProcess -and -not $script:webProcess.HasExited) { return }
    if (-not (Test-Path -LiteralPath $tailscalePath)) { throw 'Install Tailscale on this computer first.' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDir 'dist/index.html'))) { throw 'Build the website first: npm run build' }
    if (-not (Test-Path -LiteralPath (Join-Path $projectDir '.tools/yt-dlp.exe'))) { throw 'Install the YouTube downloader first: npm run setup:youtube' }
    $tailJson = & $tailscalePath status --json 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot connect to Tailscale. Open Tailscale and sign in.' }
    $tailState = $tailJson | ConvertFrom-Json
    if ($tailState.BackendState -ne 'Running') { throw 'Connect Tailscale on this computer before starting.' }
    $dnsName = $tailState.Self.DNSName.TrimEnd('.')
    if (-not $dnsName) { throw 'Tailscale DNS name is unavailable.' }
    $serveJson = & $tailscalePath serve status --json 2>$null
    if ($LASTEXITCODE -ne 0) { throw 'Cannot inspect existing Tailscale services.' }
    $serveConfig = $serveJson | ConvertFrom-Json
    if ($serveConfig.TCP.'8443') { throw 'Tailscale port 8443 is already used. Stop the previous home-server window first.' }
    $portUsed = Get-NetTCPConnection -LocalPort 39842 -State Listen -ErrorAction SilentlyContinue
    if ($portUsed) { throw 'Port 39842 is already used. Close the previous home-server window first.' }
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
        # Foreground Serve belongs to this child process. No --bg, scheduled
        # task, startup entry, public Funnel or change to the existing port 443.
        $script:serveProcess = Start-Process -FilePath $tailscalePath -ArgumentList @('serve', '--https=8443', '--bg=false', 'http://127.0.0.1:39842') -WorkingDirectory $projectDir -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $logDir 'home-tailscale.log') -RedirectStandardError (Join-Path $logDir 'home-tailscale-error.log')
        Start-Sleep -Milliseconds 1500
        if ($script:serveProcess.HasExited) { throw 'Tailscale Serve could not start. See .tools/home-tailscale-error.log' }
        $script:phoneUrl = "https://${dnsName}:8443/index.html?page=melody"
    } catch { Stop-HomeServer; throw }
}

if ($SmokeTest) {
    try {
        Start-HomeServer
        $page = Invoke-WebRequest -UseBasicParsing -Uri $script:phoneUrl -TimeoutSec 15
        if ($page.StatusCode -ne 200 -or -not $page.Content.Contains('id="yt-btn"')) { throw 'Home website check failed.' }
        Write-Output "PASS: $script:phoneUrl"
        if ($TestYouTube) {
            $origin = ([Uri]$script:phoneUrl).GetLeftPart([System.UriPartial]::Authority)
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
$copyButton = New-Object System.Windows.Forms.Button
$copyButton.Text = 'Copy phone link'
$copyButton.Location = New-Object System.Drawing.Point(310, 135)
$copyButton.Size = New-Object System.Drawing.Size(145, 40)
$copyButton.Enabled = $false
$form.Controls.Add($copyButton)
$openButton = New-Object System.Windows.Forms.Button
$openButton.Text = 'Open website'
$openButton.Location = New-Object System.Drawing.Point(465, 135)
$openButton.Size = New-Object System.Drawing.Size(135, 40)
$openButton.Enabled = $false
$form.Controls.Add($openButton)
$helpLabel = New-Object System.Windows.Forms.Label
$helpLabel.Text = 'Keep this window open. Connect Tailscale on your phone using the same account. Stop server or close this window when finished.'
$helpLabel.Location = New-Object System.Drawing.Point(20, 195)
$helpLabel.Size = New-Object System.Drawing.Size(580, 55)
$form.Controls.Add($helpLabel)
$startButton.Add_Click({
    $startButton.Enabled = $false
    $statusLabel.Text = 'Starting...'
    $form.Refresh()
    try {
        Start-HomeServer
        $urlBox.Text = $script:phoneUrl
        $statusLabel.Text = 'Server ON - open the link on your phone with Tailscale connected.'
        $stopButton.Enabled = $true; $copyButton.Enabled = $true; $openButton.Enabled = $true
    } catch {
        $statusLabel.Text = 'Server OFF - ' + $_.Exception.Message
        $startButton.Enabled = $true
    }
})
$stopButton.Add_Click({
    Stop-HomeServer
    $statusLabel.Text = 'Server OFF - click Start server when you want to use it.'
    $startButton.Enabled = $true; $stopButton.Enabled = $false; $copyButton.Enabled = $false; $openButton.Enabled = $false
})
$copyButton.Add_Click({ [System.Windows.Forms.Clipboard]::SetText($script:phoneUrl) })
$openButton.Add_Click({ Start-Process $script:phoneUrl })
$form.Add_FormClosing({ Stop-HomeServer })
try { [void]$form.ShowDialog() } finally { Stop-HomeServer }
