package app.tvinto.player;

import androidx.annotation.Nullable;

import org.json.JSONArray;
import org.json.JSONObject;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

/**
 * The channels a player can reach by number or in the mini guide, as the web
 * app sent them once when playback began: number, name, and what is on now and
 * next from the device's guide.
 *
 * Held here rather than asked for per key, because number entry shows the best
 * match under each digit as it is typed and the mini guide moves its highlight
 * on every press -- a round trip to the page for each would be a lag at exactly
 * the moment someone is watching the screen for an answer.
 */
final class ChannelDirectory {

    static final class Channel {
        final String itemId;
        final String number;
        final String name;
        final String tags;
        final boolean hasGuide;
        @Nullable final String nowTitle;
        final long nowStart;
        final long nowStop;
        @Nullable final String nextTitle;
        final long nextStart;
        final long nextStop;

        Channel(JSONObject json) {
            itemId = json.optString("itemId", "");
            number = json.optString("number", "");
            name = json.optString("name", "");
            tags = json.optString("tags", "");
            hasGuide = json.optBoolean("hasGuide", false);
            JSONObject now = json.optJSONObject("now");
            JSONObject next = json.optJSONObject("next");
            nowTitle = now == null ? null : now.optString("title", "");
            nowStart = now == null ? 0 : now.optLong("startMs", 0);
            nowStop = now == null ? 0 : now.optLong("stopMs", 0);
            nextTitle = next == null ? null : next.optString("title", "");
            nextStart = next == null ? 0 : next.optLong("startMs", 0);
            nextStop = next == null ? 0 : next.optLong("stopMs", 0);
        }

        /** "Everton – Leeds · 38 min left", "No guide", or the programme with no time. */
        String onNow(long now) {
            if (!hasGuide) {
                return Texts.t("directory.noGuide");
            }
            if (nowTitle != null && nowStop > now) {
                return Texts.t("directory.left", nowTitle, Math.max(1L, Math.round((nowStop - now) / 60_000d)));
            }
            // The programme sent as "now" has ended since playback began.
            if (nextTitle != null && nextStart <= now && nextStop > now) {
                return Texts.t("directory.left", nextTitle, Math.max(1L, Math.round((nextStop - now) / 60_000d)));
            }
            return nextTitle != null ? Texts.t("directory.next", nextTitle) : "";
        }

        /** "Sportklub 1 · 121": how number entry names its match. */
        String label() {
            return number.isEmpty() ? name : name + " · " + number;
        }
    }

    final String title;
    final List<Channel> channels;

    private ChannelDirectory(String title, List<Channel> channels) {
        this.title = title;
        this.channels = Collections.unmodifiableList(channels);
    }

    static ChannelDirectory from(JSONObject json) {
        List<Channel> channels = new ArrayList<>();
        JSONArray list = json.optJSONArray("channels");
        if (list != null) {
            for (int i = 0; i < list.length(); i++) {
                JSONObject entry = list.optJSONObject(i);
                if (entry != null) {
                    channels.add(new Channel(entry));
                }
            }
        }
        return new ChannelDirectory(json.optString("title", ""), channels);
    }

    int indexOf(String itemId) {
        for (int i = 0; i < channels.size(); i++) {
            if (channels.get(i).itemId.equals(itemId)) {
                return i;
            }
        }
        return -1;
    }

    /**
     * The channel a typed number means: exactly that number, or else the
     * lowest-numbered channel whose number starts with the digits. The same
     * rule as `bestNumberMatch` in src/app/utils/channel-number.utils.ts, which
     * is where it is tested -- change both together.
     */
    @Nullable
    Channel bestNumberMatch(String typed) {
        if (typed.isEmpty()) {
            return null;
        }
        long wanted = parse(typed);
        for (Channel channel : channels) {
            if (channel.number.equals(typed) || (!channel.number.isEmpty() && parse(channel.number) == wanted)) {
                return channel;
            }
        }
        Channel best = null;
        for (Channel channel : channels) {
            if (channel.number.startsWith(typed) && (best == null || parse(channel.number) < parse(best.number))) {
                best = channel;
            }
        }
        return best;
    }

    /** "101 – 486", or empty when no channel has a number. Mirrors `numberRange`. */
    String numberRange() {
        long low = Long.MAX_VALUE;
        long high = Long.MIN_VALUE;
        for (Channel channel : channels) {
            long value = parse(channel.number);
            if (value == Long.MAX_VALUE) {
                continue;
            }
            low = Math.min(low, value);
            high = Math.max(high, value);
        }
        if (low == Long.MAX_VALUE) {
            return "";
        }
        return low == high ? String.valueOf(low) : low + " – " + high;
    }

    private static long parse(String number) {
        try {
            return number.trim().isEmpty() ? Long.MAX_VALUE : Long.parseLong(number.trim());
        } catch (NumberFormatException ignored) {
            return Long.MAX_VALUE;
        }
    }
}
