package app.tvinto.player;

import androidx.annotation.Nullable;

import java.util.List;

/**
 * What the film controls (FilmControls) need of a player.
 *
 * Media3 and VLC each supply one, so the controls, the seek strip and the track
 * rail are the same whichever of them is doing the video -- design section 5b
 * draws one set for both. Everything is called on the main thread.
 */
interface FilmPlayback {

    /** Milliseconds from the start. */
    long positionMs();

    /** Milliseconds, or 0 while it is not known. */
    long durationMs();

    boolean isPlaying();

    void setPlaying(boolean playing);

    void seekTo(long positionMs);

    /** The audio tracks, the one in use marked. Empty when there is only one, or none yet. */
    List<Track> audioTracks();

    /** The subtitle tracks, with "Off" first. Empty when the stream has none. */
    List<Track> subtitleTracks();

    void choose(Track track);

    /** How much later than the stream says its subtitles are shown, in milliseconds; less than 0 is earlier. */
    long subtitleDelayMs();

    void setSubtitleDelay(long ms);

    /** The shape the picture is drawn in (PictureMode). */
    String pictureMode();

    void setPictureMode(String mode);

    /** How fast it plays: 1 is normal (PX-TV-4). */
    float speed();

    void setSpeed(float speed);

    /** Leaves the player, as Back does when nothing is drawn over the video. */
    void close();

    /**
     * Raises the subtitles over whatever is drawn along the bottom -- the
     * controls, a channel's banner -- and puts them back after; they were
     * drawn underneath it (a user's Top Gear, 31 October). By a share of
     * the screen's height, as tall as what is drawn there; 0 puts them back.
     */
    void liftSubtitles(float share);

    /** Stops the stream and closes its connection, keeping the player and its surface. */
    void stop();

    /** Opens another address in the same player: the next episode. */
    void open(String url);

    /** One track, as the rail lists it. */
    final class Track {
        static final int AUDIO = 1;
        static final int SUBTITLES = 2;
        /** Not a track: the subtitles' timing, a row of the rail's own (SubtitleDelay). */
        static final int TIMING = 3;
        /** Not a track: a shape for the picture, its PictureMode the handle. */
        static final int PICTURE = 4;
        /** Not a track: "37 unlabelled tracks", which opens to them (TrackFold); the kind it folds is the handle. */
        static final int FOLD = 5;

        final int kind;
        final String label;
        final boolean inUse;
        /** Whatever the player needs to select it again; null for subtitles "Off". */
        @Nullable
        final Object handle;
        /** The file says neither its language nor a name: "Subtitles 11". */
        final boolean unlabelled;
        /** The file's forced flag: only the signs and the foreign lines. */
        final boolean forced;

        Track(int kind, String label, boolean inUse, @Nullable Object handle) {
            this(kind, label, inUse, handle, false, false);
        }

        Track(int kind, String label, boolean inUse, @Nullable Object handle, boolean unlabelled, boolean forced) {
            this.kind = kind;
            this.label = label;
            this.inUse = inUse;
            this.handle = handle;
            this.unlabelled = unlabelled;
            this.forced = forced;
        }

        boolean isOff() {
            return kind == SUBTITLES && handle == null;
        }
    }
}
