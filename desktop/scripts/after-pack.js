const fs = require('node:fs');
const path = require('node:path');

module.exports = async function afterPack(context) {
  const platform = context.electronPlatformName || context.packager?.platform?.name;
  if (platform !== 'linux') return;

  const executableName = context.packager?.appInfo?.productFilename || 'Closedoor';
  const executablePath = path.join(context.appOutDir, executableName);
  const binaryPath = `${executablePath}.bin`;

  if (!fs.existsSync(executablePath)) return;
  if (fs.existsSync(binaryPath)) return;

  fs.renameSync(executablePath, binaryPath);

  const script = [
    '#!/bin/sh',
    'if [ -z "${DRI_PRIME:-}" ]; then',
    '  DRI_PRIME=1',
    '  export DRI_PRIME',
    'fi',
    'if [ -z "${ELECTRON_OZONE_PLATFORM_HINT:-}" ]; then',
    '  ELECTRON_OZONE_PLATFORM_HINT=auto',
    '  export ELECTRON_OZONE_PLATFORM_HINT',
    'fi',
    `exec "$(dirname "$0")/${executableName}.bin" "$@"`,
    '',
  ].join('\n');

  fs.writeFileSync(executablePath, script, { mode: 0o755 });
};
