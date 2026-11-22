import { randomBytes } from 'crypto';

/**
 * The address of one player's JSON pipe (mpv's `--input-ipc-server`).
 *
 * One for every player started, never a fixed name. Until 14 November every
 * copy of the app used `\\.\pipe\xtream-mpv`, and Windows lets any number of
 * servers open the same pipe name: with the installed app and a development
 * copy playing at once, a property asked by one was answered by the other's
 * player, and a test film ended by itself. A second copy could pause, seek or
 * close the film in the first.
 *
 * The process id keeps copies apart, and the random part keeps apart two
 * players of one copy (the one closing while the next opens) and a process id
 * Windows has handed out again.
 */
export function playerPipeName(pid: number = process.pid, random: string = randomBytes(8).toString('hex')): string {
  return `\\\\.\\pipe\\tvinto-player-${pid}-${random}`;
}

/**
 * How long a player may take to open its pipe before the app says it never
 * did. mpv.exe opens it with its window, tvinto-player once libmpv is up:
 * both in well under a second here, more on a slow machine's first start.
 */
export const PIPE_OPENS_WITHIN_MS = 15_000;

/**
 * Says once that a player's pipe never opened, rather than going on asking
 * in silence. The app connects to its own player's pipe only, so a pipe that
 * is not there means this player cannot be controlled -- not that another
 * one should be.
 */
export class PipeOpening {
  private readonly since: number;
  private told = false;

  constructor(
    private readonly name: string,
    private readonly say: (line: string) => void,
    private readonly now: () => number = Date.now
  ) {
    this.since = now();
  }

  /** A connection attempt failed; told once the player has had its time. */
  failed(reason: string): void {
    if (!this.told && !this.open && this.now() - this.since >= PIPE_OPENS_WITHIN_MS) {
      this.told = true;
      this.say(`app: the player's pipe ${this.name} has not opened in ${PIPE_OPENS_WITHIN_MS / 1000} s (${reason}); it cannot be controlled`);
    }
  }

  /**
   * Connected. Later failures are the player closing, not a pipe that never
   * opened. Worth a line when it was said it had not.
   */
  opened(): void {
    if (this.told && !this.open) {
      this.say(`app: the player's pipe ${this.name} opened late`);
    }
    this.open = true;
  }

  private open = false;
}
