$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Split-Path -Parent $PSScriptRoot))
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$executable = Join-Path $projectRoot "release\Paceline-$($manifest.version)-windows-x64.exe"
if (-not (Test-Path -LiteralPath $executable)) { throw 'Build the portable application first: npm run dist:win' }

# Keep portable extraction on the same drive as the project.
$runtimeTemp = Join-Path $projectRoot '.local\runtime-tmp'
New-Item -ItemType Directory -Path $runtimeTemp -Force | Out-Null
# A portable run that did not exit cleanly leaves a full app extraction behind. Clear those only
# when no instance is running from here, so a live copy is never touched.
$live = @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -and ($_.Path.StartsWith($runtimeTemp, [StringComparison]::OrdinalIgnoreCase) -or $_.Path -eq $executable) })
if ($live.Count -eq 0) {
  Get-ChildItem -LiteralPath $runtimeTemp -Force | ForEach-Object { Remove-Item -LiteralPath $_.FullName -Recurse -Force -ErrorAction SilentlyContinue }
}
$env:TEMP = $runtimeTemp
$env:TMP = $runtimeTemp
Start-Process -FilePath $executable -WorkingDirectory $projectRoot -WindowStyle Hidden
