import { TestBed } from '@angular/core/testing';
import { HttpClient } from '@angular/common/http';
import { of } from 'rxjs';
import { OpenSubtitlesError, SubtitleResult } from '@shared/opensubtitles/client';
import { filmIdentity } from '@shared/opensubtitles/identify';
import { API_URL } from './api-url';
import { OpenSubtitlesService } from './opensubtitles.service';
import { PlatformService } from './platform.service';
import { SubtitleLibraryService } from './subtitle-library.service';

/**
 * Adding a subtitle: search (free), download (spends one of the day's
 * allowance), fetch the file outside the page, and keep it on the account.
 */

const IDENTITY = filmIdentity({ info: { tmdb_id: '24188' } }, { title: 'Ne diraj mi mamu', year: 2004 });

const RESULT: SubtitleResult = {
  subtitleId: '9000',
  fileId: 7001,
  fileName: 'Ne.diraj.mi.mamu.srt',
  language: 'hr',
  release: 'Ne.diraj.mi.mamu.2004.1080p.WEB-DL.x264',
  downloads: 4812,
  hearingImpaired: false,
  hd: true,
  fps: 23.976,
  rating: 9.4,
  votes: 5,
  fromTrusted: true,
  aiTranslated: false,
  machineTranslated: false,
  uploadedAt: '2024-01-12T10:00:00Z',
  uploader: 'kiki',
  uploaderRank: 'trusted',
  title: 'Ne diraj mi mamu',
  year: 2004,
  season: null,
  episode: null
};

const SRT = '1\n00:00:01,000 --> 00:00:03,000\nDobar dan.\n';

describe('SubtitleLibraryService', () => {
  let http: { get: jest.Mock; post: jest.Mock; delete: jest.Mock };
  let client: { search: jest.Mock; download: jest.Mock };
  let refreshedAllowance: number;
  let fetched: string[];

  const build = (platform = 'android', keepRealFetch = false) => {
    http = {
      get: jest.fn(() => of({ success: true, data: [] })),
      post: jest.fn(() => of({ success: true, data: { id: 'sub-1' } })),
      delete: jest.fn(() => of({ success: true, data: null }))
    };
    client = {
      search: jest.fn().mockResolvedValue({ results: [RESULT], page: 1, totalPages: 1, totalCount: 1 }),
      download: jest
        .fn()
        .mockResolvedValue({ link: 'https://www.opensubtitles.com/download/abc/subfile/x.srt', fileName: 'x.srt', remaining: 13, resetTimeUtc: null })
    };
    refreshedAllowance = 0;
    fetched = [];

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        { provide: HttpClient, useValue: http },
        { provide: API_URL, useValue: 'https://sync.example/api' },
        { provide: PlatformService, useValue: { platform } },
        {
          provide: OpenSubtitlesService,
          useValue: {
            userAgent: 'Xtream v1.0.33',
            withSession: (work: (client: unknown, token: string) => Promise<unknown>) => work(client, 'token-1'),
            refreshAllowance: async () => void (refreshedAllowance += 1),
            refreshSavedCount: async () => undefined
          }
        }
      ]
    });

    const library = TestBed.inject(SubtitleLibraryService);
    if (!keepRealFetch) {
      library.fetchFile = async link => {
        fetched.push(link);
        return SRT;
      };
    }
    return library;
  };

  it('searches by the id, with a signed-in token, and spends nothing', async () => {
    const library = build();

    const found = await library.search(IDENTITY, ['hr']);

    expect(client.search).toHaveBeenCalledWith({ tmdbId: 24188, languages: ['hr'], page: undefined }, 'token-1');
    expect(client.download).not.toHaveBeenCalled();
    expect(found.results[0].fileId).toBe(7001);
  });

  it('downloads, converts an SRT to WebVTT and keeps it on the account', async () => {
    const library = build();

    const saved = await library.add(IDENTITY, { type: 'vod', itemId: '4512', name: 'Ne diraj mi mamu' }, RESULT);

    expect(client.download).toHaveBeenCalledWith(7001, 'token-1');
    expect(fetched).toEqual(['https://www.opensubtitles.com/download/abc/subfile/x.srt']);

    const [url, body] = http.post.mock.calls[0];
    expect(url).toBe('https://sync.example/api/subtitles');
    expect(body).toMatchObject({ type: 'vod', itemId: '4512', language: 'hr', fileId: 7001, hearingImpaired: false });
    expect(body.text).toBe('WEBVTT\n\n00:00:01.000 --> 00:00:03.000\nDobar dan.\n');
    expect(saved).toMatchObject({ id: 'sub-1' });

    // The allowance is spent at the download, and shown straight away.
    expect(library.lastRemaining()).toBe(13);
    expect(refreshedAllowance).toBe(1);
  });

  it('keeps an episode with its show, season and episode', async () => {
    const library = build();

    await library.add(IDENTITY, { type: 'series', itemId: '90811', seriesId: '14178', season: 3, episodeNum: 2, name: 'Friends' }, RESULT);

    expect(http.post.mock.calls[0][1]).toMatchObject({ type: 'series', itemId: '90811', seriesId: '14178', season: 3, episodeNum: 2 });
  });

  it('saves nothing when what came back is not subtitles', async () => {
    const library = build();
    library.fetchFile = async () => '<html>Error 503</html>';

    await expect(library.add(IDENTITY, { type: 'vod', itemId: '4512' }, RESULT)).rejects.toThrow('not a subtitle');
    expect(http.post).not.toHaveBeenCalled();
  });

  it('passes an allowance failure on, having saved nothing', async () => {
    const library = build();
    client.download.mockRejectedValue(new OpenSubtitlesError('allowance-used', 'used up', 406, '2026-09-16T00:00:00.000Z'));

    await expect(library.add(IDENTITY, { type: 'vod', itemId: '4512' }, RESULT)).rejects.toMatchObject({ problem: 'allowance-used' });
    expect(http.post).not.toHaveBeenCalled();
  });

  it('lists and removes what the account keeps for one item', async () => {
    const library = build();

    await library.saved('vod', '4512');
    expect(http.get).toHaveBeenCalledWith('https://sync.example/api/subtitles', { params: { type: 'vod', itemId: '4512' } });

    await library.remove('sub-1');
    expect(http.delete).toHaveBeenCalledWith('https://sync.example/api/subtitles/sub-1');
  });

  it('saves an offset against the subtitle, for every device', async () => {
    const library = build();
    http.post.mockReturnValue(of({ success: true, data: { id: 'sub-1', offsetMs: 1500 } }));

    const updated = await library.setOffset('sub-1', 1500);

    expect(http.post).toHaveBeenCalledWith('https://sync.example/api/subtitles/sub-1', { offsetMs: 1500 });
    expect(updated).toMatchObject({ offsetMs: 1500 });
  });

  it('says plainly that a browser cannot fetch the file', async () => {
    const library = build('browser', true);

    await expect(library.fetchFile('https://www.opensubtitles.com/download/x')).rejects.toThrow('phone, television or desktop');
  });

  it('asks an older desktop app to update rather than failing obscurely', async () => {
    const library = build('electron', true);

    await expect(library.fetchFile('https://www.opensubtitles.com/download/x')).rejects.toThrow('Update it first');
  });
});
