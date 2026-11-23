package app.tvinto.player;

import android.os.Handler;

/**
 * A live channel that shows no picture in this long has failed, and is said
 * to have, rather than left black. On 23 November a channel at a dead address
 * stayed black for over two minutes while the player retried it, and the
 * failure appeared only once the viewer had given up and pressed Back. A slow
 * provider has been seen to take 9 to 15 s to answer (the HTTP timeouts in
 * PlayerActivity), so this is a little past that. The desktop waits the same
 * (frontend/electron/src/liveRecovery.ts).
 */
final class StartWatch {
    static final long TIMEOUT_MS = 20_000L;
    /** The failure's code, the same on every player: "no picture in 20 s". */
    static final String CODE = "no picture in " + (TIMEOUT_MS / 1000L) + " s";

    private final Handler handler;
    private final Runnable onTimeout;

    StartWatch(Handler handler, Runnable onTimeout) {
        this.handler = handler;
        this.onTimeout = onTimeout;
    }

    /** A live stream is opening: the time starts again. */
    void arm() {
        handler.removeCallbacks(onTimeout);
        handler.postDelayed(onTimeout, TIMEOUT_MS);
    }

    /** The picture came, the stream was stopped, or the player is closing. */
    void disarm() {
        handler.removeCallbacks(onTimeout);
    }
}
