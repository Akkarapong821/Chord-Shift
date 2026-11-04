$ErrorActionPreference = 'Stop'
$projectDir = Split-Path -Parent $PSScriptRoot
Push-Location $projectDir
try {
    $manifest = Get-Content -LiteralPath 'package.json' -Raw | ConvertFrom-Json
    # Windows PowerShell 5.1 cannot parse the lockfile's empty root-package key.
    $lockVersion = & node -p "JSON.parse(require('node:fs').readFileSync('package-lock.json', 'utf8')).version"
    if ($LASTEXITCODE -ne 0) { throw 'Could not read package-lock.json.' }
    $version = $manifest.version
    if ($version -notmatch '^\d+\.\d+\.\d+$' -or $lockVersion -ne $version) {
        throw 'package.json and package-lock.json must have the same release version.'
    }
    & npm.cmd test
    if ($LASTEXITCODE -ne 0) { throw 'Tests failed.' }
    & npm.cmd run postinstall
    if ($LASTEXITCODE -ne 0) { throw 'Could not prepare bundled model/OCR assets.' }
    & npm.cmd run build
    if ($LASTEXITCODE -ne 0) { throw 'Build failed.' }

    # A fresh staging directory avoids stale files and never copies local tools,
    # credentials, caches, Git metadata, or node_modules into the distribution.
    $outputDir = Join-Path $projectDir 'releases'
    New-Item -ItemType Directory -Path $outputDir -Force | Out-Null
    $stage = Join-Path $outputDir ('stage-' + [guid]::NewGuid().ToString('N'))
    $packageName = 'Chord-Shift-' + $version
    $packageDir = Join-Path $stage $packageName
    New-Item -ItemType Directory -Path $packageDir -Force | Out-Null
    $entries = @('dist', 'src', 'server', 'scripts', 'package.json', 'package-lock.json',
        'README.md', 'CHANGELOG.md', 'index.html', 'chords.html', 'vite.config.js',
        'render.yaml', 'start-youtube-helper.cmd')
    foreach ($entry in $entries) {
        Copy-Item -LiteralPath (Join-Path $projectDir $entry) -Destination $packageDir -Recurse
    }
    $publicDir = Join-Path $packageDir 'public'
    New-Item -ItemType Directory -Path $publicDir | Out-Null
    foreach ($entry in @('device-access.js', 'test-melody.wav')) {
        Copy-Item -LiteralPath (Join-Path $projectDir ('public/' + $entry)) -Destination $publicDir
    }

    Add-Type -AssemblyName System.IO.Compression
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    function New-ReleaseZip([string]$sourceDir, [string]$destination, [string]$prefix) {
        $sourceFull = [IO.Path]::GetFullPath($sourceDir).TrimEnd('\') + '\'
        $archive = [IO.Compression.ZipFile]::Open($destination, [IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($file in Get-ChildItem -LiteralPath $sourceDir -File -Recurse) {
                # ZIP paths use forward slashes, including archives made on .NET Framework.
                $entryName = $prefix + $file.FullName.Substring($sourceFull.Length).Replace('\', '/')
                [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($archive, $file.FullName, $entryName, [IO.Compression.CompressionLevel]::Optimal) | Out-Null
            }
        } finally { $archive.Dispose() }
    }
    $assets = @(
        ($packageName + '-windows-node.zip'),
        ($packageName + '-web.zip'),
        ($manifest.name + '-' + $version + '.tgz')
    )
    # Create archives in staging, then replace only the exact output files.
    New-ReleaseZip $packageDir (Join-Path $stage $assets[0]) ($packageName + '/')
    New-ReleaseZip (Join-Path $projectDir 'dist') (Join-Path $stage $assets[1]) ''
    & npm.cmd pack --pack-destination $stage
    if ($LASTEXITCODE -ne 0) { throw 'npm pack failed.' }
    foreach ($asset in $assets) {
        Move-Item -LiteralPath (Join-Path $stage $asset) -Destination (Join-Path $outputDir $asset) -Force
    }
    $checksums = foreach ($asset in $assets) {
        $sha256 = [Security.Cryptography.SHA256]::Create()
        $stream = [IO.File]::OpenRead((Join-Path $outputDir $asset))
        try { $hash = [BitConverter]::ToString($sha256.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
        finally { $stream.Dispose(); $sha256.Dispose() }
        $hash + '  ' + $asset
    }
    [IO.File]::WriteAllLines((Join-Path $outputDir 'SHA256SUMS.txt'), [string[]]$checksums, [Text.Encoding]::ASCII)
    # Validate the resolved target before recursively removing our own staging.
    $stageFull = [IO.Path]::GetFullPath($stage)
    $outputFull = [IO.Path]::GetFullPath($outputDir).TrimEnd('\') + '\'
    if (-not $stageFull.StartsWith($outputFull, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Staging directory is outside the release output directory.'
    }
    Remove-Item -LiteralPath $stageFull -Recurse -Force
    Write-Output ('Release ' + $version + ' ready in ' + $outputDir)
} finally {
    Pop-Location
}
