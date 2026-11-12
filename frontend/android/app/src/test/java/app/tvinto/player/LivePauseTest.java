package app.tvinto.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** What a pause writes: the channel as one continuous stream. Addresses are made up. */
public class LivePauseTest {

    @Test
    public void asksForAnXtreamChannelAsMpegTs() {
        assertEquals("http://example.test:8080/live/u/p/1000.ts", LivePause.continuousAddress("http://example.test:8080/live/u/p/1000.m3u8"));
        assertEquals("https://example.test/live/u/p/7.ts?token=x", LivePause.continuousAddress("https://example.test/live/u/p/7.m3u8?token=x"));
    }

    @Test
    public void keepsAStreamThatIsAlreadyContinuous() {
        assertEquals("http://example.test/live/u/p/1000.ts", LivePause.continuousAddress("http://example.test/live/u/p/1000.ts"));
        assertEquals("http://example.test/stream/42", LivePause.continuousAddress("http://example.test/stream/42"));
    }

    @Test
    public void cannotPauseAnotherPlaylist() {
        assertNull(LivePause.continuousAddress("http://example.test/hls/channel.m3u8"));
        assertNull(LivePause.continuousAddress("http://example.test/list.m3u?x=1"));
        assertNull(LivePause.continuousAddress(""));
        assertNull(LivePause.continuousAddress(null));
    }
}
