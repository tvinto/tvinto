/**
 * The objects of a JSON array, one at a time, from its bytes as they arrive.
 *
 * For a whole-library listing, which is one JSON array of every title a
 * provider has. Parsed in one piece it did not survive a television: the
 * body passed through Capacitor's HTTP bridge as a single string, the app's
 * Java heap reached 154 of 178 MB, and Android killed it mid-download. Walked
 * like this, only the object being read is ever held as text.
 *
 * It tracks nesting and strings, and nothing else of JSON's grammar: each
 * complete top-level object is handed to `JSON.parse`, which does the real
 * work and throws on anything malformed. A response that is not an array --
 * an error object, or a provider that keys its list by id -- is read whole
 * and its values yielded instead, which is rare and small.
 */
export async function* jsonArrayObjects(
  chunks: AsyncIterable<Uint8Array>
): AsyncIterable<Record<string, unknown>> {
  const decoder = new TextDecoder('utf-8');

  /** 'unknown' until the first significant character says what this is. */
  let shape: 'unknown' | 'array' | 'other' = 'unknown';
  let whole = '';
  // Read through a function: `walk` changes it, which the compiler cannot see.
  const isWhole = () => shape === 'other';

  let depth = 0;
  let inString = false;
  let escaped = false;
  /** Text of the object being read, from chunks before the current one. */
  let pending = '';

  const walk = function* (text: string): Generator<Record<string, unknown>> {
    let start = depth > 0 ? 0 : -1;

    for (let i = 0; i < text.length; i++) {
      const code = text.charCodeAt(i);

      if (shape === 'unknown') {
        if (code === 0x5b /* [ */) {
          shape = 'array';
          continue;
        }
        if (code > 0x20) {
          shape = 'other';
          whole += text.slice(i);
          return;
        }
        continue;
      }

      if (depth === 0) {
        if (code === 0x7b /* { */) {
          depth = 1;
          start = i;
        }
        // Commas, whitespace, the closing bracket: nothing to keep.
        continue;
      }

      if (inString) {
        if (escaped) {
          escaped = false;
        } else if (code === 0x5c /* \ */) {
          escaped = true;
        } else if (code === 0x22 /* " */) {
          inString = false;
        }
        continue;
      }

      if (code === 0x22) {
        inString = true;
      } else if (code === 0x7b || code === 0x5b) {
        depth++;
      } else if (code === 0x7d /* } */ || code === 0x5d /* ] */) {
        depth--;
        if (depth === 0) {
          const objectText = pending + text.slice(start, i + 1);
          pending = '';
          start = -1;
          const parsed = JSON.parse(objectText) as unknown;
          if (parsed && typeof parsed === 'object') {
            yield parsed as Record<string, unknown>;
          }
        }
      }
    }

    if (depth > 0 && start >= 0) {
      pending += text.slice(start);
    }
  };

  for await (const chunk of chunks) {
    const text = decoder.decode(chunk, { stream: true });
    if (isWhole()) {
      whole += text;
      continue;
    }
    yield* walk(text);
  }

  const tail = decoder.decode();
  if (isWhole()) {
    whole += tail;
    const parsed = JSON.parse(whole) as unknown;
    if (parsed && typeof parsed === 'object') {
      for (const value of Object.values(parsed as Record<string, unknown>)) {
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          yield value as Record<string, unknown>;
        }
      }
    }
    return;
  }
  yield* walk(tail);
}
