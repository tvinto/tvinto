import { XtreamAccount, XtreamClient } from './client';
import { XtreamError } from './protocol';
import { XtreamResponse, XtreamTransport, noResponse, timedOut } from './transport';

const ACCOUNT: XtreamAccount = {
  serverUrl: 'http://provider.example',
  username: 'joe',
  password: 'hunter2'
};

/**
 * A transport that answers from a script and records what it was asked.
 *
 * The point of the interface: none of these tests touch a network, and the
 * same client is exercised here as runs against a real provider.
 */
class FakeTransport implements XtreamTransport {
  readonly calls: Array<{ url: string; params: Record<string, unknown>; timeoutMs?: number }> = [];
  private answers: Array<XtreamResponse | Error> = [];

  answerWith(...answers: Array<XtreamResponse | Error>): this {
    this.answers = answers;
    return this;
  }

  async get(
    url: string,
    params: Record<string, unknown>,
    timeoutMs?: number
  ): Promise<XtreamResponse> {
    this.calls.push({ url, params, timeoutMs });
    const answer = this.answers.shift() ?? { status: 200, data: [] };
    if (answer instanceof Error) {
      throw answer;
    }
    return answer;
  }
}

const ok = (data: unknown): XtreamResponse => ({ status: 200, data });

describe('addressing the provider', () => {
  it('sends every request to the API endpoint, working it out from the host', async () => {
    const transport = new FakeTransport().answerWith(ok([]));
    await new XtreamClient(transport, ACCOUNT).getCategories('live');

    expect(transport.calls[0].url).toBe('http://provider.example/player_api.php');
  });

  it('refuses to be built with a server URL that is not one', () => {
    expect(
      () => new XtreamClient(new FakeTransport(), { ...ACCOUNT, serverUrl: 'nonsense' })
    ).toThrow(XtreamError);
  });

  it('carries the credentials on every call, since Xtream has no sessions', async () => {
    const transport = new FakeTransport().answerWith(ok([]), ok([]));
    const client = new XtreamClient(transport, ACCOUNT);

    await client.getCategories('live');
    await client.getStreams('vod');

    for (const call of transport.calls) {
      expect(call.params).toMatchObject({ username: 'joe', password: 'hunter2' });
    }
  });

  it('builds a playback URL without asking the provider anything', () => {
    const transport = new FakeTransport();
    const url = new XtreamClient(transport, ACCOUNT).playbackUrl('live', '42');

    expect(url).toBe('http://provider.example/live/joe/hunter2/42.m3u8');
    expect(transport.calls).toHaveLength(0);
  });
});

describe('authenticate', () => {
  it('accepts credentials the provider confirms', async () => {
    const transport = new FakeTransport().answerWith(
      ok({ user_info: { auth: 1, status: 'Active' } })
    );

    await expect(new XtreamClient(transport, ACCOUNT).authenticate()).resolves.toMatchObject({
      user_info: { status: 'Active' }
    });
  });

  it('refuses auth: 0, which is how a wrong password arrives inside a 200', async () => {
    const transport = new FakeTransport().answerWith(ok({ user_info: { auth: 0 } }));

    await expect(new XtreamClient(transport, ACCOUNT).authenticate()).rejects.toMatchObject({
      statusCode: 401,
      message: 'Invalid credentials'
    });
  });

  it('refuses a response carrying no user_info', async () => {
    const transport = new FakeTransport().answerWith(ok({ something: 'else' }));

    await expect(new XtreamClient(transport, ACCOUNT).authenticate()).rejects.toMatchObject({
      statusCode: 401
    });
  });
});

