package app.tvinto.player;

import androidx.annotation.Nullable;

import java.text.SimpleDateFormat;
import java.util.ArrayList;
import java.util.Date;
import java.util.List;
import java.util.Locale;

/**
 * The sleep timer: playing stops after a time
 * somebody chose, and the television's own power saving takes over.
 *
 * One timer for the run of the app, kept here rather than in a player screen,
 * so it goes on counting through a channel change, the next episode, and a
 * player closed and another opened. Nothing is stored: the app closing ends
 * it. SleepTimerPanel draws it and acts on it in whichever player is in
 * front. Nothing Android in here (SleepTimerTest).
 */
final class SleepTimer {

    /** The countdown panel shows for the last minute. */
    static final long WARNING_MS = 60_000L;
    /** The sound fades over the last ten seconds rather than cutting off. */
    static final long FADE_MS = 10_000L;
    /** What Keep watching adds. */
    static final long MORE_MS = 30 * 60_000L;
    /** The timed choices, in minutes. */
    static final int[] MINUTES = { 15, 30, 45, 60, 90, 120 };
    /** A programme ending sooner than this is not offered: the warning alone would be longer. */
    static final long SHORTEST_MS = 2 * 60_000L;

    enum Kind { OFF, MINUTES, PROGRAMME, ITEM }

    /** One row of the list. */
    static final class Choice {
        final Kind kind;
        /** For MINUTES. */
        final int minutes;
        /** For PROGRAMME: when it ends. */
        final long endsAt;
        /** For ITEM: an episode rather than a film. */
        final boolean episode;

        private Choice(Kind kind, int minutes, long endsAt, boolean episode) {
            this.kind = kind;
            this.minutes = minutes;
            this.endsAt = endsAt;
            this.episode = episode;
        }

        String label() {
            switch (kind) {
                case MINUTES:
                    return Texts.t("sleep.minutes", minutes);
                case PROGRAMME:
                    return Texts.t("sleep.programmeEnd", clock(endsAt));
                case ITEM:
                    return Texts.t(episode ? "sleep.episodeEnd" : "sleep.filmEnd");
                default:
                    return Texts.t("sleep.off");
            }
        }

        boolean same(Choice other) {
            return other != null && kind == other.kind && minutes == other.minutes && endsAt == other.endsAt;
        }
    }

    private static Kind kind = Kind.OFF;
    /** When it runs out, on the wall clock; 0 for OFF and ITEM. */
    private static long deadline = 0L;
    @Nullable
    private static Choice chosen = null;
    /** Told when the timer changes: the panel of the player in front. */
    @Nullable
    private static Runnable onChange = null;

    private SleepTimer() {}

    /**
     * What can be chosen now: Off, the times, and the end of what is on --
     * the programme on a channel with a guide, or the film or episode.
     */
    static List<Choice> choices(long now, long programmeEnd, @Nullable Boolean item) {
        List<Choice> list = new ArrayList<>();
        list.add(new Choice(Kind.OFF, 0, 0L, false));
        for (int minutes : MINUTES) {
            list.add(new Choice(Kind.MINUTES, minutes, 0L, false));
        }
        if (programmeEnd - now >= SHORTEST_MS) {
            list.add(new Choice(Kind.PROGRAMME, 0, programmeEnd, false));
        }
        if (item != null) {
            list.add(new Choice(Kind.ITEM, 0, 0L, item));
        }
        return list;
    }

    static void choose(Choice choice, long now) {
        kind = choice.kind;
        chosen = choice.kind == Kind.OFF ? null : choice;
        switch (choice.kind) {
            case MINUTES:
                deadline = now + choice.minutes * 60_000L;
                break;
            case PROGRAMME:
                deadline = choice.endsAt;
                break;
            default:
                deadline = 0L;
        }
        changed();
    }

    static void cancel() {
        kind = Kind.OFF;
        deadline = 0L;
        chosen = null;
        changed();
    }

    /** Somebody is awake after all: half an hour more, from whenever it would have stopped. */
    static void keepWatching(long now) {
        if (kind != Kind.MINUTES && kind != Kind.PROGRAMME) {
            return;
        }
        deadline = Math.max(deadline, now) + MORE_MS;
        kind = Kind.MINUTES;
        chosen = null;
        changed();
    }

    /** Whether it is set: counting, or waiting for the end of what plays. */
    static boolean isOn(long now) {
        return kind == Kind.ITEM || (deadline > 0L && deadline > now);
    }

    /** Whether it stops at the end of the film or episode rather than at a time. */
    static boolean endsWithItem() {
        return kind == Kind.ITEM;
    }

    /** A timed one that has run out: the player in front stops. */
    static boolean ranOut(long now) {
        return (kind == Kind.MINUTES || kind == Kind.PROGRAMME) && deadline <= now;
    }

    /** Until it runs out; 0 for none or for the end of what plays. */
    static long remainingMs(long now) {
        return kind == Kind.MINUTES || kind == Kind.PROGRAMME ? Math.max(0L, deadline - now) : 0L;
    }

    /** The row that is in use, or null when it is off. */
    @Nullable
    static Choice chosen() {
        return chosen;
    }

    /** What a running timer says beside its name: "23 min left", "Until the end"; null when off. */
    @Nullable
    static String summary(long now) {
        if (!isOn(now)) {
            return null;
        }
        if (kind == Kind.ITEM) {
            return Texts.t("sleep.untilEnd");
        }
        long minutes = (remainingMs(now) + 59_999L) / 60_000L;
        return Texts.t("sleep.left", Math.max(1L, minutes));
    }

    /** The countdown's time: "0:59". */
    static String countdown(long remainingMs) {
        long seconds = Math.max(0L, (remainingMs + 999L) / 1000L);
        return (seconds / 60) + ":" + (seconds % 60 < 10 ? "0" : "") + (seconds % 60);
    }

    /** The volume for the last seconds: whole until the fade, then down to nothing. */
    static float volume(long remainingMs) {
        if (remainingMs >= FADE_MS) {
            return 1f;
        }
        return Math.max(0f, remainingMs / (float) FADE_MS);
    }

    static void listen(Runnable listener) {
        onChange = listener;
    }

    /** Only the listener that is still the one: a player closing must not deafen the next. */
    static void stopListening(Runnable listener) {
        if (onChange == listener) {
            onChange = null;
        }
    }

    private static void changed() {
        Runnable listener = onChange;
        if (listener != null) {
            listener.run();
        }
    }

    private static String clock(long ms) {
        return new SimpleDateFormat("HH:mm", Locale.getDefault()).format(new Date(ms));
    }
}
