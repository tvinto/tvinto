import { attributesOf, m3uItems, m3uItemsOf, M3uEntry } from './m3uReader';
import { UNGROUPED_CATEGORY_ID, m3uStreamType, playlistOf } from './m3uPlaylist';

const PLAYLIST = [
  '﻿#EXTM3U x-tvg-url="http://guide.example/a.xml.gz,http://guide.example/b.xml" catchup="shift" catchup-days="3"',
  '#EXTINF:-1 tvg-id="HRT1.hr" tvg-name="HRT 1" tvg-logo="http://logo.example/hrt1.png" group-title="Croatia, HD",HRT 1 HD',
  'http://line.example/live/u/p/1.ts',
  '#EXTINF:-1 tvg-id="HRT2.hr" group-title="Croatia, HD" catchup="0",HRT 2',
  '#EXTVLCOPT:http-user-agent=Something',
  'http://line.example/live/u/p/2.ts',
  '#EXTINF:0,Dune (2021)',
  '#EXTGRP:Films',
  'http://line.example/movie/u/p/77.mkv',
  'http://plain.example/stream/radio%20one',
  ''
].join('\r\n');

const entries = (text: string) => m3uItemsOf(text).filter((item): item is M3uEntry => item.kind === 'entry');

describe('reading an M3U', () => {
  it('reads the header, each entry with its attributes, and plain addresses', () => {
    const items = m3uItemsOf(PLAYLIST);
    expect(items[0]).toEqual({
      kind: 'header',
      guideUrls: ['http://guide.example/a.xml.gz', 'http://guide.example/b.xml'],
      attributes: expect.objectContaining({ catchup: 'shift', 'catchup-days': '3' })
    });

    const [hrt1, hrt2, dune, radio] = entries(PLAYLIST);
    expect(hrt1).toEqual(
      expect.objectContaining({
        name: 'HRT 1 HD',
        url: 'http://line.example/live/u/p/1.ts',
        group: 'Croatia, HD',
        duration: -1
      })
    );
    expect(hrt1.attributes['tvg-logo']).toBe('http://logo.example/hrt1.png');
    expect(hrt2.name).toBe('HRT 2');
    expect(dune).toEqual(expect.objectContaining({ name: 'Dune (2021)', group: 'Films', duration: 0 }));
    expect(radio).toEqual(expect.objectContaining({ name: 'radio one', group: '' }));
  });

  it('reads the same from bytes split anywhere, even inside a character', async () => {
    const bytes = new TextEncoder().encode(PLAYLIST.replace('HRT 2', 'HRT 2 Šport'));
    async function* inPieces() {
      for (let at = 0; at < bytes.length; at += 7) {
        yield bytes.slice(at, at + 7);
      }
    }
    const read = [];
    for await (const item of m3uItems(inPieces())) {
      read.push(item);
    }
    expect(read).toEqual(m3uItemsOf(PLAYLIST.replace('HRT 2', 'HRT 2 Šport')));
  });

  it('names an entry with a blank name by its tvg-name, then by its address', () => {
    const [named, unnamed] = entries(
      ['#EXTINF:-1 tvg-name="HRT 3",', 'http://line.example/live/u/p/3.ts', '#EXTINF:-1 tvg-name="",', 'http://line.example/live/u/p/4.ts'].join('\n')
    );
    expect(named.name).toBe('HRT 3');
    expect(unnamed.name).toBe('4.ts');
  });

  it('takes quoted, single-quoted and bare attribute values, names lower-cased', () => {
    expect(attributesOf(` Tvg-ID="a b" tvg-logo='x' catchup-days=7`)).toEqual({
      'tvg-id': 'a b',
      'tvg-logo': 'x',
      'catchup-days': '7'
    });
  });
});

describe('a playlist as libraries', () => {
  it('tells films from channels by the address', () => {
    expect(m3uStreamType('http://x/live/u/p/1.ts')).toBe('live');
    expect(m3uStreamType('http://x/u/p/1')).toBe('live');
    expect(m3uStreamType('http://x/movie/u/p/1.mp4')).toBe('vod');
    expect(m3uStreamType('http://x/series/u/p/9.mkv')).toBe('vod');
    expect(m3uStreamType('http://x/films/dune.MKV?token=1')).toBe('vod');
  });

  it('files entries under their groups, in playlist order, with what the app shows', () => {
    const playlist = playlistOf(m3uItemsOf(PLAYLIST));

    expect(playlist.guideUrls).toHaveLength(2);
    expect(playlist.categories.live.map(c => c.category_name)).toEqual(['Croatia, HD', '']);
    expect(playlist.categories.vod.map(c => c.category_name)).toEqual(['Films']);

    const croatia = playlist.categories.live[0].category_id;
    const [hrt1, hrt2] = playlist.streams.live.get(croatia)!;
    expect(hrt1).toEqual(
      expect.objectContaining({
        name: 'HRT 1 HD',
        stream_icon: 'http://logo.example/hrt1.png',
        epg_channel_id: 'HRT1.hr',
        source_url: 'http://line.example/live/u/p/1.ts',
        category_id: croatia
      })
    );
    expect(playlist.streams.live.get(UNGROUPED_CATEGORY_ID)![0].name).toBe('radio one');

    const [dune] = playlist.streams.vod.get(playlist.categories.vod[0].category_id)!;
    expect(dune).toEqual(expect.objectContaining({ stream_type: 'movie', container_extension: 'mkv' }));
    expect(hrt2.stream_id).not.toBe(hrt1.stream_id);
  });

  it('takes catch-up from the entry or the playlist, and none when an entry turns it off', () => {
    const playlist = playlistOf(m3uItemsOf(PLAYLIST));
    const [hrt1, hrt2] = playlist.streams.live.get(playlist.categories.live[0].category_id)!;

    expect(hrt1).toEqual(expect.objectContaining({ tv_archive: 1, tv_archive_duration: 3, catchup_mode: 'shift' }));
    expect(hrt2.tv_archive).toBe(0);
    expect(playlistOf(m3uItemsOf('#EXTM3U\n#EXTINF:-1,A\nhttp://x/1.ts')).streams.live.get(UNGROUPED_CATEGORY_ID)![0].tv_archive).toBe(0);
  });

  it('keeps an id through a new password in the address, and apart for two of one name', () => {
    const before = playlistOf(m3uItemsOf('#EXTINF:-1 group-title="G",A\nhttp://x/live/old/pw/1.ts\n#EXTINF:-1 group-title="G",A\nhttp://x/live/old/pw/2.ts'));
    const after = playlistOf(m3uItemsOf('#EXTINF:-1 group-title="G",A\nhttp://x/live/new/pw2/1.ts\n#EXTINF:-1 group-title="G",A\nhttp://x/live/new/pw2/2.ts'));

    const ids = (playlist: typeof before) => [...playlist.streams.live.values()].flat().map(s => s.stream_id);
    expect(ids(after)).toEqual(ids(before));
    expect(new Set(ids(before)).size).toBe(2);
  });
});
