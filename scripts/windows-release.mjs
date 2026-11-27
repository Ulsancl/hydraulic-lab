import path from 'node:path';
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses';
import { runWindowsPowerShell } from '../desktop/windows-powershell.cjs';

export async function verifyFuses(file, test) {
  const wire = await getCurrentFuseWire(file);
  const expected = {
    [FuseV1Options.RunAsNode]: 48,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: 48,
    [FuseV1Options.EnableNodeCliInspectArguments]: test ? 49 : 48,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: 49,
    [FuseV1Options.OnlyLoadAppFromAsar]: 49,
    [FuseV1Options.GrantFileProtocolExtraPrivileges]: 48,
  };
  for (const [option, value] of Object.entries(expected)) {
    if (wire[option] !== value) throw new Error('Unexpected Electron fuse: ' + FuseV1Options[option]);
  }
}

export function requirePublisher(thumbprint) {
  if (typeof thumbprint !== 'string' || !/^[0-9a-f]{40}$/i.test(thumbprint)) {
    throw new Error('HYDRAULIC_SIGNER_THUMBPRINT must identify the expected Authenticode publisher');
  }
  return thumbprint.toUpperCase();
}

const checkSignature = `
$file = (ConvertFrom-Json -InputObject ([Console]::In.ReadToEnd())).file
$result = Get-AuthenticodeSignature -LiteralPath $file
if ($result.Status -ne 'Valid' -or $null -eq $result.SignerCertificate) {
  [Console]::WriteLine('Authenticode signature status: ' + $result.Status)
  exit 1
}
[Console]::WriteLine($result.SignerCertificate.Thumbprint)
`;

export async function verifyPublisher(file, expectedThumbprint) {
  const actual = await runWindowsPowerShell(checkSignature, { file: path.resolve(file) });
  if (actual.toUpperCase() !== requirePublisher(expectedThumbprint)) throw new Error('Unexpected Authenticode publisher');
}
