import {
  XtreamError,
  buildGuideUrl,
  buildPlaybackUrl,
  categoriesAction,
  isAuthenticated,
  isProviderUnreachable,
  normaliseCategories,
  normaliseStreams,
  resolveApiUrl,
  streamsAction,
  toList
} from './protocol';

describe('action names', () => {
  it('names the category call for each type', () => {
    expect(categoriesAction('live')).toBe('get_live_categories');
    expect(categoriesAction('vod')).toBe('get_vod_categories');
    expect(categoriesAction('series')).toBe('get_series_categories');
  });

  it('lists series containers rather than streams', () => {
    expect(streamsAction('live')).toBe('get_live_streams');
    expect(streamsAction('vod')).toBe('get_vod_streams');
    expect(streamsAction('series')).toBe('get_series');
  });

  it('refuses a type it does not know', () => {
    expect(() => categoriesAction('audiobook' as never)).toThrow(XtreamError);
    expect(() => streamsAction('audiobook' as never)).toThrow(XtreamError);
  });
});

describe('resolveApiUrl', () => {
  it('appends the API path to a bare host', () => {
    expect(resolveApiUrl('http://example.com')).toBe('http://example.com/player_api.php');
  });

  it('keeps a port', () => {
    expect(resolveApiUrl('http://example.com:8080')).toBe('http://example.com:8080/player_api.php');
  });

  it('leaves a URL that already names the endpoint', () => {
    expect(resolveApiUrl('http://example.com/player_api.php')).toBe(
      'http://example.com/player_api.php'
    );
  });

  it('tolerates trailing slashes rather than doubling them', () => {
    expect(resolveApiUrl('http://example.com///')).toBe('http://example.com/player_api.php');
  });

  it('trims what a person pasted', () => {
    expect(resolveApiUrl('  http://example.com  ')).toBe('http://example.com/player_api.php');
  });

  it('refuses nothing at all, with a reason', () => {
    expect(() => resolveApiUrl('')).toThrow('No Xtream server URL provided');
    expect(() => resolveApiUrl(null)).toThrow('No Xtream server URL provided');
    expect(() => resolveApiUrl(undefined)).toThrow('No Xtream server URL provided');
  });

  it('refuses something that is not a URL, here rather than a request later', () => {
    expect(() => resolveApiUrl('not a url')).toThrow(/Invalid Xtream server URL/);
  });
});

describe('buildGuideUrl', () => {
  const credentials = { username: 'joe', password: 'hunter2' };

  it('points at xmltv.php at the server root', () => {
    expect(buildGuideUrl('http://mag.example', credentials)).toBe(
      'http://mag.example/xmltv.php?username=joe&password=hunter2'
    );
  });

  // The same server URL the rest of the client is given, which usually already
  // names player_api.php.
  it('accepts a URL that already names the API', () => {
    expect(buildGuideUrl('http://mag.example/player_api.php', credentials)).toBe(
      'http://mag.example/xmltv.php?username=joe&password=hunter2'
    );
  });

  it('keeps a non-standard port', () => {
    expect(buildGuideUrl('http://mag.example:8080', credentials)).toContain(
      'http://mag.example:8080/xmltv.php'
    );
  });

  it('escapes credentials that would otherwise break the query', () => {
    const url = buildGuideUrl('http://mag.example', {
      username: 'a b',
      password: 'p&q=r'
    });

    expect(url).toContain('username=a+b');
    expect(url).toContain('password=p%26q%3Dr');
    expect(new URL(url).searchParams.get('password')).toBe('p&q=r');
  });

  it('refuses to build one with no server', () => {
    expect(() => buildGuideUrl('', credentials)).toThrow();
  });
});

