const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

const root = path.resolve(__dirname, '..');
const pkg = require(path.join(root, 'package.json'));
const execName = pkg.build?.executableName || pkg.name || 'electron';
const productName = pkg.build?.productName || pkg.productName || execName;

const isWin = process.platform === 'win32';
const isLinux = process.platform === 'linux';
const unpackedDir = `dist/${isWin ? 'win' : 'linux'}-unpacked`;

const candidates = [
  path.join(root, 'node_modules/electron/dist/electron' + (isWin ? '.exe' : '')),
];

// En Windows npm solo expone shims de shell (.cmd/.ps1) en .bin: no son
// ejecutables para spawn, así que ese candidato se omite.
if (!isWin) {
  candidates.push(path.join(root, 'node_modules/.bin/electron'));
}

candidates.push(
  path.join(root, unpackedDir, execName + (isWin ? '.exe' : '')),
  path.join(root, unpackedDir, productName + (isWin ? '.exe' : '')),
  path.join(root, unpackedDir, 'foranly-desktop' + (isWin ? '.exe' : '')),
  path.join(root, unpackedDir, 'closedoor' + (isWin ? '.exe' : '')),
);

let bin = candidates.find((p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
});

if (!bin) {
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && fs.existsSync(resolved)) bin = resolved;
  } catch {
    // without a downloaded Electron binary there is nothing else to try
  }
}

if (!bin) {
  console.error('No Electron binary found. Tried:\n  ' + candidates.join('\n  '));
  console.error(
    `Run "npx electron-builder --${isWin ? 'win' : 'linux'} dir" once, or reinstall electron with its postinstall script enabled.`,
  );
  process.exit(1);
}

const env = { ...process.env };
if (isLinux && !env.DRI_PRIME) env.DRI_PRIME = '1';
if (isLinux && !env.ELECTRON_OZONE_PLATFORM_HINT) env.ELECTRON_OZONE_PLATFORM_HINT = 'auto';
const binDir = path.dirname(bin);
if (!isWin && (binDir.includes('linux-unpacked') || binDir.includes('win-unpacked'))) {
  env.LD_LIBRARY_PATH = binDir + (env.LD_LIBRARY_PATH ? ':' + env.LD_LIBRARY_PATH : '');
}

const child = spawn(bin, ['.', ...process.argv.slice(2)], { stdio: 'inherit', env });
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code || 0);
});
child.on('error', (err) => {
  console.error('Failed to launch Electron:', err.message);
  process.exit(1);
});
