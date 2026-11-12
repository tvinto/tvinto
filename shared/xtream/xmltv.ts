import { XMLParser } from 'fast-xml-parser';
import { decodeBase64, decodeHtmlEntities, isBase64 } from './epg';

/**
 * Turning an XMLTV document into channels and programmes.
 *
 * Lifted out of the backend alongside the Base64 decoding, and for the same
 * reason: none of it is server work. It takes a string and returns objects.
 * Fetching the string -- which needs gzip, streaming and a size limit, and
 * differs between a Node server and a WebView -- stays with the caller, so
 * this half can be tested without a network and run anywhere.
 *
 * fast-xml-parser is pure JavaScript and travels unchanged.
 */

/** A channel as XMLTV names it. */
export interface XmltvChannel {
  id: string;
  name: string;
}

/** One programme, with times left as XMLTV's own strings. */
export interface XmltvProgramme {
  channel: string;
  start: string;
  stop: string;
  title: string;
  description: string;
  category: string;
}

export interface XmltvGuide {
  channels: XmltvChannel[];
  programmes: XmltvProgramme[];
  total: number;
}

/**
 * The parser configuration, which is load-bearing.
 *
 * Attributes are where XMLTV keeps almost everything that matters -- the
 * channel id, the start and stop times -- so ignoring them would leave a
 * guide of titles attached to nothing. CDATA is separated out because
 * descriptions frequently arrive wrapped in it.
 */
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: true,
  parseAttributeValue: false,
  trimValues: true,
  cdataPropName: '__cdata',
  textNodeName: '#text',
  ignoreDeclaration: false,
  removeNSPrefix: false,
  // Entities are decoded here instead (decodeHtmlEntities), never by the
  // parser. With them on, a guide's DOCTYPE could declare one entity and
  // repeat it into gigabytes -- and only some versions of the parser have a
  // limit; the backend's copy has none.
  processEntities: false
});

/** XMLTV allows one or many of anything; normalise to a list. */
const asArray = (value: unknown): unknown[] => {
  if (Array.isArray(value)) {
    return value;
  }
  return value ? [value] : [];
};

/**
 * Pulls readable text out of whatever shape a field arrived in.
 *
 * The same field is a bare string in one feed, a `#text` node in another and
 * CDATA in a third, and some feeds carry several translations as an array. On
 * top of that, titles are sometimes Base64 even inside XMLTV, so this decodes
 * that too before unescaping the entities XMLTV leaves behind.
 */
export const extractText = (value: unknown): string => {
  let text = '';

  if (!value) {
    return '';
  }

  if (typeof value === 'string') {
    text = value;
  } else if (Array.isArray(value)) {
    // Several translations of one field: take the first that says anything.
    for (const item of value) {
      const candidate = extractText(item);
      if (candidate) {
        text = candidate;
        break;
      }
    }
    // Already fully decoded by the recursive call.
    return text;
  } else if (typeof value === 'object') {
    const node = value as Record<string, unknown>;
    if (node['#text']) {
      text = String(node['#text']);
    } else if (node['__cdata']) {
      text = String(node['__cdata']);
    } else {
      text = String(value);
    }
  } else {
    text = String(value);
  }

  text = text.trim();

  if (text && isBase64(text)) {
    const decoded = decodeBase64(text);
    if (decoded && decoded !== text) {
      text = decoded;
    }
  }

  return decodeHtmlEntities(text);
};

/**
 * Parses an XMLTV document.
 *
 * A byte-order mark is stripped first: feeds served as UTF-8 with a BOM are
 * common, and the parser treats the mark as content and fails on the document
 * that follows.
 */
export const parseXmltv = (xml: string): XmltvGuide => {
  const document = xml.charCodeAt(0) === 0xfeff ? xml.slice(1) : xml;
  const parsed = parser.parse(document) as { tv?: Record<string, unknown> };
  const tv = parsed.tv || {};

  const channels = asArray(tv['channel']).map(entry => {
    const channel = entry as Record<string, unknown>;
    return {
      id: decodeHtmlEntities(String(channel['@_id'] || '')),
      name: extractText(channel['display-name'])
    };
  });

  const programmes = asArray(tv['programme']).map(entry => {
    const programme = entry as Record<string, unknown>;
    return {
      channel: decodeHtmlEntities(String(programme['@_channel'] || '')),
      start: decodeHtmlEntities(String(programme['@_start'] || '')),
      stop: decodeHtmlEntities(String(programme['@_stop'] || '')),
      title: extractText(programme['title']),
      description: extractText(programme['desc']),
      category: extractText(programme['category'])
    };
  });

  return { channels, programmes, total: programmes.length };
};
