import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// Refresh only this process tree. Do not modify machine PATH or shell policy.
const root = fileURLToPath(new URL('../', import.meta.url));
const env = { ...process.env };
const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH';
const cargoBin = path.join(homedir(), '.cargo', 'bin');
env[pathKey] = `${cargoBin}${path.delimiter}${env[pathKey] ?? ''}`;

if (process.platform === 'win32' && !env.VCINSTALLDIR) {
  const vswhere = path.join(env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)', 'Microsoft Visual Studio', 'Installer', 'vswhere.exe');
  if (existsSync(vswhere)) {
    const found = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8', env });
    const installPath = found.stdout?.trim();
    if (found.status === 0 && installPath) {
      const devCommand = path.join(installPath, 'Common7', 'Tools', 'VsDevCmd.bat');
      const detected = spawnSync(env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${devCommand}" -no_logo -arch=x64 -host_arch=x64 >nul && set"`], { encoding: 'utf8', env, windowsVerbatimArguments: true });
      if (detected.status !== 0) {
        process.stderr.write(detected.stderr || 'Could not initialize the Visual C++ build environment.\n');
        process.exit(detected.status ?? 1);
      }
      for (const line of detected.stdout.split(/\r?\n/)) {
        const separator = line.indexOf('=');
        if (separator > 0) env[line.slice(0, separator)] = line.slice(separator + 1);
      }
    }
  }
}

const cli = path.join(root, 'node_modules', '@tauri-apps', 'cli', 'tauri.js');
if (!existsSync(cli)) {
  process.stderr.write('Tauri CLI is missing. Run npm install first.\n');
  process.exit(1);
}
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { cwd: root, env, stdio: 'inherit' });
if (result.error) process.stderr.write(`${result.error.message}\n`);
process.exit(result.status ?? 1);
