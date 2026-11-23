package app.tvinto;

import android.os.Bundle;
import android.view.KeyEvent;

import com.getcapacitor.BridgeActivity;
import app.tvinto.device.HomeScreenPlugin;
import app.tvinto.device.StartUpPlugin;
import app.tvinto.device.SystemColorsPlugin;
import app.tvinto.device.TelevisionPlugin;
import app.tvinto.guide.GuideDownloadPlugin;
import app.tvinto.player.ChannelPreviewPlugin;
import app.tvinto.player.NativePlayerPlugin;
import app.tvinto.reminders.RemindersPlugin;
import app.tvinto.storage.DatabaseLanePlugin;
import app.tvinto.storage.DatabaseSpacePlugin;
import app.tvinto.update.AppUpdatePlugin;
import app.tvinto.update.WebBundles;
import app.tvinto.update.WebUpdatePlugin;

public class MainActivity extends BridgeActivity {

    /** Whether the app's own screen is in front, where its page says a reminder itself. */
    private static volatile boolean inFront = false;

    public static boolean isInFront() {
        return inFront;
    }

    @Override
    public void onResume() {
        super.onResume();
        inFront = true;
    }

    @Override
    public void onPause() {
        inFront = false;
        super.onPause();
    }

    @Override
    public void onCreate(Bundle savedInstanceState) {
        // Registered before super, which is where Capacitor builds the bridge
        // and reads the plugin list. Afterwards is too late and fails silently:
        // the web side simply finds no such plugin and falls back to the
        // WebView player, which looks like the native one not working.
        registerPlugin(NativePlayerPlugin.class);
        registerPlugin(ChannelPreviewPlugin.class);
        registerPlugin(WebUpdatePlugin.class);
        registerPlugin(GuideDownloadPlugin.class);
        registerPlugin(TelevisionPlugin.class);
        registerPlugin(AppUpdatePlugin.class);
        registerPlugin(RemindersPlugin.class);
        registerPlugin(HomeScreenPlugin.class);
        registerPlugin(SystemColorsPlugin.class);
        registerPlugin(StartUpPlugin.class);
        registerPlugin(app.tvinto.device.ErrorReportsPlugin.class);
        registerPlugin(DatabaseSpacePlugin.class);
        registerPlugin(app.tvinto.phone.PhoneFormPlugin.class);
        registerPlugin(app.tvinto.recording.RecorderPlugin.class);
        // The SQLite plugin on a thread of its own. Into the list Capacitor adds
        // after the plugins it found itself, so this one replaces theirs: the
        // same name, registered later.
        initialPlugins.add(DatabaseLanePlugin.class);

        // Also before super, and for a stricter reason: this decides whether a
        // downloaded web bundle is still fit to run, and Capacitor reads that
        // decision -- the `serverBasePath` preference -- while it starts up
        // inside the call below. Afterwards the WebView is already loading the
        // bundle this was meant to be able to refuse.
        WebBundles.onLaunch(this);

        super.onCreate(savedInstanceState);
    }

    /**
     * The remote's Menu, Info and Search keys, handed to the page.
     *
     * Android keeps KEYCODE_MENU for itself -- a listener in the page recorded
     * nothing at all when it was pressed on the TV emulator -- so the page's
     * answer to it, the actions panel for whatever has focus, never ran. Here
     * the press becomes a "ContextMenu" key event on the focused element, which
     * is what `CardGesturesDirective` answers; anything else ignores it.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        int code = event.getKeyCode();
        if ((code == KeyEvent.KEYCODE_MENU || code == KeyEvent.KEYCODE_INFO) && getBridge() != null) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                getBridge().eval(
                    "(function(){var t=document.activeElement;if(t&&t!==document.body){"
                        + "t.dispatchEvent(new KeyboardEvent('keydown',{key:'ContextMenu',bubbles:true,cancelable:true}));}})()",
                    null
                );
            }
            return true;
        }
        // The remote's search key (SR-TV-1), which Android would otherwise
        // answer with a search of its own the WebView has no part in. It
        // reaches the page as a PC keyboard's search key does, and the shell
        // opens Search from any screen.
        if (code == KeyEvent.KEYCODE_SEARCH && getBridge() != null) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                getBridge().eval(
                    "document.dispatchEvent(new KeyboardEvent('keydown',{key:'BrowserSearch',bubbles:true,cancelable:true}))",
                    null
                );
            }
            return true;
        }
        return super.dispatchKeyEvent(event);
    }
}
