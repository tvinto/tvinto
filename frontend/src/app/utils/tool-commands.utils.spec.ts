import { asDesktopToolCli, desktopCommands, npmCommands } from './tool-commands.utils';

const windows = {
  exe: 'C:\\Users\\Ana Horvat\\AppData\\Local\\Programs\\Tvinto\\Tvinto.exe',
  script: 'C:\\Users\\Ana Horvat\\AppData\\Local\\Programs\\Tvinto\\resources\\cli\\tvinto.js',
  launcher: 'C:\\Users\\Ana Horvat\\AppData\\Roaming\\Tvinto\\cli\\tvinto.cmd',
  platform: 'win32'
};

describe('the commands for connecting an AI agent', () => {
  it('come from npm, signed in to this app with no account', () => {
    expect(npmCommands({ local: true })).toEqual({
      signIn: 'npx tvinto sign-in --local',
      connect: 'claude mcp add tvinto -- npx -y tvinto mcp'
    });
  });

  it('name the sync service and the account when there is one', () => {
    expect(npmCommands({ local: false, server: 'sync.example.org', username: 'ana' }).signIn).toBe(
      'npx tvinto sign-in --server sync.example.org --user ana'
    );
  });

  it('run the desktop app’s copy through its launcher in PowerShell', () => {
    expect(desktopCommands(windows, { local: true }).signIn).toBe(
      "& 'C:\\Users\\Ana Horvat\\AppData\\Roaming\\Tvinto\\cli\\tvinto.cmd' sign-in --local"
    );
  });

  it('give the agent the app’s executable as Node, with no shell in between', () => {
    expect(desktopCommands(windows, { local: true }).connect).toBe(
      "claude mcp add tvinto --env ELECTRON_RUN_AS_NODE=1 -- 'C:\\Users\\Ana Horvat\\AppData\\Local\\Programs\\Tvinto\\Tvinto.exe' " +
        "'C:\\Users\\Ana Horvat\\AppData\\Local\\Programs\\Tvinto\\resources\\cli\\tvinto.js' mcp"
    );
  });

  it('take a quote in a path literally', () => {
    expect(desktopCommands({ ...windows, launcher: "C:\\O'Brien\\tvinto.cmd" }, { local: true }).signIn).toBe(
      "& 'C:\\O''Brien\\tvinto.cmd' sign-in --local"
    );
    expect(desktopCommands({ ...windows, launcher: "/home/o'brien/tvinto", platform: 'linux' }, { local: true }).signIn).toBe(
      "'/home/o'\\''brien/tvinto' sign-in --local"
    );
  });

  it('still work when the launcher could not be written', () => {
    expect(desktopCommands({ ...windows, launcher: null }, { local: true }).signIn).toBe(
      "$env:ELECTRON_RUN_AS_NODE=1; & 'C:\\Users\\Ana Horvat\\AppData\\Local\\Programs\\Tvinto\\Tvinto.exe' " +
        "'C:\\Users\\Ana Horvat\\AppData\\Local\\Programs\\Tvinto\\resources\\cli\\tvinto.js' sign-in --local | Out-Host; $env:ELECTRON_RUN_AS_NODE=$null"
    );
  });

  it('come only from a bridge that answers in the expected shape', () => {
    expect(asDesktopToolCli(windows)).toEqual(windows);
    expect(asDesktopToolCli(null)).toBeNull();
    expect(asDesktopToolCli({ exe: 1 })).toBeNull();
    expect(asDesktopToolCli({ ...windows, launcher: undefined })).toBeNull();
  });
});
