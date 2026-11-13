import path from 'path';

jest.mock('electron', () => ({ app: {}, ipcMain: {} }), { virtual: true });

import { launcherName, launcherText, scriptPath } from './toolCli';

describe('tvinto inside the desktop app', () => {
  it('is in the resources of an installed app', () => {
    expect(scriptPath(true, path.join('C:', 'Tvinto', 'resources'), 'ignored')).toBe(
      path.join('C:', 'Tvinto', 'resources', 'cli', 'tvinto.js')
    );
  });

  it('is the repository build in a copy run from source', () => {
    expect(scriptPath(false, 'ignored', path.join('repo', 'frontend', 'electron'))).toBe(path.join('repo', 'cli', 'dist', 'tvinto.js'));
  });

  it('starts from a batch file on Windows, which waits for the app', () => {
    const text = launcherText('C:\\Apps\\Tvinto\\Tvinto.exe', 'C:\\Apps\\Tvinto\\resources\\cli\\tvinto.js', 'win32');
    expect(text.split('\r\n')).toEqual([
      '@echo off',
      'setlocal',
      'set ELECTRON_RUN_AS_NODE=1',
      '"C:\\Apps\\Tvinto\\Tvinto.exe" "C:\\Apps\\Tvinto\\resources\\cli\\tvinto.js" %*',
      ''
    ]);
    expect(launcherName('win32')).toBe('tvinto.cmd');
  });

  it('keeps a percent sign in a path from being read as a variable', () => {
    expect(launcherText('C:\\100%\\Tvinto.exe', 'C:\\x.js', 'win32')).toContain('"C:\\100%%\\Tvinto.exe"');
  });

  it('quotes paths for a shell elsewhere', () => {
    expect(launcherText("/opt/it's/tvinto", '/opt/x.js', 'linux')).toContain(
      `ELECTRON_RUN_AS_NODE=1 exec '/opt/it'\\''s/tvinto' '/opt/x.js' "$@"`
    );
    expect(launcherName('linux')).toBe('tvinto');
  });
});
