/**
 * The PowerShell program the Windows collector runs, kept apart from the
 * process plumbing so both stay readable.
 *
 * Why a resident PowerShell instead of one query per tick: `powershell.exe`
 * takes ~1.5s just to boot, while the CIM query itself is ~104ms for ~390
 * processes. Paying the boot once and looping is the only shape that supports
 * a 1-2s refresh.
 *
 * Why not `wmic`: it was removed from Windows 11 (build 26200 has no trace of
 * it), which is also what rules out the npm process-listing packages —
 * `ps-list`, `pidusage` and `pidtree` all shell out to it on Windows.
 *
 * Command lines are fetched separately because including `CommandLine` in the
 * base query triples its cost (~322ms / 154KB vs ~104ms / 19KB). They are
 * immutable for the life of a process, so one full sweep on the first frame
 * plus a filtered top-up for newcomers is both cheaper and complete.
 *
 * The script is an array of plain single-quoted JS strings on purpose: a
 * template literal cannot hold PowerShell's backtick escapes (`` `t ``) without
 * a leading backslash surviving into the script, and `\r`/`\n` in a normal JS
 * string would become real control characters.
 */

/** Cap on the `or`-joined pid filter — the rest rolls into the next frame. */
const NEW_PID_BATCH = 40;

const SCRIPT_LINES: string[] = [
  "$ErrorActionPreference = 'Continue'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
  "$props = @('ProcessId','ParentProcessId','Name','WorkingSetSize','PrivatePageCount',",
  "  'KernelModeTime','UserModeTime','ReadTransferCount','WriteTransferCount','CreationDate')",
  '$epoch = [DateTime]::new(1970,1,1,0,0,0,[DateTimeKind]::Utc)',
  // Keyed by "pid:startedAtMs" so a recycled pid counts as a new process and
  // gets its command line re-read instead of inheriting the dead one's.
  "$emitted = New-Object 'System.Collections.Generic.HashSet[string]'",
  '$out = [Console]::Out',
  '$firstFrame = $true',
  'while ($true) {',
  '  try { $procs = @(Get-CimInstance Win32_Process -Property $props) } catch { $procs = @() }',
  '  if ($procs.Count -gt 0) {',
  '    $sb = New-Object Text.StringBuilder',
  "    $alive = New-Object 'System.Collections.Generic.HashSet[string]'",
  "    $fresh = New-Object 'System.Collections.Generic.List[string]'",
  '    foreach ($p in $procs) {',
  '      $id = [int]$p.ProcessId',
  '      $created = 0',
  '      if ($p.CreationDate) {',
  '        $created = [long](($p.CreationDate.ToUniversalTime() - $epoch).TotalMilliseconds)',
  '      }',
  '      $key = "$id`:$created"',
  '      [void]$alive.Add($key)',
  '      if (-not $emitted.Contains($key)) { [void]$fresh.Add($key) }',
  '      [void]$sb.Append("#P`t$id`t$([int]$p.ParentProcessId)`t$($p.Name)`t")',
  '      [void]$sb.Append("$($p.WorkingSetSize)`t$($p.PrivatePageCount)`t")',
  '      [void]$sb.Append("$($p.KernelModeTime)`t$($p.UserModeTime)`t")',
  '      [void]$sb.AppendLine("$($p.ReadTransferCount)`t$($p.WriteTransferCount)`t$created")',
  '    }',
  '    $cmdRows = @()',
  "    $claimed = New-Object 'System.Collections.Generic.List[string]'",
  '    try {',
  '      if ($firstFrame) {',
  '        $cmdRows = @(Get-CimInstance Win32_Process -Property ProcessId,CommandLine)',
  '        $claimed.AddRange([string[]]@($alive))',
  '      } elseif ($fresh.Count -gt 0) {',
  '        $batch = @($fresh | Select-Object -First __BATCH__)',
  "        $filter = ($batch | ForEach-Object { \"ProcessId=$($_.Split(':')[0])\" }) -join ' or '",
  '        $cmdRows = @(Get-CimInstance Win32_Process -Filter $filter -Property ProcessId,CommandLine)',
  '        $claimed.AddRange([string[]]$batch)',
  '      }',
  '    } catch { $cmdRows = @() }',
  '    foreach ($c in $cmdRows) {',
  '      if ($c.CommandLine) {',
  '        $line = $c.CommandLine.Replace("`r", " ").Replace("`n", " ").Replace("`t", " ")',
  '        [void]$sb.AppendLine("#C`t$([int]$c.ProcessId)`t$line")',
  '      }',
  '    }',
  // Claim first, then intersect: `claimed` marks pids whose command line was
  // asked for (even if the OS refused to hand one over, so protected system
  // processes are not re-queried forever), and the intersection drops keys for
  // processes that have since exited.
  '    $emitted.UnionWith($claimed)',
  '    $emitted.IntersectWith($alive)',
  '    $firstFrame = $false',
  '    [void]$sb.AppendLine("#E`t$([long](([DateTime]::UtcNow - $epoch).TotalMilliseconds))")',
  '    try { $out.Write($sb.ToString()); $out.Flush() } catch { exit 0 }',
  '  }',
  '  Start-Sleep -Milliseconds __INTERVAL__',
  '}',
];

/**
 * Build the `-EncodedCommand` payload: base64 of UTF-16LE, which is what
 * PowerShell expects and what removes every layer of quoting between here and
 * the shell.
 */
export function buildWindowsCensusCommand(intervalMs: number): string {
  const interval = Math.max(500, Math.min(10_000, Math.round(intervalMs)));
  const script = SCRIPT_LINES.join('\n')
    .replaceAll('__INTERVAL__', String(interval))
    .replaceAll('__BATCH__', String(NEW_PID_BATCH));
  return Buffer.from(script, 'utf16le').toString('base64');
}

/** Exposed for the smoke test that runs the script for real. */
function windowsCensusScript(intervalMs: number): string {
  return Buffer.from(buildWindowsCensusCommand(intervalMs), 'base64').toString('utf16le');
}
