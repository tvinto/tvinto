import { guideSourceId, subscriptionId } from './guideSourceId';
import { formatXmltvTime, parseXmltvTime } from './xmltvTime';

describe('guideSourceId', () => {
  const withCredentials = 'http://mag.example/xmltv.php?username=c0ffee&password=hunter2';

  // The whole reason this exists: the id ends up in the database, its indexes
  // and any log line about a load, and an Xtream guide URL is a credential.
  it('carries nothing from the URL that could identify the subscription', () => {
    const id = guideSourceId(withCredentials);

    expect(id).not.toContain('hunter2');
    expect(id).not.toContain('c0ffee');
    expect(id).not.toContain('mag.example');
    expect(id).not.toContain('xmltv');
  });

  it('gives the same id for the same URL, so a reload replaces rather than adds', () => {
    expect(guideSourceId(withCredentials)).toBe(guideSourceId(withCredentials));
  });

  it('ignores surrounding whitespace, which a pasted URL often has', () => {
    expect(guideSourceId('  http://a.example/epg.xml  ')).toBe(
      guideSourceId('http://a.example/epg.xml')
    );
  });

  it('gives different ids to different URLs', () => {
    expect(guideSourceId('http://a.example/epg.xml')).not.toBe(
      guideSourceId('http://b.example/epg.xml')
    );
  });

  // A changed password is the same feed, but it is a different URL and gets a
  // different id -- which reloads rather than silently reusing the old rows.
  it('gives a different id when only the credentials change', () => {
    expect(guideSourceId('http://a.example/x.php?password=one')).not.toBe(
      guideSourceId('http://a.example/x.php?password=two')
    );
  });

  it('differs on a one-character change, so near-identical feeds do not collide', () => {
    expect(guideSourceId('http://a.example/epg1.xml')).not.toBe(
      guideSourceId('http://a.example/epg2.xml')
    );
  });

  it('always looks like an id', () => {
    for (const url of ['', 'x', withCredentials, 'http://a.example/' + 'y'.repeat(500)]) {
      expect(guideSourceId(url)).toMatch(/^src-[0-9a-f]{8}$/);
    }
  });
});

describe('subscriptionId', () => {
  const SERVER = 'http://provider.example:8080';
  const USERNAME = 'c0ffee';

  it('carries nothing that could be used to sign in', () => {
    const id = subscriptionId(SERVER, USERNAME);

    // It travels to a service that holds no key to the ciphertext beside it,
    // and it is the one part of a subscription that service can read.
    expect(id).not.toContain(USERNAME);
    expect(id).toMatch(/^sub-[0-9a-f]{8}$/);
  });

  it('stays the same when the password is renewed', () => {
    // The property the whole id exists for. A renewal is the same subscription
    // with a new password, and an id that moved with it would leave the old
    // row behind every time.
    expect(subscriptionId(SERVER, USERNAME)).toBe(subscriptionId(SERVER, USERNAME));
  });

  it('ignores a trailing slash on the address', () => {
    // The same line typed two ways is one subscription, not two.
    expect(subscriptionId(`${SERVER}/`, USERNAME)).toBe(subscriptionId(SERVER, USERNAME));
  });

  it('separates a different line on the same server', () => {
    expect(subscriptionId(SERVER, 'someone-else')).not.toBe(subscriptionId(SERVER, USERNAME));
  });

  it('separates the same username on a different server', () => {
    expect(subscriptionId('http://other.example', USERNAME)).not.toBe(
      subscriptionId(SERVER, USERNAME)
    );
  });

  it('cannot be confused with a guide source id', () => {
    expect(subscriptionId(SERVER, USERNAME).startsWith('sub-')).toBe(true);
    expect(guideSourceId(SERVER).startsWith('src-')).toBe(true);
  });
});

describe('formatXmltvTime', () => {
  it('writes a time XMLTV would recognise', () => {
    expect(formatXmltvTime(Date.parse('2026-08-27T18:00:00Z'))).toBe('20260827180000 +0000');
  });

  it('pads every field', () => {
    expect(formatXmltvTime(Date.parse('2026-01-02T03:04:05Z'))).toBe('20260102030405 +0000');
  });

  // The property that matters: a guide read back from the device and handed to
  // code written against XMLTV strings must mean the same moment.
  it('round-trips through the parser', () => {
    for (const iso of [
      '2026-08-27T18:00:00Z',
      '2026-01-01T00:00:00Z',
      '2024-02-29T12:30:45Z',
      '2026-12-31T23:59:59Z'
    ]) {
      const ms = Date.parse(iso);
      expect(parseXmltvTime(formatXmltvTime(ms))).toBe(ms);
    }
  });

  it('gives an empty string for a time that is not one', () => {
    expect(formatXmltvTime(Number.NaN)).toBe('');
  });
});
