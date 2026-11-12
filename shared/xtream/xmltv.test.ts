import { extractText, parseXmltv } from './xmltv';

/** Wraps fragments in the document element every XMLTV feed has. */
const tv = (inner: string) => `<?xml version="1.0" encoding="UTF-8"?><tv>${inner}</tv>`;

const b64 = (text: string) => {
  const bytes = new TextEncoder().encode(text);
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
};

describe('parseXmltv', () => {
  it('reads channels and programmes, keeping the attributes that matter', () => {
    const guide = parseXmltv(
      tv(`
        <channel id="hrt1.hr"><display-name>HRT 1</display-name></channel>
        <programme channel="hrt1.hr" start="20260827180000 +0200" stop="20260827190000 +0200">
          <title>Dnevnik</title>
          <desc>Vijesti</desc>
          <category>News</category>
        </programme>
      `)
    );

    expect(guide.channels).toEqual([{ id: 'hrt1.hr', name: 'HRT 1' }]);
    expect(guide.programmes).toEqual([
      {
        channel: 'hrt1.hr',
        start: '20260827180000 +0200',
        stop: '20260827190000 +0200',
        title: 'Dnevnik',
        description: 'Vijesti',
        category: 'News'
      }
    ]);
    expect(guide.total).toBe(1);
  });

  // XMLTV gives one element where there is one of a thing and a list where
  // there are several, so a feed with a single channel is a different shape.
  it('treats a lone channel the same as a list of them', () => {
    const one = parseXmltv(tv('<channel id="a"><display-name>A</display-name></channel>'));
    const two = parseXmltv(
      tv(
        '<channel id="a"><display-name>A</display-name></channel>' +
          '<channel id="b"><display-name>B</display-name></channel>'
      )
    );

    expect(one.channels).toHaveLength(1);
    expect(two.channels).toHaveLength(2);
  });

  it('reads a description wrapped in CDATA', () => {
    const guide = parseXmltv(
      tv('<programme channel="a" start="1" stop="2"><desc><![CDATA[Nogomet & tenis]]></desc></programme>')
    );

    expect(guide.programmes[0].description).toBe('Nogomet & tenis');
  });

  it('takes the first translation when a field carries several', () => {
    const guide = parseXmltv(
      tv(
        '<channel id="a"><display-name lang="hr">Prvi</display-name>' +
          '<display-name lang="en">First</display-name></channel>'
      )
    );

    expect(guide.channels[0].name).toBe('Prvi');
  });

  it('decodes a Base64 title, which some feeds use even inside XMLTV', () => {
    const guide = parseXmltv(
      tv(`<programme channel="a" start="1" stop="2"><title>${b64('Sport i vrijeme')}</title></programme>`)
    );

    expect(guide.programmes[0].title).toBe('Sport i vrijeme');
  });

  // The decoder is deliberately conservative: a payload that opens like a
  // capitalised word is left alone, because a real title wrongly decoded is a
  // far worse result than an encoded one shown as it arrived. "Vijesti dana"
  // happens to encode to something that trips that guard.
  it('leaves a Base64 payload alone when it reads like ordinary text', () => {
    const encoded = b64('Vijesti dana');
    const guide = parseXmltv(
      tv(`<programme channel="a" start="1" stop="2"><title>${encoded}</title></programme>`)
    );

    expect(guide.programmes[0].title).toBe(encoded);
  });

  it('unescapes the entities XMLTV escaping leaves behind', () => {
    const guide = parseXmltv(
      tv('<programme channel="a" start="1" stop="2"><title>Tom &amp; Jerry</title></programme>')
    );

    expect(guide.programmes[0].title).toBe('Tom & Jerry');
  });

  // Feeds served as UTF-8 with a byte-order mark are common, and the parser
  // treats the mark as content and fails on everything after it.
  it('survives a byte-order mark', () => {
    const guide = parseXmltv(
      '﻿' + tv('<channel id="a"><display-name>A</display-name></channel>')
    );

    expect(guide.channels).toEqual([{ id: 'a', name: 'A' }]);
  });

  it('keeps Croatian characters intact', () => {
    const guide = parseXmltv(
      tv('<programme channel="a" start="1" stop="2"><title>Čudnovate zgode šegrta Hlapića</title></programme>')
    );

    expect(guide.programmes[0].title).toBe('Čudnovate zgode šegrta Hlapića');
  });

  it('returns an empty guide for a document with nothing in it', () => {
    expect(parseXmltv(tv(''))).toEqual({ channels: [], programmes: [], total: 0 });
  });

  it('returns an empty guide rather than throwing on a document that is not XMLTV', () => {
    expect(parseXmltv('<html><body>Not found</body></html>')).toEqual({
      channels: [],
      programmes: [],
      total: 0
    });
  });

  it('leaves a programme with no title as an empty string rather than undefined', () => {
    const guide = parseXmltv(tv('<programme channel="a" start="1" stop="2"></programme>'));

    expect(guide.programmes[0].title).toBe('');
    expect(guide.programmes[0].description).toBe('');
  });
});

describe('extractText', () => {
  it('reads a bare string', () => {
    expect(extractText('Dnevnik')).toBe('Dnevnik');
  });

  it('reads a text node', () => {
    expect(extractText({ '#text': 'Dnevnik', '@_lang': 'hr' })).toBe('Dnevnik');
  });

  it('reads CDATA', () => {
    expect(extractText({ __cdata: 'Dnevnik' })).toBe('Dnevnik');
  });

  it('skips empty entries in a list', () => {
    expect(extractText(['', '   ', 'Dnevnik'])).toBe('Dnevnik');
  });

  it('returns an empty string for nothing at all', () => {
    expect(extractText(undefined)).toBe('');
    expect(extractText(null)).toBe('');
    expect(extractText('')).toBe('');
  });
});
