package app.tvinto.player;

import java.util.ArrayList;
import java.util.List;

/**
 * A track list as the panels first show it, as the desktop does
 * (desktop-video.service.ts, `foldUnlabelled`): a file with 38 subtitle tracks
 * that say nothing about themselves is 38 rows reading "Subtitles 1" to
 * "Subtitles 38", which helps nobody choose (The Rings of Power, 22 November).
 * Past FOLD_AT of them they fold into one row, "37 unlabelled tracks", that
 * opens to the numbered list. The labelled ones stay, and so do a forced one,
 * the one in use and "Off". Nothing Android in here (TrackFoldTest).
 */
final class TrackFold {

    /** More unlabelled tracks than this and the list folds them into one row. */
    static final int FOLD_AT = 6;

    private TrackFold() {}

    /** Whether a track goes into the fold, when the list folds at all. */
    private static boolean folds(FilmPlayback.Track track) {
        return track.unlabelled && !track.forced && !track.inUse;
    }

    /**
     * The handle of the first track a fold holds, for focus to go to once it
     * opens -- where the fold's own row was, as on the desktop. Null when
     * nothing folds.
     */
    @androidx.annotation.Nullable
    static Object firstFolded(List<FilmPlayback.Track> tracks) {
        for (FilmPlayback.Track track : tracks) {
            if (folds(track)) {
                return track.handle;
            }
        }
        return null;
    }

    static List<FilmPlayback.Track> fold(List<FilmPlayback.Track> tracks, boolean unfolded) {
        int unlabelled = 0;
        for (FilmPlayback.Track track : tracks) {
            if (track.unlabelled) {
                unlabelled++;
            }
        }
        if (unfolded || unlabelled <= FOLD_AT) {
            return tracks;
        }
        List<FilmPlayback.Track> shown = new ArrayList<>();
        int kind = FilmPlayback.Track.SUBTITLES;
        for (FilmPlayback.Track track : tracks) {
            kind = track.kind;
            if (!folds(track)) {
                shown.add(track);
            }
        }
        int hidden = tracks.size() - shown.size();
        shown.add(new FilmPlayback.Track(FilmPlayback.Track.FOLD, Texts.unlabelled(hidden), false, kind));
        return shown;
    }
}
