$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$executable = Join-Path $projectRoot "release\Paceline-$($manifest.version)-windows-x64.exe"
if (-not (Test-Path -LiteralPath $executable)) { throw 'Build the portable application first: npm run dist:win' }
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut((Join-Path $projectRoot 'Abrir Paceline.lnk'))
$shortcut.TargetPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launcher = Join-Path $PSScriptRoot 'start-portable.ps1'
$shortcut.Arguments = '-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $launcher + '"'
$shortcut.WorkingDirectory = $projectRoot
$shortcut.IconLocation = Join-Path $projectRoot 'assets\icon.ico'
$shortcut.Description = 'Paceline - monitor local de limites de IA'
$shortcut.Save()
Write-Output 'Created Abrir Paceline.lnk in the project directory.'
