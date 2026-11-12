package app.tvinto.player;

import androidx.annotation.Nullable;

import java.net.MalformedURLException;
import java.net.URL;
import java.util.ArrayList;
import java.util.Collections;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * An HLS playlist as far as pausing a live channel needs it (LivePause): a
 * master playlist's variants, or a media playlist's pieces in order.
 *
 * Only pieces that are MPEG-TS, whole and unencrypted can be written one
 * after another into one file. A playlist of fMP4 pieces (EXT-X-MAP), of
 * byte ranges, or encrypted (EXT-X-KEY) says so in {@link #unsupported()}, and
 * such a channel stays unpausable.
 */
final class HlsPlaylist {

    /** One of a master playlist's variants. */
    static final class Variant {
        final String uri;
        final long bandwidth;
        @Nullable
        final String audioGroup;

        Variant(String uri, long bandwidth, @Nullable String audioGroup) {
            this.uri = uri;
            this.bandwidth = bandwidth;
            this.audioGroup = audioGroup;
        }
    }

    /** One piece of a media playlist. */
    static final class Segment {
        final long sequence;
        final double seconds;
        final String uri;
        /** Whether EXT-X-DISCONTINUITY came before it: its timestamps need not follow on. */
        final boolean discontinuity;

        Segment(long sequence, double seconds, String uri, boolean discontinuity) {
            this.sequence = sequence;
            this.seconds = seconds;
            this.uri = uri;
            this.discontinuity = discontinuity;
        }
    }

    final boolean master;
    final List<Variant> variants;
    /** Audio groups with a rendition of their own (a URI): a variant in one carries no sound of its own to write. */
    final Set<String> separateAudio;
    final double targetSeconds;
    final long mediaSequence;
    final List<Segment> segments;
    final boolean ended;
    /** HOLD-BACK from EXT-X-SERVER-CONTROL; -1 when not given. */
    final double holdBackSeconds;
    @Nullable
    private final String unsupported;

    private HlsPlaylist(Builder b) {
        this.master = !b.variants.isEmpty();
        this.variants = Collections.unmodifiableList(b.variants);
        this.separateAudio = Collections.unmodifiableSet(b.separateAudio);
        this.targetSeconds = b.targetSeconds;
        this.mediaSequence = b.mediaSequence;
        this.segments = Collections.unmodifiableList(b.segments);
        this.ended = b.ended;
        this.holdBackSeconds = b.holdBackSeconds;
        this.unsupported = b.unsupported;
    }

    /** Why the pieces cannot be written into one TS file; null when they can. */
    @Nullable
    String unsupported() {
        return unsupported;
    }

    /** Whether this text is an HLS playlist at all. */
    static boolean looksLikePlaylist(@Nullable String text) {
        return text != null && text.replace("﻿", "").trim().startsWith("#EXTM3U");
    }

    /** Reads a playlist, its addresses resolved against where it came from. */
    static HlsPlaylist parse(String text, String base) {
        Builder b = new Builder();
        String[] lines = text.replace("﻿", "").split("\r?\n|\r");
        double nextSeconds = -1;
        boolean nextDiscontinuity = false;
        long nextBandwidth = -1;
        String nextAudio = null;
        boolean nextIsVariant = false;
        long sequence = 0;
        boolean sequenceSet = false;
        for (String raw : lines) {
            String line = raw.trim();
            if (line.isEmpty()) {
                continue;
            }
            if (!line.startsWith("#")) {
                if (nextIsVariant) {
                    b.variants.add(new Variant(resolve(base, line), nextBandwidth, nextAudio));
                    nextIsVariant = false;
                } else if (nextSeconds >= 0) {
                    if (!sequenceSet) {
                        sequence = b.mediaSequence;
                        sequenceSet = true;
                    }
                    b.segments.add(new Segment(sequence++, nextSeconds, resolve(base, line), nextDiscontinuity));
                    nextSeconds = -1;
                    nextDiscontinuity = false;
                }
                continue;
            }
            String tag = tagName(line);
            String value = line.length() > tag.length() + 1 ? line.substring(tag.length() + 1) : "";
            switch (tag) {
                case "#EXT-X-STREAM-INF": {
                    Map<String, String> attributes = attributes(value);
                    nextBandwidth = number(attributes.get("BANDWIDTH"), -1L);
                    nextAudio = attributes.get("AUDIO");
                    nextIsVariant = true;
                    break;
                }
                case "#EXT-X-MEDIA": {
                    Map<String, String> attributes = attributes(value);
                    if ("AUDIO".equalsIgnoreCase(attributes.get("TYPE")) && attributes.get("URI") != null && attributes.get("GROUP-ID") != null) {
                        b.separateAudio.add(attributes.get("GROUP-ID"));
                    }
                    break;
                }
                case "#EXT-X-TARGETDURATION":
                    b.targetSeconds = decimal(value, b.targetSeconds);
                    break;
                case "#EXT-X-MEDIA-SEQUENCE":
                    b.mediaSequence = number(value, 0L);
                    break;
                case "#EXTINF": {
                    int comma = value.indexOf(',');
                    nextSeconds = Math.max(0.0, decimal(comma >= 0 ? value.substring(0, comma) : value, 0.0));
                    break;
                }
                case "#EXT-X-DISCONTINUITY":
                    nextDiscontinuity = true;
                    break;
                case "#EXT-X-ENDLIST":
                    b.ended = true;
                    break;
                case "#EXT-X-SERVER-CONTROL":
                    b.holdBackSeconds = decimal(attributes(value).get("HOLD-BACK"), -1.0);
                    break;
                case "#EXT-X-MAP":
                    b.unsupported = "fragmented MP4 pieces";
                    break;
                case "#EXT-X-BYTERANGE":
                    b.unsupported = "pieces given as byte ranges";
                    break;
                case "#EXT-X-KEY": {
                    String method = attributes(value).get("METHOD");
                    if (method != null && !"NONE".equalsIgnoreCase(method)) {
                        b.unsupported = "encrypted pieces";
                    }
                    break;
                }
                default:
                    break;
            }
        }
        if (b.targetSeconds <= 0) {
            double longest = 0;
            for (Segment segment : b.segments) {
                longest = Math.max(longest, segment.seconds);
            }
            b.targetSeconds = longest > 0 ? Math.ceil(longest) : 6.0;
        }
        return new HlsPlaylist(b);
    }

    /**
     * The variant to write: the one the player was playing (its playlist's
     * address, or else its bandwidth), or the one of the highest bandwidth.
     * Null when there is none, or when it has no sound of its own.
     */
    @Nullable
    Variant pick(@Nullable String playing, long playingBandwidth) {
        Variant chosen = null;
        for (Variant variant : variants) {
            if (playing != null && playing.equals(variant.uri)) {
                chosen = variant;
                break;
            }
        }
        if (chosen == null && playingBandwidth > 0) {
            for (Variant variant : variants) {
                if (variant.bandwidth == playingBandwidth && !separate(variant)) {
                    chosen = variant;
                    break;
                }
            }
        }
        if (chosen == null) {
            for (Variant variant : variants) {
                if (!separate(variant) && (chosen == null || variant.bandwidth > chosen.bandwidth)) {
                    chosen = variant;
                }
            }
        }
        return chosen == null || separate(chosen) ? null : chosen;
    }

    private boolean separate(Variant variant) {
        return variant.audioGroup != null && separateAudio.contains(variant.audioGroup);
    }

    /**
     * Where to start writing: the piece the player was playing, when the
     * playlist still has it; otherwise as far back from the newest as a player
     * starts a live playlist (HOLD-BACK, or three target durations).
     * The sequence number of that piece; -1 when there are none.
     */
    long startSequence(long playing) {
        if (segments.isEmpty()) {
            return -1L;
        }
        long first = segments.get(0).sequence;
        long last = segments.get(segments.size() - 1).sequence;
        if (playing >= first && playing <= last) {
            return playing;
        }
        double back = holdBackSeconds > 0 ? holdBackSeconds : 3.0 * targetSeconds;
        double behind = 0;
        for (int i = segments.size() - 1; i >= 0; i--) {
            behind += segments.get(i).seconds;
            if (behind >= back) {
                return segments.get(i).sequence;
            }
        }
        return first;
    }

    private static String tagName(String line) {
        int colon = line.indexOf(':');
        return (colon < 0 ? line : line.substring(0, colon)).toUpperCase(Locale.ROOT);
    }

    private static final Pattern ATTRIBUTE = Pattern.compile("([A-Z0-9-]+)=(\"[^\"]*\"|[^,]*)", Pattern.CASE_INSENSITIVE);

    static Map<String, String> attributes(String list) {
        Map<String, String> found = new HashMap<>();
        Matcher attribute = ATTRIBUTE.matcher(list);
        while (attribute.find()) {
            String value = attribute.group(2).trim();
            if (value.length() >= 2 && value.startsWith("\"") && value.endsWith("\"")) {
                value = value.substring(1, value.length() - 1);
            }
            found.put(attribute.group(1).toUpperCase(Locale.ROOT), value);
        }
        return found;
    }

    private static long number(@Nullable String text, long otherwise) {
        try {
            return text == null ? otherwise : Long.parseLong(text.trim());
        } catch (NumberFormatException notANumber) {
            return otherwise;
        }
    }

    private static double decimal(@Nullable String text, double otherwise) {
        try {
            return text == null ? otherwise : Double.parseDouble(text.trim());
        } catch (NumberFormatException notANumber) {
            return otherwise;
        }
    }

    static String resolve(String base, String reference) {
        try {
            return new URL(new URL(base), reference).toString();
        } catch (MalformedURLException unreadable) {
            return reference;
        }
    }

    private static final class Builder {
        final List<Variant> variants = new ArrayList<>();
        final Set<String> separateAudio = new HashSet<>();
        double targetSeconds = -1;
        long mediaSequence = 0;
        final List<Segment> segments = new ArrayList<>();
        boolean ended = false;
        double holdBackSeconds = -1;
        @Nullable
        String unsupported = null;
    }
}