describe('buildPlaybackUrl', () => {
  const credentials = { username: 'joe', password: 'hunter2' };

  it('puts playback at the server root, not under the API path', () => {
    expect(buildPlaybackUrl('http://example.com/player_api.php', credentials, 'live', '42')).toBe(
      'http://example.com/live/joe/hunter2/42.m3u8'
    );
  });

  it('uses the directory and default extension each type expects', () => {
    expect(buildPlaybackUrl('http://example.com', credentials, 'live', '42')).toBe(
      'http://example.com/live/joe/hunter2/42.m3u8'
    );
    expect(buildPlaybackUrl('http://example.com', credentials, 'vod', '42')).toBe(
      'http://example.com/movie/joe/hunter2/42.mp4'
    );
    expect(buildPlaybackUrl('http://example.com', credentials, 'series', '42')).toBe(
      'http://example.com/series/joe/hunter2/42.mp4'
    );
  });

  it('honours the container the provider gave, since players read the extension', () => {
    expect(buildPlaybackUrl('http://example.com', credentials, 'series', '42', 'mkv')).toBe(
      'http://example.com/series/joe/hunter2/42.mkv'
    );
  });

  it('refuses a type it cannot address', () => {
    expect(() => buildPlaybackUrl('http://example.com', credentials, 'x' as never, '42')).toThrow(
      XtreamError
    );
  });
});

describe('isAuthenticated', () => {
  it('accepts the success case', () => {
    expect(isAuthenticated({ user_info: { auth: 1, status: 'Active' } })).toBe(true);
  });

  it('rejects auth: 0, which is how a wrong password arrives inside a 200', () => {
    expect(isAuthenticated({ user_info: { auth: 0 } })).toBe(false);
  });

  it('accepts a response that omits auth, which some servers do when it worked', () => {
    expect(isAuthenticated({ user_info: { status: 'Active' } })).toBe(true);
  });

  it('rejects a response with no user_info at all', () => {
    expect(isAuthenticated({})).toBe(false);
    expect(isAuthenticated(null)).toBe(false);
    expect(isAuthenticated(undefined)).toBe(false);
  });
});

