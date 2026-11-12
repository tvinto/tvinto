/**
 * A fetched file's bytes as they arrive, for a worker reading a download
 * through the WebView's local file address (libraryWorker.ts, guideWorker.ts).
 */
export async function* fetchedBytes(response: Response): AsyncIterable<Uint8Array> {
  if (!response.body) {
    yield new Uint8Array(await response.arrayBuffer());
    return;
  }
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        return;
      }
      if (value) {
        yield value;
      }
    }
  } finally {
    reader.releaseLock();
  }
}
