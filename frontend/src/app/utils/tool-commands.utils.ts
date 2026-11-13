/**
 * The commands Account, Tools shows for connecting an AI agent through tvinto:
 * from npm, and from the copy the desktop app carries (electron/src/toolCli.ts).
 *
 * Commands and paths are never translated. On Windows they are for
 * PowerShell, the terminal Windows opens: single quotes there take a path
 * literally, `$` and all, and `&` runs a quoted path.
 */

/** Which account tvinto signs in to: this app with no account, or a sync service. */
export type ToolTarget = { local: true } | { local: false; server: string; username: string };

/** Where the desktop app's own tvinto is, as its main process says. */
export interface DesktopToolCli {
  exe: string;
  script: string;
  /** A launcher script with the paths in it, for a terminal; null when it could not be written. */
  launcher: string | null;
  platform: string;
}

export interface ToolCommands {
  signIn: string;
  connect: string;
}

const signInArgs = (target: ToolTarget): string =>
  target.local ? 'sign-in --local' : `sign-in --server ${target.server} --user ${target.username}`;

/** PowerShell and a POSIX shell both take a single-quoted path literally; only the quote itself needs care. */
const quote = (value: string, platform: string): string =>
  platform === 'win32' ? `'${value.replace(/'/g, "''")}'` : `'${value.replace(/'/g, `'\\''`)}'`;

export const npmCommands = (target: ToolTarget): ToolCommands => ({
  signIn: `npx tvinto ${signInArgs(target)}`,
  connect: 'claude mcp add tvinto -- npx -y tvinto mcp'
});

/**
 * The desktop app's tvinto, on the app's own runtime.
 *
 * A person's terminal gets the launcher: the app is a Windows GUI program, and
 * a terminal does not wait for one, but a batch file does. The agent is given
 * the executable, the script and ELECTRON_RUN_AS_NODE directly, and waits on
 * the process it starts.
 */
export const desktopCommands = (cli: DesktopToolCli, target: ToolTarget): ToolCommands => {
  const q = (value: string) => quote(value, cli.platform);
  const windows = cli.platform === 'win32';
  const signIn = cli.launcher
    ? `${windows ? '& ' : ''}${q(cli.launcher)} ${signInArgs(target)}`
    : windows
      ? `$env:ELECTRON_RUN_AS_NODE=1; & ${q(cli.exe)} ${q(cli.script)} ${signInArgs(target)} | Out-Host; $env:ELECTRON_RUN_AS_NODE=$null`
      : `ELECTRON_RUN_AS_NODE=1 ${q(cli.exe)} ${q(cli.script)} ${signInArgs(target)}`;
  return {
    signIn,
    connect: `claude mcp add tvinto --env ELECTRON_RUN_AS_NODE=1 -- ${q(cli.exe)} ${q(cli.script)} mcp`
  };
};

/** What the desktop bridge answered, if it is the shape expected; anything else is no desktop tvinto. */
export const asDesktopToolCli = (value: unknown): DesktopToolCli | null => {
  const candidate = value as Partial<DesktopToolCli> | null;
  return candidate &&
    typeof candidate.exe === 'string' &&
    typeof candidate.script === 'string' &&
    typeof candidate.platform === 'string' &&
    (candidate.launcher === null || typeof candidate.launcher === 'string')
    ? { exe: candidate.exe, script: candidate.script, launcher: candidate.launcher, platform: candidate.platform }
    : null;
};
