import { spawn } from 'child_process';
import os from 'os';
import { run } from './cli';
import { Runner } from './server';
import { serve } from './mcp';
import { Terminal, processTerminal } from './prompt';
import { KeyringStore } from './store';

/** `tvinto`, as a person runs it: the real network, credential store and terminal. */
const shared = {
  fetch: (url: string, init?: RequestInit) => fetch(url, init),
  store: new KeyringStore(),
  hostname: os.hostname(),
  /**
   * Opens the desktop app on a sign-in request, through the system's handler
   * for tvinto:// links. Never a shell: the link goes as one argument.
   */
  openLink: (url: string) => {
    const [command, args] =
      process.platform === 'win32' ? ['explorer.exe', [url]] : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]];
    try {
      spawn(command as string, args as string[], { detached: true, stdio: 'ignore' }).on('error', () => undefined).unref();
    } catch {
      // No app to open is fine: the request also waits on Account, Tools.
    }
  }
};

/**
 * The MCP server's terminal is never a person's: stdin carries the protocol.
 * So nothing that needs a PIN or a typed secret can run through it.
 */
const noPerson: Terminal = {
  isTTY: false,
  ask: () => Promise.reject(new Error('No person at this terminal')),
  askHidden: () => Promise.reject(new Error('No person at this terminal'))
};

/**
 * Runs wrangler for `tvinto server init` with the person at the terminal: its
 * questions and its browser sign-in are theirs. What it prints is shown and
 * kept, for the address a deploy ends with. Given `input`, that is its stdin
 * instead -- the secret, which so never appears on screen. On Windows npx is
 * a .cmd, which Node starts only through a shell; the arguments are tvinto's
 * own, never typed by anyone.
 */
const runner: Runner = (command, args, { cwd, input }) =>
  new Promise(resolve => {
    const stdio: ['inherit' | 'pipe', 'pipe', 'inherit'] = [input === undefined ? 'inherit' : 'pipe', 'pipe', 'inherit'];
    // One line through the shell on Windows, as Node wants there; plain
    // words only, which these always are.
    const child =
      process.platform === 'win32'
        ? spawn([command, ...args].join(' '), { cwd, shell: true, stdio })
        : spawn(command, args, { cwd, stdio });
    let output = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString();
      process.stdout.write(chunk);
    });
    if (input !== undefined) {
      child.stdin?.end(input);
    }
    child.on('error', () => resolve({ code: 1, output }));
    child.on('close', code => resolve({ code: code ?? 1, output }));
  });

const argv = process.argv.slice(2);

if (argv[0] === 'mcp' && argv.length === 1) {
  void serve(process.stdin, process.stdout, { ...shared, terminal: noPerson });
} else {
  void run(argv, { ...shared, run: runner, terminal: processTerminal(), write: text => process.stdout.write(text) }).then(code => {
    process.exitCode = code;
  });
}
