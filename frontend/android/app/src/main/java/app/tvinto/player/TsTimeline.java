package app.tvinto.player;

import androidx.annotation.Nullable;

/**
 * Makes an HLS channel's MPEG-TS pieces into one stream that plays straight
 * through, for pausing it (LivePause).
 *
 * Pieces of a live playlist follow on from each other, and are written as
 * they are. But where the playlist says EXT-X-DISCONTINUITY (an advert, an
 * encoder restarting), or where pieces were missed, the timestamps jump; the
 * player reads the file as one stream and stops at a jump backwards (seen
 * with the fake provider's looping clip). So from there on every PTS, DTS and
 * PCR is moved by however much makes the piece start where the last one
 * ended. A stream with no jumps is written byte for byte as it came.
 */
final class TsTimeline {

    static final int PACKET = 188;
    private static final int SYNC = 0x47;
    /** Timestamps are 33 bits of a 90 kHz clock, and wrap. */
    static final long WRAP = 1L << 33;
    private static final long CLOCK = 90_000L;
    /** A piece that starts this much before where the last ended is a jump back. */
    private static final long BACKWARDS = CLOCK;

    /** Added to every timestamp from the last jump on, modulo WRAP. */
    private long offset = 0L;
    /** Where the next piece should start, after offset; -1 before the first. */
    private long expected = -1L;

    /**
     * The piece ready to append: from its first TS packet, whole packets
     * only, its timestamps carried on from the last piece's where they jump.
     * Null when it is not MPEG-TS at all.
     *
     * @param jumped the playlist said EXT-X-DISCONTINUITY, or pieces were missed
     */
    @Nullable
    byte[] fit(byte[] data, int length, double seconds, boolean jumped) {
        int start = syncStart(data, length);
        if (start < 0) {
            return null;
        }
        int whole = (length - start) / PACKET * PACKET;
        if (whole == 0) {
            return null;
        }
        byte[] piece = new byte[whole];
        System.arraycopy(data, start, piece, 0, whole);
        long first = firstPts(piece);
        if (first >= 0L) {
            if (expected >= 0L) {
                long gap = signed((first + offset) - expected);
                // Ahead by more than a piece and a half: pieces were missed.
                long ahead = (long) (CLOCK * (1.5 * Math.max(seconds, 1.0) + 1.0));
                if (jumped || gap < -BACKWARDS || gap > ahead) {
                    offset = mod(expected - first);
                }
            }
            expected = mod(first + offset + Math.round(seconds * CLOCK));
            if (offset != 0L) {
                shift(piece, offset);
            }
        }
        return piece;
    }

    /** Where the first of three packets in a row starts (or one that runs to the end); -1 if none. */
    static int syncStart(byte[] data, int length) {
        for (int i = 0; i + PACKET <= length && i < 64 * PACKET; i++) {
            if ((data[i] & 0xFF) == SYNC
                && (i + PACKET >= length || (data[i + PACKET] & 0xFF) == SYNC)
                && (i + 2 * PACKET >= length || (data[i + 2 * PACKET] & 0xFF) == SYNC)) {
                return i;
            }
        }
        return -1;
    }

    /** The first PTS in these whole packets; -1 when there is none. */
    static long firstPts(byte[] packets) {
        for (int at = 0; at + PACKET <= packets.length; at += PACKET) {
            int pes = pesStart(packets, at);
            if (pes >= 0 && (packets[pes + 7] & 0x80) != 0) {
                return readStamp(packets, pes + 9);
            }
        }
        return -1L;
    }

    /** Moves every timestamp in these whole packets on by this much. */
    static void shift(byte[] packets, long by) {
        for (int at = 0; at + PACKET <= packets.length; at += PACKET) {
            if ((packets[at] & 0xFF) != SYNC) {
                continue;
            }
            int control = (packets[at + 3] >> 4) & 0x3;
            if ((control & 0x2) != 0) {
                int adaptation = packets[at + 4] & 0xFF;
                if (adaptation >= 7 && (packets[at + 5] & 0x10) != 0) {
                    int pcr = at + 6;
                    long base = ((long) (packets[pcr] & 0xFF) << 25) | ((packets[pcr + 1] & 0xFF) << 17)
                        | ((packets[pcr + 2] & 0xFF) << 9) | ((packets[pcr + 3] & 0xFF) << 1) | ((packets[pcr + 4] & 0xFF) >> 7);
                    base = mod(base + by);
                    packets[pcr] = (byte) (base >> 25);
                    packets[pcr + 1] = (byte) (base >> 17);
                    packets[pcr + 2] = (byte) (base >> 9);
                    packets[pcr + 3] = (byte) (base >> 1);
                    packets[pcr + 4] = (byte) (((base & 1) << 7) | (packets[pcr + 4] & 0x7F));
                }
            }
            int pes = pesStart(packets, at);
            if (pes < 0) {
                continue;
            }
            int flags = (packets[pes + 7] >> 6) & 0x3;
            if ((flags & 0x2) != 0) {
                writeStamp(packets, pes + 9, mod(readStamp(packets, pes + 9) + by));
            }
            if (flags == 0x3) {
                writeStamp(packets, pes + 14, mod(readStamp(packets, pes + 14) + by));
            }
        }
    }

    /**
     * Where a PES header with timestamps starts in the packet at this place:
     * a packet that starts a unit, of a stream that has the optional header,
     * with all of it inside the packet. -1 otherwise.
     */
    private static int pesStart(byte[] packets, int at) {
        if ((packets[at] & 0xFF) != SYNC || (packets[at + 1] & 0x40) == 0) {
            return -1;
        }
        int control = (packets[at + 3] >> 4) & 0x3;
        if ((control & 0x1) == 0) {
            return -1;
        }
        int payload = at + 4 + ((control & 0x2) != 0 ? 1 + (packets[at + 4] & 0xFF) : 0);
        if (payload + 19 > at + PACKET) {
            return -1;
        }
        if (packets[payload] != 0 || packets[payload + 1] != 0 || packets[payload + 2] != 1) {
            return -1;
        }
        int stream = packets[payload + 3] & 0xFF;
        boolean plain = stream == 0xBC || stream == 0xBE || stream == 0xBF || stream == 0xF0 || stream == 0xF1
            || stream == 0xFF || stream == 0xF2 || stream == 0xF8;
        return plain ? -1 : payload;
    }

    static long readStamp(byte[] b, int at) {
        return ((long) ((b[at] >> 1) & 0x07) << 30) | ((b[at + 1] & 0xFF) << 22) | (((b[at + 2] & 0xFF) >> 1) << 15)
            | ((b[at + 3] & 0xFF) << 7) | ((b[at + 4] & 0xFF) >> 1);
    }

    static void writeStamp(byte[] b, int at, long stamp) {
        b[at] = (byte) ((b[at] & 0xF0) | ((stamp >> 29) & 0x0E) | 1);
        b[at + 1] = (byte) (stamp >> 22);
        b[at + 2] = (byte) (((stamp >> 14) & 0xFE) | 1);
        b[at + 3] = (byte) (stamp >> 7);
        b[at + 4] = (byte) (((stamp << 1) & 0xFE) | 1);
    }

    private static long mod(long stamp) {
        return ((stamp % WRAP) + WRAP) % WRAP;
    }

    /** A difference of two timestamps, either way round the wrap. */
    private static long signed(long difference) {
        long d = mod(difference);
        return d >= WRAP / 2 ? d - WRAP : d;
    }
}
