package app.tvinto.player;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.regex.Pattern;

/**
 * The stretches of a film or an episode the player offers to skip: its intro,
 * a recap, the credits. Nothing Android in here (SkipTimesTest).
 *
 * They come from two places. The web app hands over what TheIntroDB knows
 * (shared/tmdb/introdb.ts, already checked for plausibility there). And some
 * files carry chapters named for what they are, which are right for that very
 * file and so win when there are any.
 */
final class SkipTimes {

    static final String INTRO = "intro";
    static final String RECAP = "recap";
    static final String CREDITS = "credits";

    /** A database's times are for the original release; a provider's copy may start a little later. */
    static final long SHOWN_EARLY_MS = 2_000L;
    /** And the button goes a moment before the end, so pressing it never lands back where it was. */
    static final long GONE_BEFORE_END_MS = 1_500L;

    static final class Skip {
        final String kind;
        final long startMs;
        final long endMs;

        Skip(String kind, long startMs, long endMs) {
            this.kind = kind;
            this.startMs = startMs;
            this.endMs = endMs;
        }
    }

    private final List<Skip> skips;

    SkipTimes(List<Skip> skips) {
        List<Skip> sorted = new ArrayList<>(skips);
        Collections.sort(sorted, (a, b) -> Long.compare(a.startMs, b.startMs));
        this.skips = Collections.unmodifiableList(sorted);
    }

    static SkipTimes none() {
        return new SkipTimes(new ArrayList<>());
    }

    boolean isEmpty() {
        return skips.isEmpty();
    }

    /** The intro or recap playing at this position, to offer to skip, or null. */
    Skip at(long positionMs) {
        for (Skip skip : skips) {
            if (CREDITS.equals(skip.kind)) {
                continue;
            }
            if (positionMs >= skip.startMs - SHOWN_EARLY_MS && positionMs < skip.endMs - GONE_BEFORE_END_MS) {
                return skip;
            }
        }
        return null;
    }

    /** Where the credits start, or -1 when that is not known. */
    long creditsStartMs() {
        for (Skip skip : skips) {
            if (CREDITS.equals(skip.kind)) {
                return skip.startMs;
            }
        }
        return -1L;
    }

    // --- Chapters ------------------------------------------------------------------

    /** A chapter as the file names it. `endMs` is -1 when the file gives none: the next chapter's start, or the end. */
    static final class Chapter {
        final String title;
        final long startMs;
        final long endMs;

        Chapter(String title, long startMs, long endMs) {
            this.title = title == null ? "" : title;
            this.startMs = startMs;
            this.endMs = endMs;
        }
    }

    // The names chapters go by, as StreamVault's player reads them.
    private static final Pattern RECAP_NAME = Pattern.compile("\\b(?:recap|previously on)\\b");
    private static final Pattern INTRO_NAME = Pattern.compile(
        "\\b(?:intro(?:duction)?|opening|opening credits|title sequence|theme song?)\\b");
    private static final Pattern CREDITS_NAME = Pattern.compile("\\bcredits?\\b|\\boutro\\b");
    private static final Pattern POST_CREDITS = Pattern.compile("\\bpost[- ]credits?\\b");
    private static final Pattern NOT_END_CREDITS = Pattern.compile("\\bopening\\b.*\\bcredits?\\b|\\bpost[- ]credits?\\b");
    private static final Pattern END_CREDITS_NAME = Pattern.compile(
        "\\b(?:end|closing)\\s+credits?\\b|\\bcredit\\s+roll\\b|\\boutro\\b");

    /**
     * The skips a file's chapters name. Credits only when named as the end's,
     * or named credits and in the last 40 % -- never "opening credits" or a
     * "post-credits scene", which is the part people stay for.
     */
    static SkipTimes fromChapters(List<Chapter> chapters, long durationMs) {
        List<Chapter> sorted = new ArrayList<>(chapters);
        Collections.sort(sorted, (a, b) -> Long.compare(a.startMs, b.startMs));
        List<Skip> found = new ArrayList<>();
        boolean intro = false;
        for (int i = 0; i < sorted.size(); i++) {
            Chapter chapter = sorted.get(i);
            long end = chapter.endMs > chapter.startMs ? chapter.endMs
                : i + 1 < sorted.size() ? sorted.get(i + 1).startMs : durationMs;
            if (end <= chapter.startMs) {
                continue;
            }
            String name = chapter.title.toLowerCase(Locale.ROOT);
            if (RECAP_NAME.matcher(name).find()) {
                found.add(new Skip(RECAP, chapter.startMs, end));
            } else if (CREDITS_NAME.matcher(name).find() && !NOT_END_CREDITS.matcher(name).find()
                && (END_CREDITS_NAME.matcher(name).find() || (durationMs > 0 && chapter.startMs >= durationMs * 0.6))) {
                found.add(new Skip(CREDITS, chapter.startMs, end));
            } else if (!intro && INTRO_NAME.matcher(name).find() && !POST_CREDITS.matcher(name).find()) {
                found.add(new Skip(INTRO, chapter.startMs, end));
                intro = true;
            }
        }
        return new SkipTimes(found);
    }
}
