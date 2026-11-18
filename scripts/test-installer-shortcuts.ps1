param(
    [string]$NsisDirectory,
    [string]$NsisResourcesDirectory
)
$ErrorActionPreference = 'Stop'
$projectRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$cacheRoot = Join-Path $env:LOCALAPPDATA 'electron-builder\Cache'
if (-not $NsisDirectory) {
    $NsisDirectory = (Get-ChildItem (Join-Path $cacheRoot 'nsis-3.0.4.1') -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'makensis.exe') } | Select-Object -First 1).FullName
}
if (-not $NsisResourcesDirectory) {
    $NsisResourcesDirectory = (Get-ChildItem (Join-Path $cacheRoot 'nsis-resources-3.4.1') -Directory |
        Where-Object { Test-Path (Join-Path $_.FullName 'plugins') } | Select-Object -First 1).FullName
}
if (-not $NsisDirectory -or -not $NsisResourcesDirectory) {
    throw 'Build the Windows installer first, or supply the electron-builder NSIS cache directories.'
}

# Real .lnk files and the production NSIS repair code, but no Windows shell
# folders, installed application, registry, elevation or user profile writes.
$testRoot = Join-Path $projectRoot ('.tmp\installer-shortcuts\' + [guid]::NewGuid().ToString('N'))
$null = New-Item -ItemType Directory -Path $testRoot -Force
$dirs = @{}
foreach ($name in @('userPrograms', 'commonPrograms', 'userDesktop', 'commonDesktop', 'pinned', 'implicit', 'old', 'custom', 'new version ação')) {
    $dirs[$name] = Join-Path $testRoot $name
    $null = New-Item -ItemType Directory -Path $dirs[$name] -Force
}
$null = New-Item -ItemType Directory -Path (Join-Path $dirs.userPrograms 'CodeStudio Local')
$implicitApp = Join-Path $dirs.implicit '1234abcd'
$null = New-Item -ItemType Directory -Path $implicitApp
$oldExe = Join-Path $dirs.old 'CodeStudio Local.exe'
$newExe = Join-Path $dirs['new version ação'] 'CodeStudio Local.exe'
$otherExe = Join-Path $dirs.old 'CodeStudio.exe'
foreach ($file in @($oldExe, $newExe, $otherExe)) { [IO.File]::WriteAllText($file, 'shortcut fixture; never executed') }
$customIcon = Join-Path $dirs.custom 'custom.ico'
Copy-Item -LiteralPath (Join-Path $projectRoot 'apps\electron\build\icon.ico') -Destination $customIcon
$shell = New-Object -ComObject WScript.Shell
$shellNamespace = New-Object -ComObject Shell.Application
$records = [Collections.Generic.List[object]]::new()
function Add-TestShortcut($name, $folder, $fileName, $target, $workingDirectory, $icon, $arguments = '') {
    $linkPath = Join-Path $folder $fileName
    $link = $shell.CreateShortcut($linkPath)
    $link.TargetPath = $target
    $link.WorkingDirectory = $workingDirectory
    $link.IconLocation = "$icon,0"
    $link.Arguments = $arguments
    $link.Description = "Preserve $name"
    $link.Hotkey = 'CTRL+ALT+F11'
    $link.WindowStyle = 3
    $link.Save()
    $records.Add([pscustomobject]@{ name = $name; path = $linkPath; target = $target; cwd = $workingDirectory; icon = $icon; args = $arguments; hotkey = $link.Hotkey })
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)
}
Add-TestShortcut 'per-user shadow of common menu' $dirs.userPrograms 'CodeStudio Local.lnk' $oldExe $dirs.old $oldExe
Add-TestShortcut 'all-users Start Menu' $dirs.commonPrograms 'CodeStudio Local.lnk' $oldExe $dirs.old $oldExe
Add-TestShortcut 'public desktop' $dirs.commonDesktop 'CodeStudio Local.lnk' $oldExe $dirs.old $oldExe
Add-TestShortcut 'renamed user desktop' $dirs.userDesktop 'My CodeStudio Local.lnk' $oldExe $dirs.old $oldExe
Add-TestShortcut 'legacy menu folder' (Join-Path $dirs.userPrograms 'CodeStudio Local') 'CodeStudio Local.lnk' $oldExe $dirs.old $oldExe
Add-TestShortcut 'pinned taskbar link' $dirs.pinned 'CodeStudio Local.lnk' $oldExe $dirs.old $oldExe
Add-TestShortcut 'implicit pin from a running app' $implicitApp 'CodeStudio Local.lnk' $oldExe $dirs.old $oldExe
$missingExe = Join-Path $testRoot 'removed build\CodeStudio Local.exe'
Add-TestShortcut 'removed old executable' $dirs.userPrograms 'Old build.lnk' $missingExe (Split-Path $missingExe) $missingExe
Add-TestShortcut 'standard edition with local shortcut label' $dirs.userDesktop 'CodeStudio Local.lnk' $otherExe $dirs.old $otherExe
Add-TestShortcut 'custom arguments and project location' $dirs.userPrograms 'Project.lnk' $oldExe $dirs.custom $customIcon '--user-data-dir="D:\custom profile" "D:\project with spaces"'
Add-TestShortcut 'already up to date' $dirs.commonPrograms 'Current.lnk' $newExe $dirs['new version ação'] $newExe
$corruptLink = Join-Path $dirs.userDesktop 'Broken.lnk'
[IO.File]::WriteAllText($corruptLink, 'not a Shell Link')
$corruptHash = (Get-FileHash -LiteralPath $corruptLink).Hash
$stable = @{}
foreach ($record in $records | Where-Object { $_.target -eq $otherExe }) {
    $stable[$record.path] = (Get-FileHash -LiteralPath $record.path).Hash
}

