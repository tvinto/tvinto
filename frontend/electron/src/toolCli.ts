import { app, ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { fromAppPage } from './appPage';

/**
 * tvinto, the command-line tool and MCP server, carried inside the desktop app
 * so that nobody needs Node or the source to connect an AI agent.
 *
 * electron-builder copies cli/dist/tvinto.js and its one native dependency
 * into `resources/cli` (electron-builder.config.js). It runs on the app's own
 * runtime: the app's executable with `ELECTRON_RUN_AS_NODE=1` is plain Node.
 *
 * Two ways to start it, because a terminal and an agent need different things:
 *
 * - A person types into a terminal, so they get a launcher script, written
 *   here into the app's data folder with the paths filled in. The executable
 *   is a Windows GUI program, and a terminal does not wait for one -- the
 *   prompt would come back while tvinto was still asking for a code. A batch
 *   file does wait, which is why VS Code's `code` command is one too.
 * - An agent starts a program itself (`claude mcp add ... --env`), so it is
 *   given the executable, the script and the variable directly: no shell in
 *   between, and nothing for it to wait on but the process it started.
 */

export interface ToolCli {
  /** The app's own executable: Node, with ELECTRON_RUN_AS_NODE=1. */
  exe: string;
  /** tvinto.js. */
  script: string;
  /** The launcher for a terminal, or null when it could not be written. */
  launcher: string | null;
  platform: NodeJS.Platform;
}

/**
 * Where tvinto.js is: in the installed app's resources, or -- run from
 * source -- the build in the repository's cli folder.
 */
export const scriptPath = (packaged: boolean, resourcesPath: string, appPath: string): string =>
  packaged ? path.join(resourcesPath, 'cli', 'tvinto.js') : path.join(appPath, '..', '..', 'cli', 'dist', 'tvinto.js');

/**
 * The launcher's text. In a batch file `%` starts a variable, so one in a path
 * is doubled; the paths are the app's own, quoted, never typed by anyone.
 */
export const launcherText = (exe: string, script: string, platform: NodeJS.Platform): string => {
  if (platform === 'win32') {
    const batch = (value: string) => value.replace(/%/g, '%%');
    return ['@echo off', 'setlocal', 'set ELECTRON_RUN_AS_NODE=1', `"${batch(exe)}" "${batch(script)}" %*`, ''].join('\r\n');
  }
  const sh = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
  return ['#!/bin/sh', `ELECTRON_RUN_AS_NODE=1 exec ${sh(exe)} ${sh(script)} "$@"`, ''].join('\n');
};

export const launcherName = (platform: NodeJS.Platform): string => (platform === 'win32' ? 'tvinto.cmd' : 'tvinto');

/** Where tvinto is in this copy of the app, or null when this copy has none. */
export function findToolCli(): ToolCli | null {
  const script = scriptPath(app.isPackaged, process.resourcesPath, app.getAppPath());
  if (!fs.existsSync(script)) {
    return null;
  }
  const exe = process.execPath;
  const platform = process.platform;
  const launcher = path.join(app.getPath('userData'), 'cli', launcherName(platform));
  try {
    const text = launcherText(exe, script, platform);
    // Written again when it differs: an update can move the app.
    if (!fs.existsSync(launcher) || fs.readFileSync(launcher, 'utf8') !== text) {
      fs.mkdirSync(path.dirname(launcher), { recursive: true });
      fs.writeFileSync(launcher, text, { mode: 0o755 });
    }
    return { exe, script, launcher, platform };
  } catch (error) {
    console.info('tvinto launcher not written:', (error as Error).message);
    return { exe, script, launcher: null, platform };
  }
}

export const registerToolCli = (): void => {
  ipcMain.handle('xtream:tool-cli', event => (fromAppPage(event) ? findToolCli() : null));
};
