package app.tvinto.player;

import androidx.annotation.Nullable;

/**
 * Where a player leaves what it did, for the plugin to collect.
 *
 * An Activity cannot hand a value to a Capacitor plugin directly -- they have
 * no reference to one another, and the plugin outlives the Activity. So it is
 * left here and read once, which also covers the ways an Activity ends without
 * ever setting a result: the back key, and Android reclaiming memory.
 *
 * Shared between the two players rather than owned by either, because which one
 * ran is not something the plugin should have to know about.
 */
public final class PlaybackReports {

    private static volatile PlaybackReport last = null;
    private static volatile TrackReport chosen = null;

    private PlaybackReports() {}

    /** Records a position reached during ordinary playback. */
    public static void position(long positionSeconds, long durationSeconds) {
        PlaybackReport held = last;

        // A recorded failure outranks any later position. Finishing an Activity
        // runs onPause and then onDestroy, and both report a position -- so
        // without this every failure was overwritten twice before anything
        // could read it, and arrived as an ordinary stop.
        if (held != null && held.errorCode != null) {
            return;
        }

        last = new PlaybackReport(positionSeconds, durationSeconds, null);
    }

    /** Records that playback stopped because it could not go on. */
    public static void failure(long positionSeconds, String errorCode) {
        last = new PlaybackReport(positionSeconds, 0L, errorCode);
    }

    /**
     * Records which tracks are actually playing.
     *
     * Kept apart from the position, because they change on their own schedule:
     * a viewer turning subtitles on half way through has said something the
     * position knows nothing about, and the position is rewritten every few
     * seconds. Read by the plugin at the end, so what survives is the last
     * thing that was true.
     *
     * Languages rather than track numbers, which mean nothing to another
     * player. Null for a language nobody declared -- which is not the same as
     * no subtitles, and is why `subtitlesEnabled` is separate.
     */
    public static void tracks(
        @Nullable String audioLanguage,
        @Nullable String subtitleLanguage,
        @Nullable String audioTitle,
        @Nullable String subtitleTitle,
        boolean subtitlesEnabled
    ) {
        chosen = new TrackReport(audioLanguage, subtitleLanguage, audioTitle, subtitleTitle, subtitlesEnabled);
    }

    /** Reads and clears the track choice, if a player made one. */
    @Nullable
    public static TrackReport takeTracks() {
        TrackReport held = chosen;
        chosen = null;
        return held;
    }

    /** What was playing, as far as the player could say. */
    public static final class TrackReport {
        @Nullable
        public final String audioLanguage;
        @Nullable
        public final String subtitleLanguage;
        /**
         * The track's own name, which is the only thing separating three
         * tracks that all declare the same language.
         */
        @Nullable
        public final String audioTitle;
        @Nullable
        public final String subtitleTitle;
        public final boolean subtitlesEnabled;

        TrackReport(
            @Nullable String audioLanguage,
            @Nullable String subtitleLanguage,
            @Nullable String audioTitle,
            @Nullable String subtitleTitle,
            boolean subtitlesEnabled
        ) {
            this.audioLanguage = audioLanguage;
            this.subtitleLanguage = subtitleLanguage;
            this.audioTitle = audioTitle;
            this.subtitleTitle = subtitleTitle;
            this.subtitlesEnabled = subtitlesEnabled;
        }
    }

    /** Reads and clears, so one report is never collected twice. */
    @Nullable
    public static PlaybackReport take() {
        PlaybackReport held = last;
        last = null;
        return held;
    }

    /** Forgotten before a player starts, so it cannot inherit the last one's. */
    public static void clear() {
        last = null;
        chosen = null;
        channelStep = null;
        item = null;
    }

    /** The channel on screen when the player closed, after any switching inside it. */
    private static volatile String item = null;

    public static void item(@Nullable String itemId) {
        item = itemId;
    }

    /** The item on screen now, left in place for the end. */
    @Nullable
    public static String currentItem() {
        return item;
    }

    @Nullable
    public static String takeItem() {
        String held = item;
        item = null;
        return held;
    }

    /** Which way the viewer asked to change channel, if the player closed for that. See ChannelKeys. */
    private static volatile String channelStep = null;

    public static void channelStep(String step) {
        channelStep = step;
    }

    @Nullable
    public static String takeChannelStep() {
        String held = channelStep;
        channelStep = null;
        return held;
    }

    /** Where the playhead was, how long the thing is, and what went wrong. Seconds. */
    public static final class PlaybackReport {
        public final long positionSeconds;
        public final long durationSeconds;
        /** Null when playback ended for any reason other than a failure. */
        @Nullable
        public final String errorCode;

        PlaybackReport(long positionSeconds, long durationSeconds, @Nullable String errorCode) {
            this.positionSeconds = positionSeconds;
            this.durationSeconds = durationSeconds;
            this.errorCode = errorCode;
        }
    }
}