function ConvertTo-NsisLiteral([string]$value) {
    if ($value.Contains('$') -or $value.Contains('"') -or $value.Contains("`n")) { throw 'Unsupported NSIS test path' }
    return $value
}
$include = ConvertTo-NsisLiteral (Join-Path $projectRoot 'apps\electron\build\installer.nsh')
$plugins = ConvertTo-NsisLiteral (Join-Path $NsisResourcesDirectory 'plugins\x86-unicode')
$testExe = ConvertTo-NsisLiteral (Join-Path $testRoot 'shortcut-repair-test.exe')
$script = @"
Unicode true
RequestExecutionLevel user
SilentInstall silent
OutFile "$testExe"
!define PRODUCT_FILENAME "CodeStudio Local"
!define SHORTCUT_NAME "CodeStudio Local"
!define APP_ID "studio.codestudio.local"
!include "$include"
!addplugindir "$plugins"
!insertmacro customHeader
Section
  StrCpy `$INSTDIR "$(ConvertTo-NsisLiteral $dirs['new version ação'])"
  !insertmacro CodeStudioRepairShortcutLocations "$(ConvertTo-NsisLiteral $dirs.commonPrograms)" "$(ConvertTo-NsisLiteral $dirs.commonDesktop)" "" ""
  !insertmacro CodeStudioRepairShortcutLocations "$(ConvertTo-NsisLiteral $dirs.userPrograms)" "$(ConvertTo-NsisLiteral $dirs.userDesktop)" "$(ConvertTo-NsisLiteral $dirs.pinned)" "$(ConvertTo-NsisLiteral $dirs.implicit)"
  SetErrorLevel 0
SectionEnd
"@
$nsi = Join-Path $testRoot 'test.nsi'
[IO.File]::WriteAllText($nsi, $script, [Text.UTF8Encoding]::new($true))
$compileOutput = & (Join-Path $NsisDirectory 'makensis.exe') '/V3' $nsi 2>&1
$compileOutput | Set-Content (Join-Path $testRoot 'compile.log')
if ($LASTEXITCODE -ne 0) { throw "NSIS compilation failed: $compileOutput" }
function Invoke-TestInstaller {
    $process = Start-Process -FilePath $testExe -ArgumentList '/S' -WindowStyle Hidden -PassThru
    if (-not $process.WaitForExit(20000)) { $process.Kill(); throw 'Shortcut fixture timed out' }
    if ($process.ExitCode -ne 0) { throw "Shortcut fixture exited $($process.ExitCode)" }
}
function Assert-Equal($actual, $expected, $message) {
    if ($actual -ne $expected) { throw "${message}: expected '$expected', received '$actual'" }
}
Invoke-TestInstaller
$results = [Collections.Generic.List[object]]::new()
foreach ($record in $records) {
    $link = $shell.CreateShortcut($record.path)
    $expected = if ($record.target -eq $otherExe) { $otherExe } else { $newExe }
    Assert-Equal $link.TargetPath $expected "$($record.name) target"
    $expectedCwd = if ($record.cwd -eq $dirs.custom -or $record.target -eq $otherExe) { $record.cwd } else { $dirs['new version ação'] }
    Assert-Equal $link.WorkingDirectory $expectedCwd "$($record.name) working directory"
    $expectedIcon = if ($record.icon -eq $customIcon -or $record.target -eq $otherExe) { $record.icon } else { $newExe }
    Assert-Equal $link.IconLocation "$expectedIcon,0" "$($record.name) icon"
    Assert-Equal $link.Arguments $record.args "$($record.name) arguments"
    Assert-Equal $link.Description "Preserve $($record.name)" "$($record.name) description"
    Assert-Equal $link.Hotkey $record.hotkey "$($record.name) hotkey"
    Assert-Equal $link.WindowStyle 3 "$($record.name) window style"
    if ($record.target -ne $otherExe) {
        $folder = $shellNamespace.Namespace((Split-Path $record.path))
        $item = $folder.ParseName((Split-Path $record.path -Leaf))
        Assert-Equal ($item.ExtendedProperty('System.AppUserModel.ID')) 'studio.codestudio.local' "$($record.name) Windows app identity"
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($item)
        [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($folder)
    }
    [void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($link)
    $results.Add([pscustomobject]@{ name = $record.name; passed = $true })
}
foreach ($file in $stable.Keys) { Assert-Equal (Get-FileHash -LiteralPath $file).Hash $stable[$file] 'Unchanged shortcut bytes' }
Assert-Equal (Get-FileHash -LiteralPath $corruptLink).Hash $corruptHash 'Corrupt link must remain untouched'
Assert-Equal (Test-Path (Join-Path $dirs.pinned 'New shortcut.lnk')) $false 'Do not create or pin new shortcuts'
$beforeSecondPass = @{}
foreach ($record in $records) { $beforeSecondPass[$record.path] = (Get-FileHash -LiteralPath $record.path).Hash }
Invoke-TestInstaller
foreach ($file in $beforeSecondPass.Keys) { Assert-Equal (Get-FileHash -LiteralPath $file).Hash $beforeSecondPass[$file] 'Idempotent reinstall' }
$results.Add([pscustomobject]@{ name = 'corrupt and absent shortcuts preserved'; passed = $true })
$results.Add([pscustomobject]@{ name = 'reinstall is idempotent'; passed = $true })
$builder = Get-Content (Join-Path $projectRoot 'apps\electron\electron-builder.json') -Raw | ConvertFrom-Json
$identitySource = Get-Content (Join-Path $projectRoot 'apps\electron\src\app-icon.ts') -Raw
if ($identitySource -notmatch "userModelId:\s*'([^']+)'") { throw 'Runtime Windows identity not found' }
Assert-Equal $Matches[1] $builder.appId 'Runtime and installer must use the same Windows app identity'
$results.Add([pscustomobject]@{ name = 'runtime and installer Windows identity agree'; passed = $true })
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shell)
[void][Runtime.InteropServices.Marshal]::FinalReleaseComObject($shellNamespace)
$receipt = [pscustomobject]@{ passed = $results.Count; failed = 0; testRoot = $testRoot; tests = $results }
$receipt | ConvertTo-Json -Depth 5 | Set-Content (Join-Path $testRoot 'result.json')
$receipt | ConvertTo-Json -Depth 5
