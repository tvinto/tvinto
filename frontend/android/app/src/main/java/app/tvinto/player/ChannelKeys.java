package app.tvinto.player;

import android.view.KeyEvent;

import androidx.annotation.Nullable;

/**
 * Changing channel from inside the player.
 *
 * Before this, changing channel on a television meant Back to the guide, a
 * press to move, and OK -- three presses and a trip out of the picture for the
 * one thing live TV is mostly used for. Now the remote's channel keys, and Up
 * and Down while the player's controls are hidden, close the player and say
 * which way was pressed; the web app opens the neighbouring channel of the list
 * the viewer was in.
 *
 * Closing and reopening rather than switching streams inside the activity, on
 * purpose. The web app is what knows the list, records what was watched, and
 * builds each channel's address; and the provider allows one connection, so
 * the old stream must be gone before the next opens -- which closing
 * guarantees.
 *
 * Only for live channels: the caller says so with {@link #EXTRA}. Up and Down
 * mean nothing of the kind in a film.
 */
final class ChannelKeys {

    /** Whether this playback may change channel. */
    static final String EXTRA = "channelKeys";

    /**
     * Whether the web app answers a channel key with switchStream, so the player
     * stays open. Without it a key closes the
     * player, as described above -- which is what a web bundle older than the
     * APK still expects.
     */
    static final String EXTRA_IN_PLAYER = "inPlayerSwitching";

    /** The channel first opened, as the web app knows it: id, number, name and the plate's letters. */
    static final String EXTRA_ITEM_ID = "itemId";
    static final String EXTRA_NUMBER = "channelNumber";
    static final String EXTRA_NAME = "channelName";
    static final String EXTRA_MONOGRAM = "monogram";
    /** What is on, as JSON: see ChannelBanner.Info.from. */
    static final String EXTRA_BANNER = "banner";

    static final String NEXT = "next";
    static final String PREVIOUS = "previous";
    static final String LAST = "last";

    private ChannelKeys() {}

    /**
     * The step a key asks for, or null if it is not a channel key.
     *
     * Channel up is the next channel in the list, as it is the next number on
     * any television. Up and Down follow the guide the viewer came from, where
     * Down is the row below -- and they count only while the controls are
     * hidden, because with the controls showing they move between the buttons.
     */
    @Nullable
    static String stepFor(int keyCode, boolean controlsShowing) {
        switch (keyCode) {
            case KeyEvent.KEYCODE_CHANNEL_UP:
                return NEXT;
            case KeyEvent.KEYCODE_CHANNEL_DOWN:
                return PREVIOUS;
            case KeyEvent.KEYCODE_LAST_CHANNEL:
                return LAST;
            case KeyEvent.KEYCODE_DPAD_DOWN:
                return controlsShowing ? null : NEXT;
            case KeyEvent.KEYCODE_DPAD_UP:
                return controlsShowing ? null : PREVIOUS;
            default:
                return null;
        }
    }
}
