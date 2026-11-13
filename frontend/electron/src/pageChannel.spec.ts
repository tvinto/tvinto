import { EventEmitter } from 'events';
import type { WebContents } from 'electron';

type Handler = (event: { ports: unknown[]; sender: unknown }) => void;
const handlers = new Map<string, Handler>();

jest.mock(
  'electron',
  () => ({
    ipcMain: { on: (channel: string, handler: Handler) => handlers.set(channel, handler) }
  }),
  { virtual: true }
);

import { acceptPageChannels, toPage } from './pageChannel';

type FakeContents = EventEmitter & { isDestroyed: () => boolean; send: jest.Mock };

const contents = (): FakeContents =>
  Object.assign(new EventEmitter(), { isDestroyed: () => false, send: jest.fn() }) as FakeContents;

const port = () => ({ start: jest.fn(), close: jest.fn(), postMessage: jest.fn() });

const asContents = (page: FakeContents) => page as unknown as WebContents;

describe('pageChannel', () => {
  beforeAll(() => acceptPageChannels());

  it('uses plain IPC until the page has handed over a port', () => {
    const page = contents();
    toPage(asContents(page), 'xtream:deep-link', 'tvinto://film/1');
    expect(page.send).toHaveBeenCalledWith('xtream:deep-link', 'tvinto://film/1');
  });

  it('says everything over the port a page hands over, and the newest one after a reload', () => {
    const page = contents();
    const first = port();
    handlers.get('xtream:page-channel')!({ ports: [first], sender: page });
    toPage(asContents(page), 'xtream:player-event', { type: 'progress' });
    expect(first.postMessage).toHaveBeenCalledWith({ channel: 'xtream:player-event', args: [{ type: 'progress' }] });
    expect(page.send).not.toHaveBeenCalled();

    const second = port();
    handlers.get('xtream:page-channel')!({ ports: [second], sender: page });
    expect(first.close).toHaveBeenCalled();
    toPage(asContents(page), 'xtream:video-state', { open: true });
    expect(second.postMessage).toHaveBeenCalledWith({ channel: 'xtream:video-state', args: [{ open: true }] });
  });

  it('says nothing to a page that is gone', () => {
    const page = contents();
    page.isDestroyed = () => true;
    toPage(asContents(page), 'xtream:update-ready', '1.0.0');
    expect(page.send).not.toHaveBeenCalled();
  });
});
