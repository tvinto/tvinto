import { EventEmitter } from 'events';
import type { WebContents } from 'electron';

type FakeContents = EventEmitter & { isDestroyed: () => boolean; send: jest.Mock; postMessage: jest.Mock };

const posted: unknown[] = [];

jest.mock(
  'electron',
  () => ({
    MessageChannelMain: class {
      port1 = { start: jest.fn(), close: jest.fn(), postMessage: (message: unknown) => posted.push(message) };
      port2 = {};
    }
  }),
  { virtual: true }
);

import { openPageChannel, toPage } from './pageChannel';

const contents = () => {
  const emitter = Object.assign(new EventEmitter(), { isDestroyed: () => false, send: jest.fn(), postMessage: jest.fn() }) as FakeContents;
  return emitter;
};

describe('pageChannel', () => {
  beforeEach(() => (posted.length = 0));

  it('uses plain IPC until the page has been handed a port', () => {
    const page = contents();
    openPageChannel(page as unknown as WebContents);
    toPage(page as unknown as WebContents, 'xtream:deep-link', 'tvinto://film/1');
    expect(page.send).toHaveBeenCalledWith('xtream:deep-link', 'tvinto://film/1');
    expect(posted).toEqual([]);
  });

  it('hands a port at every load and says everything over it after', () => {
    const page = contents();
    openPageChannel(page as unknown as WebContents);
    page.emit('did-finish-load');
    expect(page.postMessage).toHaveBeenCalledWith('xtream:page-channel', null, [expect.anything()]);

    toPage(page as unknown as WebContents, 'xtream:player-event', { type: 'progress' });
    expect(posted).toEqual([{ channel: 'xtream:player-event', args: [{ type: 'progress' }] }]);
    expect(page.send).not.toHaveBeenCalled();

    page.emit('did-finish-load');
    expect(page.postMessage).toHaveBeenCalledTimes(2);
  });

  it('says nothing to a page that is gone', () => {
    const page = contents();
    page.isDestroyed = () => true;
    toPage(page as unknown as WebContents, 'xtream:update-ready', '1.0.0');
    expect(page.send).not.toHaveBeenCalled();
  });
});
