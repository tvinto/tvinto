package app.tvinto.player;

/**
 * When each part of a paused channel's file arrived (LivePause), for stepping
 * back and forward within it.
 *
 * The provider sends a live channel as it happens, so the moment a byte
 * arrived is the moment it was live: a point in the file a minute after
 * another is a minute later in the programme, and playing from a byte that
 * arrived three minutes ago is three minutes behind live. The file itself has
 * no index Media3 can seek by while it grows, so this is it: every quarter of
 * a second, how much had been written.
 *
 * Times are the device's elapsed-realtime clock, in milliseconds.
 */
final class PauseIndex {

    /** One MPEG-TS packet: a place to start reading from is a whole number of them in. */
    static final int PACKET = 188;
    /** How often a place is noted. */
    static final long EVERY_MS = 250L;

    /** A place in the file, and when what is there arrived. */
    static final class Spot {
        final long offset;
        final long arrived;

        Spot(long offset, long arrived) {
            this.offset = offset;
            this.arrived = arrived;
        }
    }

    private long[] times = new long[512];
    private long[] offsets = new long[512];
    private int count = 0;
    private long latest = -1L;

    /** That this much had been written by now: what is written next arrives now. */
    synchronized void wrote(long now, long bytes) {
        latest = now;
        if (count > 0 && (now - times[count - 1] < EVERY_MS || bytes == offsets[count - 1])) {
            return;
        }
        if (count == times.length) {
            times = java.util.Arrays.copyOf(times, count * 2);
            offsets = java.util.Arrays.copyOf(offsets, count * 2);
        }
        times[count] = now;
        offsets[count] = bytes;
        count++;
    }

    /** When the start of the file arrived; -1 before anything did. */
    synchronized long first() {
        return count == 0 ? -1L : times[0];
    }

    /** When the most recent of it arrived; -1 before anything did. */
    synchronized long last() {
        return latest;
    }

    /**
     * The place to play from for what was live at this moment: the last one
     * noted at or before it, at a packet's start. Before the start, the start.
     * Null before anything arrived.
     */
    synchronized Spot at(long arrived) {
        if (count == 0) {
            return null;
        }
        int low = 0;
        int high = count - 1;
        while (low < high) {
            int middle = (low + high + 1) >>> 1;
            if (times[middle] <= arrived) {
                low = middle;
            } else {
                high = middle - 1;
            }
        }
        long offset = offsets[low];
        return new Spot(offset - offset % PACKET, times[low]);
    }
}
