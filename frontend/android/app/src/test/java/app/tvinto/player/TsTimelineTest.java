package app.tvinto.player;

import static org.junit.Assert.assertArrayEquals;
import static org.junit.Assert.assertEquals;
import static org.junit.Assert.assertNotNull;
import static org.junit.Assert.assertNull;

import org.junit.Test;

/** HLS pieces made into one TS stream that plays straight through. */
public class TsTimelineTest {

    private static final long SECOND = 90_000L;

    /** A TS packet starting a PES with this PTS (and DTS a little before it). */
    private static byte[] pes(long pts) {
        byte[] p = new byte[TsTimeline.PACKET];
        p[0] = 0x47;
        p[1] = 0x41; // a unit starts, PID 0x100
        p[2] = 0x00;
        p[3] = 0x10; // payload only
        p[4] = 0;
        p[5] = 0;
        p[6] = 1;
        p[7] = (byte) 0xE0; // video
        p[10] = (byte) 0x80;
        p[11] = (byte) 0xC0; // PTS and DTS
        p[12] = 10;
        p[13] = 0x30;
        TsTimeline.writeStamp(p, 13, pts);
        p[18] = 0x10;
        TsTimeline.writeStamp(p, 18, pts - 3_000L);
        return p;
    }

    /** A packet with only an adaptation field carrying this PCR. */
    private static byte[] pcr(long base) {
        byte[] p = new byte[TsTimeline.PACKET];
        p[0] = 0x47;
        p[1] = 0x01;
        p[2] = 0x00;
        p[3] = 0x20; // adaptation only
        p[4] = (byte) 183;
        p[5] = 0x10; // PCR
        p[6] = (byte) (base >> 25);
        p[7] = (byte) (base >> 17);
        p[8] = (byte) (base >> 9);
        p[9] = (byte) (base >> 1);
        p[10] = (byte) (((base & 1) << 7) | 0x7E);
        p[11] = 0;
        return p;
    }

    private static long pcrOf(byte[] packets, int at) {
        int p = at + 6;
        return ((long) (packets[p] & 0xFF) << 25) | ((packets[p + 1] & 0xFF) << 17) | ((packets[p + 2] & 0xFF) << 9)
            | ((packets[p + 3] & 0xFF) << 1) | ((packets[p + 4] & 0xFF) >> 7);
    }

    private static byte[] piece(long pts) {
        byte[] out = new byte[3 * TsTimeline.PACKET];
        System.arraycopy(pcr(pts - 9_000L), 0, out, 0, TsTimeline.PACKET);
        System.arraycopy(pes(pts), 0, out, TsTimeline.PACKET, TsTimeline.PACKET);
        System.arraycopy(pes(pts + SECOND), 0, out, 2 * TsTimeline.PACKET, TsTimeline.PACKET);
        return out;
    }

    @Test
    public void readsAndWritesATimestamp() {
        byte[] p = pes(0L);
        for (long stamp : new long[] {0L, 1L, 123_456_789L, TsTimeline.WRAP - 1L}) {
            TsTimeline.writeStamp(p, 13, stamp);
            assertEquals(stamp, TsTimeline.readStamp(p, 13));
        }
    }

    @Test
    public void leavesPiecesThatFollowOnAsTheyCame() {
        TsTimeline timeline = new TsTimeline();
        byte[] first = piece(10 * SECOND);
        byte[] second = piece(16 * SECOND);
        assertArrayEquals(first, timeline.fit(first.clone(), first.length, 6.0, false));
        assertArrayEquals(second, timeline.fit(second.clone(), second.length, 6.0, false));
    }

    @Test
    public void carriesTimestampsOnOverADiscontinuity() {
        TsTimeline timeline = new TsTimeline();
        byte[] first = piece(100 * SECOND);
        timeline.fit(first, first.length, 6.0, false);
        // The encoder started again from nearly nothing.
        byte[] restarted = piece(2 * SECOND);
        byte[] fitted = timeline.fit(restarted, restarted.length, 6.0, true);
        assertEquals(106 * SECOND, TsTimeline.firstPts(fitted));
        assertEquals(106 * SECOND + SECOND, TsTimeline.readStamp(fitted, 2 * TsTimeline.PACKET + 13));
        assertEquals(106 * SECOND - 3_000L, TsTimeline.readStamp(fitted, TsTimeline.PACKET + 18));
        assertEquals(106 * SECOND - 9_000L, pcrOf(fitted, 0));
        // And the pieces after it go on from there.
        byte[] after = piece(8 * SECOND);
        assertEquals(112 * SECOND, TsTimeline.firstPts(timeline.fit(after, after.length, 6.0, false)));
    }

    @Test
    public void carriesOnOverAJumpBackTheTagDidNotMention() {
        TsTimeline timeline = new TsTimeline();
        byte[] first = piece(100 * SECOND);
        timeline.fit(first, first.length, 6.0, false);
        byte[] back = piece(50 * SECOND);
        assertEquals(106 * SECOND, TsTimeline.firstPts(timeline.fit(back, back.length, 6.0, false)));
    }

    @Test
    public void closesTheGapOfMissedPieces() {
        TsTimeline timeline = new TsTimeline();
        byte[] first = piece(100 * SECOND);
        timeline.fit(first, first.length, 6.0, false);
        byte[] later = piece(160 * SECOND);
        assertEquals(106 * SECOND, TsTimeline.firstPts(timeline.fit(later, later.length, 6.0, true)));
    }

    @Test
    public void toleratesAPieceLengthThatIsSlightlyOff() {
        TsTimeline timeline = new TsTimeline();
        byte[] first = piece(100 * SECOND);
        timeline.fit(first, first.length, 6.0, false);
        // EXTINF said 6, the piece was 6.4 s: left as it came.
        byte[] next = piece(106 * SECOND + 36_000L);
        assertEquals(106 * SECOND + 36_000L, TsTimeline.firstPts(timeline.fit(next, next.length, 6.0, false)));
    }

    @Test
    public void goesOnRoundTheWrap() {
        TsTimeline timeline = new TsTimeline();
        byte[] first = piece(TsTimeline.WRAP - 3 * SECOND);
        timeline.fit(first, first.length, 6.0, false);
        // The clock wrapped: three seconds after zero is where it should be.
        byte[] wrapped = piece(3 * SECOND);
        assertEquals(3 * SECOND, TsTimeline.firstPts(timeline.fit(wrapped, wrapped.length, 6.0, false)));
    }

    @Test
    public void startsFromTheFirstPacketAndDropsAPartOne() {
        byte[] whole = piece(SECOND);
        byte[] messy = new byte[5 + whole.length + 100];
        messy[0] = 0x47; // a lone sync byte in the junk before
        System.arraycopy(whole, 0, messy, 5, whole.length);
        byte[] fitted = new TsTimeline().fit(messy, messy.length, 6.0, false);
        assertNotNull(fitted);
        assertArrayEquals(whole, fitted);
    }

    @Test
    public void refusesWhatIsNotMpegTs() {
        byte[] mp4 = "....ftypisom........moov".getBytes(java.nio.charset.StandardCharsets.US_ASCII);
        assertNull(new TsTimeline().fit(mp4, mp4.length, 6.0, false));
        assertNull(new TsTimeline().fit(new byte[0], 0, 6.0, false));
    }
}
