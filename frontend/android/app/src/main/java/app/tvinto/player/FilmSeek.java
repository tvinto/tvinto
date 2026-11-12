package app.tvinto.player;

/**
 * Where a seek is going, and how the times around it are written.
 *
 * Design board PL-TV-5b: each press moves a target, not the picture. Holding
 * steps up from 10 s to 30 s after about two seconds and to 60 s after about
 * four -- the same feel as holding Up or Down in the guide -- and the picture
 * jumps once, when the presses stop. The opposite direction subtracts from the
 * target rather than starting again, so overshooting costs one press.
 *
 * Nothing Android in here, so the arithmetic is tested on its own
 * (FilmSeekTest).
 */
final class FilmSeek {

    /** The picture jumps this long after the last press. */
    static final long COMMIT_AFTER_MS = 700L;
    /** And the strip goes this long after that. */
    static final long HIDE_AFTER_MS = 1500L;

    private boolean active = false;
    private long from = 0L;
    private long target = 0L;
    private long step = 10_000L;

    /** The size of each press, for a key held this long. */
    static long stepFor(long heldMs) {
        if (heldMs >= 4000L) {
            return 60_000L;
        }
        if (heldMs >= 2000L) {
            return 30_000L;
        }
        return 10_000L;
    }

    boolean isActive() {
        return active;
    }

    /**
     * One press: forward when direction is positive. Starts from `position`
     * when no seek is under way. The target stays inside the film, short of its
     * very end, so a long hold forward does not finish it by accident.
     */
    void press(int direction, long heldMs, long position, long duration) {
        if (!active) {
            active = true;
            from = Math.max(0L, position);
            target = from;
        }
        step = stepFor(heldMs);
        long moved = target + (direction >= 0 ? step : -step);
        long last = duration > 0 ? Math.max(0L, duration - 5_000L) : Long.MAX_VALUE;
        target = Math.max(0L, Math.min(last, moved));
    }

    /** Dragging a bar: straight to a place, from where it started. */
    void dragTo(long position, long start) {
        if (!active) {
            active = true;
            from = Math.max(0L, start);
        }
        target = Math.max(0L, position);
    }

    long from() {
        return from;
    }

    long target() {
        return target;
    }

    long step() {
        return step;
    }

    /** Ends the seek: the target, for the player to go to. */
    long commit() {
        active = false;
        return target;
    }

    /** Back: the target snaps back to where it started. */
    void cancel() {
        active = false;
        target = from;
    }

    // --- Writing times -----------------------------------------------------------

    /** "1:12:40", always with the hours, as the boards write a position. */
    static String clock(long ms) {
        long seconds = Math.max(0L, ms) / 1000L;
        return String.format(java.util.Locale.ROOT, "%d:%02d:%02d", seconds / 3600, (seconds / 60) % 60, seconds % 60);
    }

    /** "−1:33:20": what is left. The minus is the typographic one. */
    static String remaining(long ms) {
        return "−" + clock(ms);
    }

    /** "+1:30", "−0:10", "+1:02:00": how far the target is from where the seek began. */
    static String offset(long ms) {
        String sign = ms < 0 ? "−" : "+";
        long seconds = Math.abs(ms) / 1000L;
        if (seconds >= 3600) {
            return sign + String.format(java.util.Locale.ROOT, "%d:%02d:%02d", seconds / 3600, (seconds / 60) % 60, seconds % 60);
        }
        return sign + String.format(java.util.Locale.ROOT, "%d:%02d", seconds / 60, seconds % 60);
    }

    /** "+30 s", as the phone's double-tap ripple says it. */
    static String tapOffset(long ms) {
        long seconds = Math.abs(ms) / 1000L;
        String sign = ms < 0 ? "−" : "+";
        if (seconds < 60) {
            return sign + seconds + " s";
        }
        return offset(ms);
    }

    /** "30 s steps", "1 min steps". */
    static String stepLabel(long stepMs) {
        long seconds = stepMs / 1000L;
        return seconds >= 60 ? Texts.t("seek.minSteps", seconds / 60) : Texts.t("seek.secondSteps", seconds);
    }

    /** "2 h 46 min", "46 min"; empty while the length is not known. */
    static String runtime(long ms) {
        if (ms <= 0) {
            return "";
        }
        long minutes = Math.round(ms / 60_000d);
        if (minutes < 60) {
            return Texts.t("length.minutes", minutes);
        }
        return Texts.t("length.hours", minutes / 60, minutes % 60);
    }
}
