package app.tvinto.player;

import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

/** Reading an HLS channel's playlists, for pausing it piece by piece. Addresses are made up. */
public class HlsPlaylistTest {

    private static final String BASE = "http://example.test/hls/42/index.m3u8?token=t";

    private static final String LIVE = String.join("\n",
        "#EXTM3U",
        "#EXT-X-VERSION:3",
        "#EXT-X-TARGETDURATION:6",
        "#EXT-X-MEDIA-SEQUENCE:1200",
        "#EXTINF:6.000,",
        "seg-1200.ts",
        "#EXTINF:6.000,",
        "seg-1201.ts",
        "#EXT-X-DISCONTINUITY",
        "#EXTINF:4.5,title, with a comma",
        "/elsewhere/seg-1202.ts",
        "#EXTINF:6,",
        "http://cdn.example.test/seg-1203.ts",
        "#EXTINF:6.000,",
        "seg-1204.ts",
        "");

    @Test
    public void readsAMediaPlaylistsPiecesInOrder() {
        HlsPlaylist list = HlsPlaylist.parse(LIVE, BASE);
        assertFalse(list.master);
        assertFalse(list.ended);
        assertNull(list.unsupported());
        assertEquals(6.0, list.targetSeconds, 0.0);
        assertEquals(1200L, list.mediaSequence);
        assertEquals(5, list.segments.size());
        assertEquals(1200L, list.segments.get(0).sequence);
        assertEquals(1204L, list.segments.get(4).sequence);
        assertEquals(4.5, list.segments.get(2).seconds, 0.0);
    }

    @Test
    public void resolvesPieceAddressesAgainstThePlaylist() {
        HlsPlaylist list = HlsPlaylist.parse(LIVE, BASE);
        assertEquals("http://example.test/hls/42/seg-1200.ts", list.segments.get(0).uri);
        assertEquals("http://example.test/elsewhere/seg-1202.ts", list.segments.get(2).uri);
        assertEquals("http://cdn.example.test/seg-1203.ts", list.segments.get(3).uri);
    }

    @Test
    public void marksTheDiscontinuityOnThePieceAfterIt() {
        HlsPlaylist list = HlsPlaylist.parse(LIVE, BASE);
        assertFalse(list.segments.get(1).discontinuity);
        assertTrue(list.segments.get(2).discontinuity);
        assertFalse(list.segments.get(3).discontinuity);
    }

    @Test
    public void startsFromThePieceOnScreenWhileThePlaylistHasIt() {
        HlsPlaylist list = HlsPlaylist.parse(LIVE, BASE);
        assertEquals(1201L, list.startSequence(1201L));
    }

    @Test
    public void otherwiseStartsThreeTargetDurationsFromTheNewest() {
        HlsPlaylist list = HlsPlaylist.parse(LIVE, BASE);
        // 18 s back from the end (6 + 6 + 4.5 short of it) falls in 1201.
        assertEquals(1201L, list.startSequence(-1L));
        assertEquals(1201L, list.startSequence(999L));
    }

    @Test
    public void startsFromTheHoldBackWhenThePlaylistGivesOne() {
        String held = LIVE.replace("#EXT-X-VERSION:3", "#EXT-X-VERSION:6\n#EXT-X-SERVER-CONTROL:CAN-BLOCK-RELOAD=NO,HOLD-BACK=7.0");
        assertEquals(1203L, HlsPlaylist.parse(held, BASE).startSequence(-1L));
    }

    @Test
    public void anEmptyLivePlaylistHasNowhereToStart() {
        HlsPlaylist list = HlsPlaylist.parse("#EXTM3U\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:5\n", BASE);
        assertEquals(-1L, list.startSequence(-1L));
        assertEquals(10.0, list.targetSeconds, 0.0);
    }

    @Test
    public void knowsWhenThePlaylistHasEnded() {
        assertTrue(HlsPlaylist.parse(LIVE + "#EXT-X-ENDLIST\n", BASE).ended);
    }

    @Test
    public void takesTheTargetFromTheLongestPieceWhenNotGiven() {
        HlsPlaylist list = HlsPlaylist.parse("#EXTM3U\n#EXTINF:9.2,\na.ts\n#EXTINF:4,\nb.ts\n", BASE);
        assertEquals(10.0, list.targetSeconds, 0.0);
        assertEquals(0L, list.segments.get(0).sequence);
    }

    @Test
    public void readsWindowsLineEndsAndAByteOrderMark() {
        HlsPlaylist list = HlsPlaylist.parse("﻿#EXTM3U\r\n#EXT-X-MEDIA-SEQUENCE:3\r\n#EXTINF:5,\r\na.ts\r\n", BASE);
        assertEquals(1, list.segments.size());
        assertEquals(3L, list.segments.get(0).sequence);
        assertEquals("http://example.test/hls/42/a.ts", list.segments.get(0).uri);
    }