describe('listings', () => {
  it('asks for the right action per type', async () => {
    const transport = new FakeTransport().answerWith(ok([]), ok([]), ok([]));
    const client = new XtreamClient(transport, ACCOUNT);

    await client.getCategories('live');
    await client.getCategories('vod');
    await client.getStreams('series');

    expect(transport.calls.map(c => c.params['action'])).toEqual([
      'get_live_categories',
      'get_vod_categories',
      'get_series'
    ]);
  });

  it('passes a category through, and omits it when there is none', async () => {
    const transport = new FakeTransport().answerWith(ok([]), ok([]));
    const client = new XtreamClient(transport, ACCOUNT);

    await client.getStreams('live', '9');
    await client.getStreams('live');

    expect(transport.calls[0].params['category_id']).toBe('9');
    expect(transport.calls[1].params).not.toHaveProperty('category_id');
  });

  it('normalises what comes back, so a caller sees one shape', async () => {
    const transport = new FakeTransport().answerWith(
      ok({ '1': { series_id: 7, title: 'The Show', cover: 'http://art', category_id: '9' } })
    );

    const [series] = await new XtreamClient(transport, ACCOUNT).getStreams('series', '9');

    expect(series).toMatchObject({ stream_id: 7, name: 'The Show', stream_icon: 'http://art' });
  });

  it('asks a series for its episodes by id', async () => {
    const transport = new FakeTransport().answerWith(ok({ episodes: {} }));

    await new XtreamClient(transport, ACCOUNT).getSeriesInfo('55');

    expect(transport.calls[0].params).toMatchObject({
      action: 'get_series_info',
      series_id: '55'
    });
  });

  it('asks for a short guide, with a limit when given one', async () => {
    const transport = new FakeTransport().answerWith(ok({ epg_listings: [] }), ok({}));
    const client = new XtreamClient(transport, ACCOUNT);

    await client.getShortEPG('42', 4);
    await client.getShortEPG('42');

    expect(transport.calls[0].params).toMatchObject({ action: 'get_short_epg', limit: 4 });
    expect(transport.calls[1].params).not.toHaveProperty('limit');
  });
});

describe('failures', () => {
  it('turns a non-200 into an error carrying that status', async () => {
    const transport = new FakeTransport().answerWith({ status: 403, data: 'Forbidden' });

    await expect(new XtreamClient(transport, ACCOUNT).getCategories('live')).rejects.toMatchObject({
      statusCode: 403
    });
  });

  it('refuses an empty body rather than reading it as no content', async () => {
    // A provider answering 200 with nothing has not told us there are no
    // categories; it has failed to tell us anything.
    for (const empty of [null, undefined, '']) {
      const transport = new FakeTransport().answerWith({ status: 200, data: empty });

      await expect(
        new XtreamClient(transport, ACCOUNT).getCategories('live')
      ).rejects.toMatchObject({ statusCode: 502 });
    }
  });

  it('reads an empty list as an empty list, which is a real answer', async () => {
    const transport = new FakeTransport().answerWith(ok([]));

    await expect(new XtreamClient(transport, ACCOUNT).getCategories('live')).resolves.toEqual([]);
  });

  it('lets a transport failure through in the terms it reported', async () => {
    const timeout = new FakeTransport().answerWith(timedOut());
    const dead = new FakeTransport().answerWith(noResponse());

    await expect(new XtreamClient(timeout, ACCOUNT).getCategories('live')).rejects.toMatchObject({
      statusCode: 408
    });
    await expect(new XtreamClient(dead, ACCOUNT).getCategories('live')).rejects.toMatchObject({
      statusCode: 502
    });
  });
});

describe('timeouts', () => {
  it('uses the default it was built with', async () => {
    const transport = new FakeTransport().answerWith(ok([]));

    await new XtreamClient(transport, ACCOUNT, 45_000).getCategories('live');

    expect(transport.calls[0].timeoutMs).toBe(45_000);
  });

  it('lets one call override it, which is what a sync needs', async () => {
    const transport = new FakeTransport().answerWith(ok([]));

    await new XtreamClient(transport, ACCOUNT, 10_000).getCategories('live', 60_000);

    expect(transport.calls[0].timeoutMs).toBe(60_000);
  });

  it('passes nothing when no timeout was set either way', async () => {
    const transport = new FakeTransport().answerWith(ok([]));

    await new XtreamClient(transport, ACCOUNT).getCategories('live');

    expect(transport.calls[0].timeoutMs).toBeUndefined();
  });
});
