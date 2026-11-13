import { EventEmitter } from 'events';
import type { ChildProcess } from 'child_process';
import type { BrowserWindow } from 'electron';

interface ImportOptions {
  textureInfo: { codedSize: { width: number; height: number }; handle: { ntHandle: Buffer } };
  allReferencesReleased: () => void;
}

const imports: { options: ImportOptions; release: jest.Mock }[] = [];
let send: jest.Mock;

jest.mock(
  'electron',
  () => ({
    sharedTexture: {
      importSharedTexture: (options: ImportOptions) => {
        const imported = { options, release: jest.fn() };
        imports.push(imported);
        return imported;
      },
      sendSharedTexture: (...args: unknown[]) => send(...args)
    },
    BrowserWindow: class {}
  }),
  { virtual: true }
);

import { VideoFrames } from './videoFrames';

const helper = () => {
  const stdout = new EventEmitter();
  const written: string[] = [];
  return { stdout, stdin: { write: (line: string) => written.push(line.trim()) }, written };
};

const window = { isDestroyed: () => false, webContents: { mainFrame: {} } } as unknown as BrowserWindow;
const flush = () => new Promise(resolve => setImmediate(resolve));

describe('VideoFrames', () => {
  beforeEach(() => {
    imports.length = 0;
    send = jest.fn(() => Promise.resolve());
  });

  it('imports a frame from the pool it names, with the handle as eight bytes', async () => {
    const h = helper();
    new VideoFrames(h as unknown as ChildProcess, window);
    h.stdout.emit('data', Buffer.from('pool 1 1280 720 100 200 300\nframe 1 2 1280 720\n'));
    await flush();

    expect(imports).toHaveLength(1);
    const info = imports[0].options.textureInfo;
    expect(info.codedSize).toEqual({ width: 1280, height: 720 });
    expect(info.handle.ntHandle.readBigUInt64LE()).toBe(300n);
    expect(imports[0].release).toHaveBeenCalled();
  });

  it('frees the texture only once every process has let go of it', () => {
    const h = helper();
    new VideoFrames(h as unknown as ChildProcess, window);
    h.stdout.emit('data', Buffer.from('pool 1 64 64 1 2 3\nframe 1 0 64 64\n'));

    expect(h.written).not.toContain('free 1 0');
    imports[0].options.allReferencesReleased();
    imports[0].options.allReferencesReleased();
    expect(h.written.filter(line => line === 'free 1 0')).toHaveLength(1);
  });

  it('reads a line split across two chunks', () => {
    const h = helper();
    new VideoFrames(h as unknown as ChildProcess, window);
    h.stdout.emit('data', Buffer.from('pool 1 64 64 1 2 3\nfra'));
    h.stdout.emit('data', Buffer.from('me 1 1 64 64\n'));
    expect(imports).toHaveLength(1);
  });

  it('retires the previous pool when a new size arrives, and drops its late frames', () => {
    const h = helper();
    new VideoFrames(h as unknown as ChildProcess, window);
    h.stdout.emit('data', Buffer.from('pool 1 64 64 1 2 3\npool 2 128 128 4 5 6\nframe 1 0 64 64\n'));

    expect(h.written).toContain('retire 1');
    expect(imports).toHaveLength(0);
    expect(h.written).toContain('free 1 0');
  });

  it('drops a frame rather than queue a third for a slow page', () => {
    const h = helper();
    send = jest.fn(() => new Promise(() => undefined));
    const frames = new VideoFrames(h as unknown as ChildProcess, window);
    h.stdout.emit('data', Buffer.from('pool 1 64 64 1 2 3\nframe 1 0 64 64\nframe 1 1 64 64\nframe 1 2 64 64\n'));

    expect(imports).toHaveLength(2);
    expect(frames.framesDropped).toBe(1);
    expect(h.written).toContain('free 1 2');
  });

  it('passes other lines on as logs, and asks for sizes in whole device pixels', () => {
    const h = helper();
    const frames = new VideoFrames(h as unknown as ChildProcess, window);
    const logs: string[] = [];
    frames.onLog = line => logs.push(line);
    h.stdout.emit('data', Buffer.from('log stats sent=1\n'));
    frames.resize(1279.6, 720.2);
    frames.resize(4, 4);

    expect(logs).toEqual(['log stats sent=1']);
    expect(h.written).toEqual(['size 1280 720']);
  });
});
