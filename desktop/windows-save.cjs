const { runWindowsPowerShell } = require('./windows-powershell.cjs');

// Exchange data over stdin. Filenames and project text are never PowerShell code.
const save = String.raw`
$request = ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())
$target = $request.target
$temporary = $request.temporary
$backup = $temporary + '.previous'
$file = $null
$published = $false
$replacementAttempted = $false

function Test-RegularFile([string] $name) {
  try { $attributes = [IO.File]::GetAttributes($name) }
  catch [IO.FileNotFoundException] { return $false }
  if ($attributes -band ([IO.FileAttributes]::Directory -bor [IO.FileAttributes]::ReparsePoint)) {
    throw 'Expected a regular file'
  }
  return $true
}

try {
  $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User
  $acl = [Security.AccessControl.FileSecurity]::new()
  $acl.SetAccessRuleProtection($true, $false)
  $acl.SetAccessRule([Security.AccessControl.FileSystemAccessRule]::new($sid, 'FullControl', 'Allow'))
  $file = [IO.FileStream]::new($temporary, 'CreateNew', [Security.AccessControl.FileSystemRights]::Write,
    [IO.FileShare]::None, 65536, [IO.FileOptions]::None, $acl)
  try {
    $bytes = [Text.Encoding]::UTF8.GetBytes($request.contents)
    $file.Write($bytes, 0, $bytes.Length)
    $file.Flush($true)
  } finally { $file.Dispose() }

  $delays = @(25, 50, 100, 200, 400)
  for ($attempt = 0; ; $attempt++) {
    $parent = [IO.Path]::GetDirectoryName($target)
    while ($parent) {
      if ([IO.File]::GetAttributes($parent) -band [IO.FileAttributes]::ReparsePoint) { throw 'Expected a regular folder' }
      $parent = [IO.Path]::GetDirectoryName($parent)
    }
    if ((Test-RegularFile $target) -ne $request.overwrite) { throw 'Destination changed while saving' }
    if (!(Test-RegularFile $temporary)) { throw 'Temporary file is missing' }
    try {
      if ($request.overwrite) {
        # ReplaceFileW preserves the destination DACL and retains its old bytes
        # in a backup even for partial replacement failures.
        if (Test-RegularFile $backup) { throw 'Backup name is already in use' }
        $replacementAttempted = $true
        [IO.File]::Replace($temporary, $target, $backup, $false)
      } else {
        # File.Move without overwrite fails if another file appeared.
        [IO.File]::Move($temporary, $target)
      }
      $published = $true
      break
    } catch {
      $code = $_.Exception.GetBaseException().HResult -band 0xffff
      if ($attempt -ge $delays.Length -or $code -notin @(5, 32, 33) -or [IO.File]::Exists($backup)) { throw }
      Start-Sleep -Milliseconds $delays[$attempt]
    }
  }
} catch {
  if ($replacementAttempted -and [IO.File]::Exists($backup)) {
    try { [IO.File]::Move($backup, $target) }
    catch { [Console]::WriteLine('원본 백업: ' + $backup); exit 1 }
  }
  [Console]::WriteLine('Windows 저장 교체에 실패했습니다. 대상과 폴더의 권한을 확인해 주세요.')
  exit 1
} finally {
  if ($null -ne $file) { try { [IO.File]::Delete($temporary) } catch {} }
  if ($published -and $replacementAttempted) { try { [IO.File]::Delete($backup) } catch {} }
}
`;

async function writeWindowsProject(target, temporary, contents, overwrite) {
  await runWindowsPowerShell(save, { target, temporary, contents, overwrite });
}

module.exports = { writeWindowsProject };
