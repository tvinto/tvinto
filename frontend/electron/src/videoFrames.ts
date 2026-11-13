import type { ChildProcess } from 'child_process';
import { BrowserWindow, sharedTexture } from 'electron';

/**
 * Frames from tvinto-player.exe into the app's window.
 *
 * The helper (native/tvinto-player.cpp) is mpv drawing into three D3D11
 * textures it shares with this process. Each finished frame arrives as a line
 * on its stdout; it is imported here (Electron's sharedTexture), handed to the
 * page, and the helper is told the texture is free once every process has let
 * go of it. Nothing is copied on the CPU: the page draws the GPU texture.
 *
 * The size the helper draws at follows the page's video element (`resize`),
 * in device pixels, so mpv scales the picture and draws its subtitles at the
 * size they are seen.
 */

interface Pool {
  width: number;
  height: number;
  handles: Buffer[];
}

/** One helper's frames. */
export class VideoFrames {
  private readonly pools = new Map<number, Pool>();
  private buffer = '';
  private latest = 0;
  /** Frames on their way to the page, so a slow page drops rather than queues. */
  private inFlight = 0;
  framesShown = 0;
  framesDropped = 0;

  /** Lines the helper said that are not frames: `log ...`. */
  onLog: ((line: string) => void) | null = null;

  constructor(
    private readonly helper: ChildProcess,
    private readonly window: BrowserWindow
  ) {
    helper.stdout?.on('data', (chunk: Buffer) => this.read(chunk.toString()));
  }

  /** Draw at this size from now on (device pixels). */
  resize(width: number, height: number): void {
    const w = Math.round(width);
    const h = Math.round(height);
    if (w >= 16 && h >= 16) {
      this.tell(`size ${w} ${h}`);
    }
  }

  private tell(line: string): void {
    try {
      this.helper.stdin?.write(`${line}\n`);
    } catch {
      // The helper has gone; its exit is handled by the player.
    }
  }

  private read(text: string): void {
    this.buffer += text;
    let end: number;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).trim();
      this.buffer = this.buffer.slice(end + 1);
      const [kind, ...rest] = line.split(' ');
      if (kind === 'pool') {
        this.pool(rest);
      } else if (kind === 'frame') {
        this.frame(Number(rest[0]), Number(rest[1]));
      } else if (line) {
        this.onLog?.(line);
      }
    }
  }

  private pool([generation, width, height, ...handles]: string[]): void {
    const at = Number(generation);
    this.pools.set(at, {
      width: Number(width),
      height: Number(height),
      handles: handles.map(handle => {
        const bytes = Buffer.alloc(8);
        bytes.writeBigUInt64LE(BigInt(handle));
        return bytes;
      })
    });
    // Older pools take no more imports; their handles may go once their
    // frames are back (the helper waits for both).
    if (this.latest) {
      this.pools.delete(this.latest);
      this.tell(`retire ${this.latest}`);
    }
    this.latest = at;
  }

  private frame(generation: number, index: number): void {
    const pool = this.pools.get(generation);
    let freed = false;
    const free = () => {
      if (!freed) {
        freed = true;
        this.tell(`free ${generation} ${index}`);
      }
    };
    if (!pool || this.window.isDestroyed() || this.inFlight >= 2) {
      // Nowhere to show it, or the page has two already: the next one will do.
      this.framesDropped++;
      free();
      return;
    }
    try {
      const imported = sharedTexture.importSharedTexture({
        textureInfo: {
          pixelFormat: 'bgra',
          codedSize: { width: pool.width, height: pool.height },
          handle: { ntHandle: pool.handles[index] }
        },
        allReferencesReleased: free
      });
      this.inFlight++;
      sharedTexture
        .sendSharedTexture({ frame: this.window.webContents.mainFrame, importedSharedTexture: imported })
        .then(
          () => this.framesShown++,
          () => this.framesDropped++
        )
        .finally(() => {
          this.inFlight--;
          imported.release();
        });
    } catch {
      this.framesDropped++;
      free();
    }
  }
}
