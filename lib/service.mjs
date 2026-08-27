import { spawn } from 'node:child_process';
import { mkdir, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const SERVICE_LABEL = 'com.openbot.daemon';
const SERVICE_NAME = 'openbot.service';

function xmlEscape(value) {
  return String(value).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

function systemdQuote(value) {
  return `"${String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r')}"`;
}

function nodePath(env) {
  return env.OPENBOT_NODE_PATH || process.execPath;
}

function commonEnvironment(config) {
  return { OPENBOT_DATA_DIR: config.dataDir, OPENBOT_PID_FILE: config.pidFile, HOST: config.host, PORT: String(config.port) };
}

function macInfo(config, env) {
  const home = env.HOME || process.env.HOME || process.cwd();
  const path = join(home, 'Library', 'LaunchAgents', `${SERVICE_LABEL}.plist`);
  const variables = Object.entries(commonEnvironment(config)).map(([key, value]) => `    <key>${key}</key><string>${xmlEscape(value)}</string>`).join('\n');
  const content = `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict>\n<key>Label</key><string>${SERVICE_LABEL}</string>\n<key>ProgramArguments</key><array><string>${xmlEscape(nodePath(env))}</string><string>${xmlEscape(join(config.root, 'server.mjs'))}</string></array>\n<key>WorkingDirectory</key><string>${xmlEscape(config.root)}</string>\n<key>RunAtLoad</key><true/>\n<key>KeepAlive</key><true/>\n<key>EnvironmentVariables</key><dict>\n${variables}\n</dict>\n</dict></plist>\n`;
  const uid = typeof process.getuid === 'function' ? process.getuid() : '$UID';
  return {
    supported: true,
    platform: 'darwin',
    name: SERVICE_LABEL,
    path,
    content,
    installCommand: [
      { command: 'launchctl', args: ['bootout', `gui/${uid}`, path], ignoreFailure: true },
      { command: 'launchctl', args: ['bootstrap', `gui/${uid}`, path] }
    ],
    uninstallCommand: [{ command: 'launchctl', args: ['bootout', `gui/${uid}`, path], ignoreFailure: true }]
  };
}

function linuxInfo(config, env) {
  const home = env.HOME || process.env.HOME || process.cwd();
  const configHome = env.XDG_CONFIG_HOME || join(home, '.config');
  const path = join(configHome, 'systemd', 'user', SERVICE_NAME);
  const variables = Object.entries(commonEnvironment(config)).map(([key, value]) => `Environment=${key}=${systemdQuote(value)}`).join('\n');
  const content = `[Unit]\nDescription=OpenBot local daemon\nAfter=default.target\n\n[Service]\nType=simple\nWorkingDirectory=${systemdQuote(config.root)}\nExecStart=${systemdQuote(nodePath(env))} ${systemdQuote(join(config.root, 'server.mjs'))}\n${variables}\nRestart=on-failure\nRestartSec=2\n\n[Install]\nWantedBy=default.target\n`;
  return {
    supported: true,
    platform: 'linux',
    name: SERVICE_NAME,
    path,
    content,
    installCommand: [
      { command: 'systemctl', args: ['--user', 'daemon-reload'] },
      { command: 'systemctl', args: ['--user', 'enable', '--now', SERVICE_NAME] }
    ],
    uninstallCommand: [
      { command: 'systemctl', args: ['--user', 'disable', '--now', SERVICE_NAME], ignoreFailure: true },
      { command: 'systemctl', args: ['--user', 'daemon-reload'], ignoreFailure: true }
    ]
  };
}

export function serviceInfo(config, env = process.env, platform = process.platform) {
  if (platform === 'darwin') return macInfo(config, env);
  if (platform === 'linux') return linuxInfo(config, env);
  return { supported: false, platform, reason: 'User service installation is currently supported on macOS and Linux.' };
}

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'ignore' });
    child.once('error', reject);
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`${command} exited with status ${code}`)));
  });
}

async function runCommands(commands) {
  for (const item of commands) {
    try { await runCommand(item.command, item.args); }
    catch (error) { if (!item.ignoreFailure) throw error; }
  }
}

export async function installService(config, env = process.env, platform = process.platform, options = {}) {
  const info = serviceInfo(config, env, platform);
  if (!info.supported) throw new Error(info.reason);
  if (options.dryRun) return { ...info, dryRun: true, installed: false };
  await mkdir(dirname(info.path), { recursive: true });
  await writeFile(info.path, info.content, { mode: 0o600 });
  try { await runCommands(info.installCommand); }
  catch (error) {
    await unlink(info.path).catch(() => {});
    throw new Error(`Service installation failed: ${error.message}`);
  }
  return { ...info, installed: true, dryRun: false };
}

export async function uninstallService(config, env = process.env, platform = process.platform, options = {}) {
  const info = serviceInfo(config, env, platform);
  if (!info.supported) throw new Error(info.reason);
  if (options.dryRun) return { ...info, dryRun: true, removed: false };
  await runCommands(info.uninstallCommand);
  await unlink(info.path).catch((error) => { if (error.code !== 'ENOENT') throw error; });
  return { ...info, removed: true, dryRun: false };
}
