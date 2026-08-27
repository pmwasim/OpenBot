import { spawn } from 'node:child_process';
import { daemonUrl, startDaemon } from './daemon.mjs';

export function desktopOpenCommand(platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', ''] };
  return { command: 'xdg-open', args: [] };
}

export async function launchDesktop(config, env = process.env) {
  const daemon = await startDaemon(config, env);
  const url = daemon.url || daemonUrl(config);
  if (env.OPENBOT_DESKTOP_NO_OPEN === '1') return { ...daemon, url, opened: false };

  const opener = desktopOpenCommand();
  const child = spawn(opener.command, [...opener.args, url], { detached: true, stdio: 'ignore' });
  child.once('error', () => {});
  child.unref();
  return { ...daemon, url, opened: true };
}