    @Test
    public void saysWhichPlaylistsCannotBeWrittenAsOneFile() {
        assertNotNull(HlsPlaylist.parse(LIVE.replace("#EXT-X-VERSION:3", "#EXT-X-VERSION:7\n#EXT-X-MAP:URI=\"init.mp4\""), BASE).unsupported());
        assertNotNull(HlsPlaylist.parse(LIVE.replace("#EXT-X-VERSION:3", "#EXT-X-KEY:METHOD=AES-128,URI=\"key\""), BASE).unsupported());
        assertNotNull(HlsPlaylist.parse(LIVE.replace("#EXTINF:6,", "#EXTINF:6,\n#EXT-X-BYTERANGE:1000@0"), BASE).unsupported());
        assertNull(HlsPlaylist.parse(LIVE.replace("#EXT-X-VERSION:3", "#EXT-X-KEY:METHOD=NONE"), BASE).unsupported());
    }

    @Test
    public void tellsAPlaylistFromSomethingElse() {
        assertTrue(HlsPlaylist.looksLikePlaylist(LIVE));
        assertTrue(HlsPlaylist.looksLikePlaylist("﻿ #EXTM3U\n"));
        assertFalse(HlsPlaylist.looksLikePlaylist("<html>Not found</html>"));
        assertFalse(HlsPlaylist.looksLikePlaylist(null));
    }

    private static final String MASTER = String.join("\n",
        "#EXTM3U",
        "#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,CODECS=\"avc1.4d401e,mp4a.40.2\"",
        "low/index.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,CODECS=\"avc1.640028,mp4a.40.2\"",
        "high/index.m3u8",
        "#EXT-X-STREAM-INF:BANDWIDTH=2500000,RESOLUTION=1280x720",
        "mid/index.m3u8",
        "");

    @Test
    public void readsAMastersVariants() {
        HlsPlaylist master = HlsPlaylist.parse(MASTER, BASE);
        assertTrue(master.master);
        assertEquals(3, master.variants.size());
        assertEquals("http://example.test/hls/42/low/index.m3u8", master.variants.get(0).uri);
        assertEquals(5_000_000L, master.variants.get(1).bandwidth);
        assertTrue(master.segments.isEmpty());
    }

    @Test
    public void picksTheVariantThePlayerWasPlaying() {
        HlsPlaylist master = HlsPlaylist.parse(MASTER, BASE);
        assertEquals("http://example.test/hls/42/mid/index.m3u8", master.pick("http://example.test/hls/42/mid/index.m3u8", 5_000_000L).uri);
    }

    @Test
    public void elseTheOneOfTheSameBandwidth() {
        HlsPlaylist master = HlsPlaylist.parse(MASTER, BASE);
        assertEquals("http://example.test/hls/42/low/index.m3u8", master.pick("http://other.test/x.m3u8", 800_000L).uri);
    }

    @Test
    public void elseTheHighestBandwidth() {
        HlsPlaylist master = HlsPlaylist.parse(MASTER, BASE);
        assertEquals("http://example.test/hls/42/high/index.m3u8", master.pick(null, -1L).uri);
    }

    @Test
    public void skipsVariantsWhoseSoundIsAPlaylistOfItsOwn() {
        String separate = String.join("\n",
            "#EXTM3U",
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aac\",NAME=\"English\",DEFAULT=YES,URI=\"audio/en.m3u8\"",
            "#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"muxed\",NAME=\"Main\",DEFAULT=YES",
            "#EXT-X-STREAM-INF:BANDWIDTH=6000000,AUDIO=\"aac\"",
            "video-only/index.m3u8",
            "#EXT-X-STREAM-INF:BANDWIDTH=3000000,AUDIO=\"muxed\"",
            "muxed/index.m3u8",
            "");
        HlsPlaylist master = HlsPlaylist.parse(separate, BASE);
        assertEquals("http://example.test/hls/42/muxed/index.m3u8", master.pick(null, -1L).uri);
        // The player was playing one with no sound in its pieces: not pausable.
        assertNull(master.pick("http://example.test/hls/42/video-only/index.m3u8", -1L));
    }

    @Test
    public void readsQuotedAttributesWithCommasInThem() {
        assertEquals("avc1.4d401e,mp4a.40.2", HlsPlaylist.attributes("BANDWIDTH=1,CODECS=\"avc1.4d401e,mp4a.40.2\",X=y").get("CODECS"));
        assertEquals("y", HlsPlaylist.attributes("BANDWIDTH=1,CODECS=\"a,b\",X=y").get("X"));
    }
}