describe('toList', () => {
  it('passes an array through', () => {
    expect(toList([{ a: 1 }, { a: 2 }])).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('flattens an object keyed by category, which some servers answer with', () => {
    expect(toList({ '1': { a: 1 }, '2': { a: 2 } })).toEqual([{ a: 1 }, { a: 2 }]);
  });

  it('flattens one level of nested arrays', () => {
    expect(toList({ '1': [{ a: 1 }, { a: 2 }], '2': [{ a: 3 }] })).toEqual([
      { a: 1 },
      { a: 2 },
      { a: 3 }
    ]);
  });

  it('gives an empty list for nothing usable', () => {
    expect(toList(null)).toEqual([]);
    expect(toList(undefined)).toEqual([]);
    expect(toList('')).toEqual([]);
    expect(toList(42)).toEqual([]);
  });
});

describe('normaliseCategories', () => {
  it('reads what the app needs and stringifies the ids', () => {
    expect(
      normaliseCategories([{ category_id: 7, category_name: 'Sport', parent_id: 0 }])
    ).toEqual([{ category_id: '7', category_name: 'Sport', parent_id: '0' }]);
  });

  it('drops an entry with no id, which nothing could be filed under', () => {
    expect(normaliseCategories([{ category_name: 'Nameless' }])).toEqual([]);
  });

  it('survives a missing name rather than dropping the category', () => {
    expect(normaliseCategories([{ category_id: '7' }])[0].category_name).toBe('');
  });
});

describe('normaliseStreams', () => {
  it('leaves a well-formed live listing alone', () => {
    const streams = normaliseStreams([{ stream_id: 1, name: 'BBC One' }], 'live');

    expect(streams).toHaveLength(1);
    expect(streams[0].name).toBe('BBC One');
  });

  it('drops rows with no id or no name, which cannot be played or stored', () => {
    const streams = normaliseStreams(
      [
        { stream_id: 1, name: 'Good' },
        { stream_id: null, name: 'No id' },
        { stream_id: 2, name: '' },
        { stream_id: 3 }
      ],
      'live'
    );

    expect(streams.map(s => s.name)).toEqual(['Good']);
  });

  it('reads a series under whichever names the server used', () => {
    const [series] = normaliseStreams(
      [{ series_id: 55, title: 'The Show', cover: 'http://art', category: '9' }],
      'series'
    );

    expect(series).toMatchObject({
      stream_id: 55,
      name: 'The Show',
      stream_icon: 'http://art',
      category_id: '9'
    });
  });

  // A user's provider, 28 September: shows carry last_modified and no added,
  // so "Recently added" sorted them A to Z.
  it('dates a show by when it last changed, which is when an episode arrived', () => {
    const [dated, undated] = normaliseStreams(
      [
        { series_id: 1, name: 'Bodkin', last_modified: '1790542044' },
        { series_id: 2, name: 'Undated' }
      ],
      'series'
    );

    expect(dated.added).toBe('1790542044');
    expect(undated.added).toBe('0');
  });

  it('prefers the plain names when a server sends both', () => {
    const [series] = normaliseStreams(
      [{ stream_id: 1, series_id: 99, name: 'Real', title: 'Alias' }],
      'series'
    );

    expect(series).toMatchObject({ stream_id: 1, name: 'Real' });
  });

  it('falls back through the artwork fields in turn', () => {
    const [series] = normaliseStreams(
      [{ series_id: 1, title: 'Show', cover_big: 'http://big' }],
      'series'
    );

    expect(series.stream_icon).toBe('http://big');
  });

  it('filters series by category itself, since servers ignore the parameter', () => {
    const streams = normaliseStreams(
      [
        { series_id: 1, title: 'Wanted', category_id: '9' },
        { series_id: 2, title: 'Not wanted', category_id: '4' }
      ],
      'series',
      '9'
    );

    expect(streams.map(s => s.name)).toEqual(['Wanted']);
  });

  it('compares category ids across types, since one side is often a number', () => {
    const streams = normaliseStreams(
      [{ series_id: 1, title: 'Wanted', category_id: 9 }],
      'series',
      '9'
    );

    expect(streams).toHaveLength(1);
  });

  it('does not second-guess the category for live or films', () => {
    // Those servers honour the parameter, and re-filtering on a field the
    // response may not carry would empty the list.
    const streams = normaliseStreams([{ stream_id: 1, name: 'BBC One' }], 'live', '9');

    expect(streams).toHaveLength(1);
  });

  it('handles a server answering with an object instead of a list', () => {
    const streams = normaliseStreams({ a: { stream_id: 1, name: 'One' } }, 'live');

    expect(streams).toHaveLength(1);
  });
});

describe('isProviderUnreachable', () => {
  it('counts a timeout, a dead connection and a server error', () => {
    expect(isProviderUnreachable({ statusCode: 408 })).toBe(true);
    expect(isProviderUnreachable({ statusCode: 502 })).toBe(true);
    expect(isProviderUnreachable({ statusCode: 500 })).toBe(true);
    expect(isProviderUnreachable({ statusCode: 503 })).toBe(true);
  });

  it('counts a bare 403, which cannot be a verdict on the account', () => {
    expect(isProviderUnreachable({ statusCode: 403 })).toBe(true);
  });

  it('does not count a 401, which is an answer and refuses', () => {
    expect(isProviderUnreachable({ statusCode: 401 })).toBe(false);
  });

  it('does not count a 404 or a 400', () => {
    expect(isProviderUnreachable({ statusCode: 404 })).toBe(false);
    expect(isProviderUnreachable({ statusCode: 400 })).toBe(false);
  });

  it('says no for anything with no status to read', () => {
    expect(isProviderUnreachable(new Error('boom'))).toBe(false);
    expect(isProviderUnreachable(null)).toBe(false);
    expect(isProviderUnreachable(undefined)).toBe(false);
  });
});
