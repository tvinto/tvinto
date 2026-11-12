import type { CapacitorConfig } from '@capacitor/cli';

/**
 * The Angular app, packaged as an Android app.
 *
 * One build serves the phone, the tablet and the television: they are all
 * Android, and the layout already adapts. What the television additionally
 * needs is focus handling and a manifest that says it belongs on a TV, neither
 * of which lives here.
 */
const config: CapacitorConfig = {
  appId: 'app.tvinto',
  appName: 'Tvinto',
  webDir: 'dist/iptv-xtream-frontend/browser',

  android: {
    /**
     * The reason a native build exists at all.
     *
     * The provider serves HTTP and has no TLS listener, so a browser refuses
     * to load its video into an HTTPS page and there is nothing the app can do
     * about it. A WebView is not bound by that rule unless it chooses to be,
     * and this is where it declines.
     *
     * It is a genuine loosening: this app may load plaintext content. That is
     * the trade the provider forces, and it is confined to this one
     * application rather than being a setting on anybody's browser.
     */
    allowMixedContent: true,

    /**
     * Silences Capacitor's own bridge logging.
     *
     * In a debug build the bridge logs every plugin call and every plugin
     * result to logcat. For CapacitorHttp a result includes the request URL,
     * and an Xtream URL carries the username and password as query parameters
     * -- so browsing wrote the subscription password into the system log
     * dozens of times over, where it outlives the app and lands in any bug
     * report or shared log dump.
     *
     * This is not something the app can redact: it is the framework logging
     * its own plumbing, below anything this code touches. The only control
     * over it is this switch.
     *
     * The cost is that the app's own console output stops reaching logcat too.
     * To diagnose something, set this to 'debug' temporarily -- and remember
     * that doing so puts the credentials back in the log, so clear it with
     * `adb logcat -c` afterwards rather than leaving them sitting there.
     */
    loggingBehavior: 'none'
  },

  server: {
    /**
     * Serving over http:// rather than https:// inside the app.
     *
     * With an https scheme the WebView applies the mixed-content rule that
     * allowMixedContent then has to fight; matching the provider's scheme
     * avoids the argument entirely. Nothing here travels over a network -- the
     * pages come from the APK -- so the scheme is naming a local origin, not a
     * transport.
     */
    androidScheme: 'http'
  }
};

export default config;
