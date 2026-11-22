package app.tvinto.player;

import android.app.Activity;
import android.content.Intent;
import android.graphics.Color;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;

import androidx.annotation.Nullable;
import androidx.annotation.OptIn;
import androidx.media3.common.C;
import androidx.media3.common.MediaItem;
import androidx.media3.common.PlaybackException;
import androidx.media3.common.Player;
import androidx.media3.common.TrackSelectionParameters;
import androidx.media3.common.Tracks;
import androidx.media3.common.VideoSize;
import androidx.media3.common.util.UnstableApi;
import androidx.media3.exoplayer.ExoPlayer;
import androidx.media3.ui.CaptionStyleCompat;
import androidx.media3.ui.AspectRatioFrameLayout;
import androidx.media3.ui.PlayerView;
import androidx.media3.ui.SubtitleView;

/**
 * Playback, outside the WebView.
 *
 * The reason this exists at all is that a great many Xtream live channels are
 * raw MPEG-TS, which a &lt;video&gt; element will not play under any
 * circumstances. Everything else that comes with it -- real full screen, a
 * D-pad that works without being taught to, subtitles the platform renders and
 * can therefore style, and a track list -- follows from being a real Activity
 * rather than a page pretending to be one.
 *
 * It reports position back rather than saving anything itself. Watch history
 * belongs to the account and is already synced; this only knows where the
 * playhead is.
 */
@OptIn(markerClass = UnstableApi.class)
public class PlayerActivity extends Activity implements SleepTimerPanel.Owner {

    public static final String EXTRA_URL = "url";
    public static final String EXTRA_TITLE = "title";
    public static final String EXTRA_START_AT = "startAtSeconds";
    public static final String EXTRA_SUBTITLE_SCALE = "subtitleScale";
    public static final String EXTRA_SUBTITLE_COLOUR = "subtitleColour";
    public static final String EXTRA_SUBTITLE_BACKGROUND = "subtitleBackground";
    public static final String EXTRA_SUBTITLE_EDGE = "subtitleEdge";
    public static final String EXTRA_AUDIO_LANGUAGE = "audioLanguage";
    public static final String EXTRA_SUBTITLE_LANGUAGE = "subtitleLanguage";
    public static final String EXTRA_SUBTITLES_ENABLED = "subtitlesEnabled";
    /** The chosen track's own name, which its language cannot stand in for. */
    public static final String EXTRA_AUDIO_TITLE = "audioTitle";
    public static final String EXTRA_SUBTITLE_TITLE = "subtitleTitle";
    /** The app's language, "en" or "hr", for the player's own words (Texts). */
    public static final String EXTRA_LANGUAGE = "language";
    /** The player's words in that language, flat JSON by key (Texts.use); absent from an older app. */
    public static final String EXTRA_TEXTS = "texts";

    /** How often the position is handed back, in milliseconds. */
    private static final long REPORT_INTERVAL_MS = 10_000L;

    @Nullable
    private ExoPlayer player;
    @Nullable
    private PlayerView playerView;

    /**
     * Whether playback has already failed.
     *
     * Finishing an Activity runs onPause and then onDestroy, and both of those
     * report the position -- so a failure recorded in onPlayerError was
     * overwritten twice before anything could read it, and every error arrived
     * at the app above as an ordinary stop. The failure is the more important
     * fact and it stands.
     */
    private volatile boolean failed = false;

    /** Whether the remembered tracks have already been taken. See below. */
    private boolean appliedRemembered = false;

    private final android.os.Handler reporter = new android.os.Handler(android.os.Looper.getMainLooper());

    /** Changing channel without leaving the player, for a live channel that asked for it. See ChannelSession. */
    @Nullable
    private ChannelSession session = null;

    /** Whether the stream now open has shown a picture. See loadErrors. */
    private boolean pictured = false;

    /**
     * A live channel paused on this device (LivePause): what it writes, the
     * provider's address of the channel open now (what a pause takes, and what
     * live is), when the pause began, and how far behind live the picture is.
     */
    @Nullable
    private LivePause livePause = null;
    @Nullable
    private String liveAddress = null;
    private long pausedAt = 0L;
    private long behindMs = 0L;
    @Nullable
    private LivePauseBadge pauseBadge = null;
    /** The guide's preview player, taken over when it was playing this channel; null otherwise. */
    private ExoPlayer adopted;

    /** The picture's shape (PictureMode), and the address it is remembered for. */
    private String pictureMode = PictureMode.ORIGINAL;
    @Nullable
    private String pictureUrl;
    /** Closed by the sleep timer: nothing is handed back to play on behind the launcher. */
    private boolean sleptOut = false;

    /** The controls for a film or an episode (design section 5b), in place of Media3's own. */
    @Nullable
    private FilmControls film = null;

    /** The television's refresh rate, matched to what plays. See FrameRateMatch. */
    @Nullable
    private FrameRateMatch frameRate = null;

    /** The sleep timer, on a television (SleepTimerPanel). */
    @Nullable
    private SleepTimerPanel sleep = null;

    @Nullable
    @Override
    public SleepTimerPanel sleepTimer() {
        return sleep;
    }

    private final Runnable reportTick = new Runnable() {
        @Override
        public void run() {
            publishPosition();
            reporter.postDelayed(this, REPORT_INTERVAL_MS);
        }
    };

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Texts.use(getIntent().getStringExtra(EXTRA_LANGUAGE), getIntent().getStringExtra(EXTRA_TEXTS));

        // A television has no notification bar worth keeping, and a phone
        // watching a film does not want one either.
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        goFullScreen();

        setContentView(app.tvinto.R.layout.activity_player);
        playerView = findViewById(app.tvinto.R.id.player_view);

        Intent intent = getIntent();
        String url = intent.getStringExtra(EXTRA_URL);
        if (url == null || url.isEmpty()) {
            finish();
            return;
        }

        session = ChannelSession.start(this, engine);

        android.util.Log.i("TvintoPlayer", "Opening " + safeToLog(url));

        /*
         * Try the next decoder when the first one fails.
         *
         * Media3 picks one decoder for a format and, by default, gives up if it
         * throws. Devices carry several: this emulator declares four for HEVC,
         * and the one it prefers -- its own c2.goldfish -- cannot manage
         * 10-bit, while the AOSP software decoder beside it can. Without
         * fallback, a 4K HEVC film failed outright on a device that had
         * something able to play it sitting unused.
         *
         * It is not an emulator workaround. A hardware decoder on real hardware
         * fails too -- too many concurrent instances, an unusual profile, a
         * driver having a bad day -- and falling back to software is better than
         * refusing the film. The cost is that a fallback decode may be slower,
         * which is a far smaller problem than not playing.
         */
        // The text renderers on a clock of their own, for subtitle timing
        // (SubtitleDelay); everything else as Media3 makes it.
        androidx.media3.exoplayer.DefaultRenderersFactory renderers =
            SubtitleDelay.renderers(this, subtitleShift)
                .setEnableDecoderFallback(true);

        /*
         * One request per attempt at opening a stream, not four.
         *
         * Media3 retries a failed load three times by itself, a second or two
         * apart. On the TV emulator a refused channel was asked for four times
         * in three seconds -- and on a one-connection subscription those extra
         * requests are what gets an address blocked. While nothing has played
         * yet an HTTP refusal is final and reported at once; the web app decides
         * about a second attempt. Once a picture
         * has arrived, a hiccup part way through is retried as before.
         */
        androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy loadErrors =
            new androidx.media3.exoplayer.upstream.DefaultLoadErrorHandlingPolicy() {
                @Override
                public long getRetryDelayMsFor(LoadErrorInfo info) {
                    if (!pictured && info.exception instanceof androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException) {
                        return C.TIME_UNSET;
                    }
                    return super.getRetryDelayMsFor(info);
                }
            };

        /*
         * Patience with a slow provider.
         *
         * Media3 gives up on a request after 8 s. Near midnight on 26 September
         * a user's provider took 9 to 15 s to answer for a catch-up
         * playlist -- it had taken a fifth of a second an hour before -- so
         * every attempt timed out, was retried, timed out again, and the
         * player closed after half a minute of "Opening". Each retry is also
         * one more request on a one-connection subscription. Waiting longer
         * for the one request is kinder on both counts.
         */
        androidx.media3.datasource.DefaultHttpDataSource.Factory http =
            new androidx.media3.datasource.DefaultHttpDataSource.Factory()
                .setConnectTimeoutMs(15_000)
                .setReadTimeoutMs(20_000);

        // The preview above the guide, when it is playing this channel: taken
        // over rather than opened again (ChannelPreviewPlugin.takeOver).
        adopted = ChannelPreviewPlugin.takeOver(url);
        player = adopted != null
            ? adopted
            : new ExoPlayer.Builder(this, renderers)
                .setMediaSourceFactory(
                    new androidx.media3.exoplayer.source.DefaultMediaSourceFactory(
                        new androidx.media3.datasource.DefaultDataSource.Factory(this, http)
                    ).setLoadErrorHandlingPolicy(loadErrors)
                )
                .build();
        if (adopted != null) {
            pictured = true;
        }
        playerView.setPlayer(player);
        playerView.requestFocus();

        // The shape chosen for this file before, if one was (PictureMode).
        pictureUrl = url;
        pictureMode = PictureMode.remembered(this, url);
        applyPicture();
        player.addListener(new Player.Listener() {
            @Override
            public void onVideoSizeChanged(VideoSize size) {
                // PlayerView sets the film's own shape on every size it hears
                // of; a shape chosen is put back after it.
                if (PictureMode.ratio(pictureMode) > 0 && playerView != null) {
                    playerView.post(PlayerActivity.this::applyPicture);
                }
            }
        });

        // Every frame's time, for a stream that does not say its rate --
        // which is most live MPEG-TS. Called on the playback thread.
        FrameRateMatch match = FrameRateMatch.start(this);
        frameRate = match;
        player.setVideoFrameMetadataListener(
            (presentationTimeUs, releaseTimeNs, format, mediaFormat) -> match.onFrame(presentationTimeUs, format.frameRate)
        );

        film = FilmControls.start(this, filmPlayback);
        if (film == null) {
            // A live channel: its pause hands the connection over (LivePause),
            // the stock controls' Pause included, and its last picture stays
            // up while nothing is open.
            liveAddress = url;
            playerView.setKeepContentOnPlayerReset(true);
            playerView.setPlayer(new androidx.media3.common.ForwardingPlayer(player) {
                @Override
                public void pause() {
                    if (pausable() && !livePaused()) {
                        pauseLive();
                    } else {
                        super.pause();
                    }
                }

                @Override
                public void play() {
                    if (livePaused()) {
                        playOn();
                    } else {
                        super.play();
                    }
                }

                /** The stock Play asks for this first on a stopped player: paused, it would open the channel again. */
                @Override
                public void prepare() {
                    if (!livePaused()) {
                        super.prepare();
                    }
                }

                // A phone's stock rewind and fast forward step within what a
                // pause wrote, as Left and Right do on a remote (stepWithin).
                // Media3 itself cannot seek in the growing file. Behind live
                // on a recording, forward is the way back to live.
                @Override
                public boolean isCommandAvailable(int command) {
                    return steppable(command) || super.isCommandAvailable(command);
                }

                @Override
                public Player.Commands getAvailableCommands() {
                    Player.Commands own = super.getAvailableCommands();
                    if (livePause != null) {
                        return own.buildUpon().add(Player.COMMAND_SEEK_BACK).add(Player.COMMAND_SEEK_FORWARD).build();
                    }
                    return behindOnRecording() ? own.buildUpon().add(Player.COMMAND_SEEK_FORWARD).build() : own;
                }

                @Override
                public long getSeekBackIncrement() {
                    return livePause == null ? super.getSeekBackIncrement() : STEP_MS;
                }

                @Override
                public long getSeekForwardIncrement() {
                    return livePause == null ? super.getSeekForwardIncrement() : STEP_MS;
                }

                @Override
                public void seekBack() {
                    if (livePause != null) {
                        stepWithin(-STEP_MS);
                    } else {
                        super.seekBack();
                    }
                }

                @Override
                public void seekForward() {
                    if (livePause != null) {
                        stepWithin(STEP_MS);
                    } else if (behindOnRecording()) {
                        backToLive();
                    } else {
                        super.seekForward();
                    }
                }

                private boolean steppable(int command) {
                    return (livePause != null && (command == Player.COMMAND_SEEK_BACK || command == Player.COMMAND_SEEK_FORWARD))
                        || (command == Player.COMMAND_SEEK_FORWARD && behindOnRecording());
                }
            });
            pauseBadge = new LivePauseBadge(this);
        }
        // After the film's controls and the channel's banner, so it draws over them.
        sleep = SleepTimerPanel.forTelevision(this, new SleepTimerPanel.Host() {
            @Override
            public void setVolume(float volume) {
                if (player != null) {
                    player.setVolume(volume);
                }
            }

            @Override
            public void stopForSleep() {
                // Paused rather than stopped: a stopped player can report its
                // position as 0, and closing reports it once more. Closing
                // releases it, connection and all, a moment later.
                publishPosition();
                sleptOut = true;
                if (player != null) {
                    player.setPlayWhenReady(false);
                }
                // Behind the launcher, where the television's own screen-off
                // and screensaver can come: in front, the app holds the screen on.
                moveTaskToBack(true);
                finish();
            }
        });
        if (film != null) {
            // The film's own controls draw everything, the wait included.
            playerView.setUseController(false);
            playerView.setShowBuffering(PlayerView.SHOW_BUFFERING_NEVER);
        } else if (session != null) {
            // A channel's tracks are chosen from its banner (TrackChoices), so
            // the stock controls a phone's second tap shows lose theirs: CC and
            // the gear opened Media3's own lists.
            playerView.setShowSubtitleButton(false);
            View gear = playerView.findViewById(androidx.media3.ui.R.id.exo_settings);
            if (gear != null) {
                gear.setVisibility(View.GONE);
            }
        }

        applySubtitleStyle(intent);
        applyTrackPreferences(intent);

        player.addListener(new Player.Listener() {
            @Override
            public void onMediaItemTransition(@Nullable MediaItem mediaItem, int reason) {
                // Another channel, or the next episode: its rate is found again.
                if (frameRate != null) {
                    frameRate.restart();
                }
            }

            @Override
            public void onPlaybackStateChanged(int state) {
                if (film != null) {
                    film.onBuffering(state == Player.STATE_BUFFERING);
                }
                if (state == Player.STATE_ENDED && livePause != null) {
                    // A pause played to its end: what was written ran out. Live again.
                    backToLive();
                    return;
                }
                if (state == Player.STATE_ENDED) {
                    // The sleep timer set for the end of this: it stops here.
                    if (sleep != null && sleep.stopAtEnd()) {
                        return;
                    }
                    // An episode with the next one queued goes on to it.
                    if (film != null && film.onEnded()) {
                        return;
                    }
                    publishPosition();
                    finish();
                }
            }

            @Override
            public void onPlayWhenReadyChanged(boolean playWhenReady, int reason) {
                if (film != null) {
                    film.onPaused(!playWhenReady);
                }
            }

            @Override
            public void onRenderedFirstFrame() {
                pictured = true;
                if (session != null) {
                    session.onFirstFrame();
                }
                if (film != null) {
                    film.onFirstFrame();
                }
            }

            @Override
            public void onIsPlayingChanged(boolean isPlaying) {
                if (session != null) {
                    session.onPlaying(isPlaying);
                }
                if (film != null) {
                    film.onPlaying(isPlaying);
                }
            }

            @Override
            public void onPlayerError(PlaybackException error) {
                // The pause's own file would not play: live again, rather than closing.
                if (livePause != null) {
                    android.util.Log.e("TvintoPlayer", "Paused channel would not play: " + error.getErrorCodeName());
                    backToLive();
                    return;
                }
                // A switched channel's failure is the web app's to decide
                // about -- once more, give up, or close. The panel stays up.
                if (session != null && session.onFailure(describe(error))) {
                    android.util.Log.e("TvintoPlayer", "Switched stream failed: " + error.getErrorCodeName() + " (" + error.errorCode + ")");
                    return;
                }
                // The next episode, turned away because the last one's connection
                // still counted: once more, after a pause (FilmControls.onOpenFailed).
                if (film != null && film.onOpenFailed(error.getErrorCodeName())) {
                    return;
                }
                // Said rather than swallowed. Closing silently is what this did
                // first, and a film that would not open was indistinguishable
                // from one that had finished -- the player simply vanished, with
                // nothing anywhere to say why.
                publishFailure(error);
                finish();
            }

            @Override
            public void onTracksChanged(Tracks tracks) {
                // Once the tracks are known, take the one that was remembered
                // by name -- `--slang`'s equivalent here picks by language, and
                // a film with "English (forced)", "English" and "English (SDH)"
                // gives all three the same one.
                selectRemembered(tracks);

                // Reported every time the selection changes, so turning
                // subtitles on half way through a film is what ends up
                // remembered. The app stores it against this item and asks for
                // it again next time -- see `tracksFor` in shared/player.ts.
                publishTracks(tracks);

                if (film != null) {
                    film.onTracksChanged();
                    film.onChapters(chaptersIn(tracks));
                }

                // A film whose sound this device cannot decode played silently,
                // with nothing anywhere to say so: X-Men on the TV emulator,
                // 24 September, with only AC3/DTS-style audio. Media3 does not
                // treat that as an error, so it is reported as one here, which
                // hands the film to VLC -- it decodes those itself.
                String unplayable = session == null && film != null && !failed ? unplayableAudio(tracks) : null;
                if (unplayable != null) {
                    failed = true;
                    long position = Math.max(0L, player == null ? 0L : player.getCurrentPosition()) / 1000L;
                    String code = "no decoder on this device managed audio " + unplayable + " (ERROR_CODE_DECODING_FORMAT_UNSUPPORTED)";
                    PlaybackReports.failure(position, code);
                    android.util.Log.e("TvintoPlayer", "No audio this device can play: " + unplayable);
                    finish();
                }
            }
        });

        if (adopted == null) {
            player.setMediaItem(withAddedSubtitles(url, getIntent()));
            player.prepare();
        }

        long startAt = intent.getLongExtra(EXTRA_START_AT, 0L);
        if (startAt > 0) {
            player.seekTo(startAt * 1000L);
        }

        player.setPlayWhenReady(true);
        reporter.postDelayed(reportTick, REPORT_INTERVAL_MS);
    }

    /**
     * Subtitles, as the account asked for them.
     *
     * Media3 draws these itself rather than handing them to a platform widget,
     * which is exactly why they can be styled at all -- the same settings on a
     * WebView would be at the mercy of whatever ::cue happens to support.
     */
    private void applySubtitleStyle(Intent intent) {
        if (playerView == null) {
            return;
        }

        SubtitleView subtitles = playerView.getSubtitleView();
        if (subtitles == null) {
            return;
        }

        int foreground = parseColour(intent.getStringExtra(EXTRA_SUBTITLE_COLOUR), Color.WHITE);
        String background = orEmpty(intent.getStringExtra(EXTRA_SUBTITLE_BACKGROUND));
        String edge = orEmpty(intent.getStringExtra(EXTRA_SUBTITLE_EDGE));

        int backgroundColour;
        if ("solid".equals(background)) {
            backgroundColour = Color.BLACK;
        } else if ("translucent".equals(background)) {
            backgroundColour = Color.argb(160, 0, 0, 0);
        } else {
            backgroundColour = Color.TRANSPARENT;
        }

        int edgeType;
        if ("outline".equals(edge)) {
            edgeType = CaptionStyleCompat.EDGE_TYPE_OUTLINE;
        } else if ("shadow".equals(edge)) {
            edgeType = CaptionStyleCompat.EDGE_TYPE_DROP_SHADOW;
        } else {
            edgeType = CaptionStyleCompat.EDGE_TYPE_NONE;
        }

        subtitles.setStyle(
            new CaptionStyleCompat(
                foreground,
                backgroundColour,
                Color.TRANSPARENT,
                edgeType,
                Color.BLACK,
                null
            )
        );

        // The stored size is a percentage of the player's own default, so that
        // one setting can mean something on a phone and on a television.
        int scale = intent.getIntExtra(EXTRA_SUBTITLE_SCALE, 100);
        subtitles.setFractionalTextSize(SubtitleView.DEFAULT_TEXT_SIZE_FRACTION * (scale / 100f));
    }

    /**
     * Which audio and subtitle track to prefer.
     *
     * A preference rather than a selection: the track chosen on one channel
     * means nothing on the next, but "Croatian if there is one" holds across
     * all of them. Media3 applies it per stream as each one loads.
     */
    private void applyTrackPreferences(Intent intent) {
        if (player == null) {
            return;
        }

        String audio = orEmpty(intent.getStringExtra(EXTRA_AUDIO_LANGUAGE));
        String subtitle = orEmpty(intent.getStringExtra(EXTRA_SUBTITLE_LANGUAGE));
        boolean subtitlesOn = intent.getBooleanExtra(EXTRA_SUBTITLES_ENABLED, false);

        TrackSelectionParameters.Builder parameters = player.getTrackSelectionParameters().buildUpon();

        if (!audio.isEmpty()) {
            parameters.setPreferredAudioLanguage(audio);
        }
        // Somebody chose an added subtitle for this film, which outranks both
        // the account's language and what the stream happens to carry.
        java.util.List<AddedSubtitles.Added> added = AddedSubtitles.from(intent);
        if (!added.isEmpty()) {
            subtitlesOn = true;
            String language = added.get(0).language;
            parameters.setPreferredTextLanguage(language.isEmpty() ? subtitle : language);
        } else if (subtitlesOn && !subtitle.isEmpty()) {
            parameters.setPreferredTextLanguage(subtitle);
        }

        // Off unless asked for. A stream that carries subtitles should not start
        // showing them because it happens to have them.
        parameters.setTrackTypeDisabled(androidx.media3.common.C.TRACK_TYPE_TEXT, !subtitlesOn);
        // A channel's subtitles often say no language at all -- a user's
        // Top Gear, remembered as on with no language and no name -- and a
        // preferred language alone never selects one of those: they came back
        // off at every opening (31 October). Asked for, they are taken when
        // nothing in the language wanted is there. Films keep to the language.
        if (film == null) {
            parameters.setSelectUndeterminedTextLanguage(subtitlesOn);
        }

        player.setTrackSelectionParameters(parameters.build());
    }

    /**
     * The stream, with the account's added subtitles beside it.
     *
     * Media3 merges a side-loaded file into the item's tracks, so an added
     * subtitle appears in the CC menu with the stream's own and can be turned
     * off there like any other. The language is what `applyTrackPreferences`
     * then selects by.
     */
    private MediaItem withAddedSubtitles(String url, Intent intent) {
        java.util.List<AddedSubtitles.Added> added = AddedSubtitles.from(intent);
        if (added.isEmpty()) {
            return MediaItem.fromUri(url);
        }

        java.util.List<MediaItem.SubtitleConfiguration> configurations = new java.util.ArrayList<>();
        for (AddedSubtitles.Added subtitle : added) {
            configurations.add(
                new MediaItem.SubtitleConfiguration.Builder(subtitle.uri())
                    .setMimeType(androidx.media3.common.MimeTypes.TEXT_VTT)
                    .setLanguage(subtitle.language.isEmpty() ? null : subtitle.language)
                    .setLabel(subtitle.label.isEmpty() ? null : subtitle.label)
                    .setSelectionFlags(androidx.media3.common.C.SELECTION_FLAG_DEFAULT)
                    .build()
            );
        }

        return new MediaItem.Builder().setUri(url).setSubtitleConfigurations(configurations).build();
    }

    private void publishPosition() {
        // A recorded failure outranks any later position. See `failed`.
        if (player == null || failed) {
            return;
        }

        long position = Math.max(0L, player.getCurrentPosition()) / 1000L;
        long duration = player.getDuration();

        // Live streams report a duration of TIME_UNSET, and a negative runtime
        // travelling up to the watch history would draw a progress bar of
        // nonsense. Zero already means "unknown" everywhere above.
        long runtime = duration == androidx.media3.common.C.TIME_UNSET || duration < 0
            ? 0L
            : duration / 1000L;

        PlaybackReports.position(position, runtime);
        PlaybackCheckpoint.reached(this, position, runtime);
    }

    /**
     * Takes the tracks this item was last watched with, by name.
     *
     * Once, and only once: an override changes the selection, which calls this
     * back, and doing it again would fight the viewer for the rest of the film.
     */
    private void selectRemembered(Tracks tracks) {
        if (player == null || appliedRemembered) {
            return;
        }
        appliedRemembered = true;

        Intent intent = getIntent();
        TrackSelectionParameters.Builder wanted = player.getTrackSelectionParameters().buildUpon();
        boolean anything = false;

        String audioTitle = carrying ? carriedAudioTitle : intent.getStringExtra(EXTRA_AUDIO_TITLE);
        String audioLanguage = carrying ? carriedAudioLanguage : intent.getStringExtra(EXTRA_AUDIO_LANGUAGE);
        androidx.media3.common.TrackSelectionOverride audio =
            overrideFor(tracks, C.TRACK_TYPE_AUDIO, audioTitle, audioLanguage);
        if (audio != null) {
            wanted.addOverride(audio);
            anything = true;
        }

        if (carrying ? carriedSubtitlesOn : intent.getBooleanExtra(EXTRA_SUBTITLES_ENABLED, false)) {
            String subtitleTitle = carrying ? carriedSubtitleTitle : intent.getStringExtra(EXTRA_SUBTITLE_TITLE);
            String subtitleLanguage = carrying ? carriedSubtitleLanguage : intent.getStringExtra(EXTRA_SUBTITLE_LANGUAGE);
            androidx.media3.common.TrackSelectionOverride subtitle =
                overrideFor(tracks, C.TRACK_TYPE_TEXT, subtitleTitle, subtitleLanguage);
            if (subtitle != null) {
                wanted.addOverride(subtitle);
                anything = true;
            }
        }

        if (anything) {
            player.setTrackSelectionParameters(wanted.build());
        }
    }

    /**
     * The track of this kind whose name matches, in the language asked for
     * when there is one, as an override, or null.
     *
     * The language as well as the name, because names repeat: Supernatural
     * calls both its subtitle tracks "Full", one German and one English, and
     * matching the name alone took the first -- German, after English had been
     * chosen (27 September).
     */
    @Nullable
    private androidx.media3.common.TrackSelectionOverride overrideFor(
        Tracks tracks,
        int trackType,
        @Nullable String title,
        @Nullable String language
    ) {
        if (title == null || title.trim().isEmpty()) {
            // Nothing was named, so the language preference already applied is
            // the best answer there is.
            return null;
        }
        String wantedLanguage = language == null ? "" : language.trim();

        for (Tracks.Group group : tracks.getGroups()) {
            if (group.getType() != trackType) {
                continue;
            }

            for (int i = 0; i < group.length; i++) {
                androidx.media3.common.Format format = group.getTrackFormat(i);
                boolean named = format.label != null && format.label.trim().equals(title.trim());
                boolean spoken = wantedLanguage.isEmpty() || TrackNames.sameLanguage(format.language, wantedLanguage);
                if (named && spoken) {
                    return new androidx.media3.common.TrackSelectionOverride(
                        group.getMediaTrackGroup(),
                        i
                    );
                }
            }
        }

        return null;
    }

    /**
     * Writes down which tracks are actually selected.
     *
     * The languages come off the selected formats rather than off what was
     * asked for: a request for Croatian on a film that has none would
     * otherwise be remembered as though it had been honoured, and the next
     * viewing would ask for it again forever.
     */
    private void publishTracks(Tracks tracks) {
        PlaybackReports.tracks(
            selectedField(tracks, C.TRACK_TYPE_AUDIO, true),
            selectedField(tracks, C.TRACK_TYPE_TEXT, true),
            selectedField(tracks, C.TRACK_TYPE_AUDIO, false),
            selectedField(tracks, C.TRACK_TYPE_TEXT, false),
            hasSelected(tracks, C.TRACK_TYPE_TEXT)
        );
    }

    /**
     * The language, or the name, of the chosen track of this kind.
     *
     * Both, because neither is enough on its own: a language does not
     * distinguish "English (forced)" from "English (SDH)", and a great many
     * tracks have no name at all.
     */
    @Nullable
    private String selectedField(Tracks tracks, int trackType, boolean language) {
        for (Tracks.Group group : tracks.getGroups()) {
            if (group.getType() != trackType) {
                continue;
            }

            for (int i = 0; i < group.length; i++) {
                if (group.isTrackSelected(i)) {
                    return language ? group.getTrackFormat(i).language : group.getTrackFormat(i).label;
                }
            }
        }

        return null;
    }

    /**
     * The format of the audio when a stream has audio and none of it can be
     * played here -- "ac3", "vnd.dts" -- or null when some can, or there is none.
     */
    @Nullable
    private static String unplayableAudio(Tracks tracks) {
        String format = null;
        for (Tracks.Group group : tracks.getGroups()) {
            if (group.getType() != C.TRACK_TYPE_AUDIO) {
                continue;
            }
            for (int i = 0; i < group.length; i++) {
                if (group.isTrackSupported(i)) {
                    return null;
                }
                String mime = group.getTrackFormat(i).sampleMimeType;
                if (format == null) {
                    format = mime == null ? "unknown" : mime.replaceFirst("^\\w+/", "");
                }
            }
        }
        return format;
    }

    /** Whether anything of this kind is selected at all. */
    private boolean hasSelected(Tracks tracks, int trackType) {
        for (Tracks.Group group : tracks.getGroups()) {
            if (group.getType() == trackType && group.isSelected()) {
                return true;
            }
        }

        return false;
    }

    /**
     * Records why playback stopped, keeping whatever position was reached.
     *
     * The error name rather than the message: Media3's messages are long and
     * meant for a log, while the name -- ERROR_CODE_IO_BAD_HTTP_STATUS and the
     * like -- says the useful thing in a form that can be shown to a person or
     * matched on.
     */
    private void publishFailure(PlaybackException error) {
        long position = player == null ? 0L : Math.max(0L, player.getCurrentPosition()) / 1000L;

        // Set before the report, so that the onPause and onDestroy which follow
        // finish() cannot overwrite it on their way past.
        failed = true;
        PlaybackReports.failure(position, describe(error));

        // Also to logcat, because the app above can only show what it is told
        // and this is the one place that knows the whole exception.
        android.util.Log.e(
            "TvintoPlayer",
            "Playback failed: " + error.getErrorCodeName() + " (" + error.errorCode + ")",
            error
        );
    }

    /**
     * What went wrong, in terms a person can act on.
     *
     * An error code alone sends someone to a search engine. A decoding failure
     * in particular is almost never about the file -- it is this device meeting
     * a codec or a resolution it has no decoder for, and the useful thing to
     * say is which. The same film plays elsewhere; naming the format is what
     * makes that make sense rather than look like a fault.
     */
    /**
     * The chapters the file names, as Media3 read them (Matroska and MP4 carry
     * them; a live stream does not). Hidden ones are left out.
     */
    private static java.util.List<SkipTimes.Chapter> chaptersIn(Tracks tracks) {
        java.util.List<SkipTimes.Chapter> found = new java.util.ArrayList<>();
        for (Tracks.Group group : tracks.getGroups()) {
            for (int i = 0; i < group.length; i++) {
                androidx.media3.common.Metadata metadata = group.getTrackFormat(i).metadata;
                for (int e = 0; metadata != null && e < metadata.length(); e++) {
                    if (metadata.get(e) instanceof androidx.media3.extractor.metadata.Chapter) {
                        androidx.media3.extractor.metadata.Chapter chapter = (androidx.media3.extractor.metadata.Chapter) metadata.get(e);
                        if (!chapter.isHidden() && chapter.getStartTimeMs() != androidx.media3.common.C.TIME_UNSET) {
                            String title = chapter.getTitle() == null ? "" : chapter.getTitle().value;
                            long end = chapter.getEndTimeMs() == androidx.media3.common.C.TIME_UNSET ? -1L : chapter.getEndTimeMs();
                            found.add(new SkipTimes.Chapter(title, chapter.getStartTimeMs(), end));
                        }
                    }
                }
            }
            if (!found.isEmpty()) {
                // Every track of a file carries the same list; one is enough.
                break;
            }
        }
        return found;
    }

    private static String describe(PlaybackException error) {
        String code = error.getErrorCodeName();

        // The status a refused stream came back with. A 404 is a dead copy and
        // another may play; a 401, 403 or 509 is the provider turning the
        // account away, and every copy would meet the same (other-versions.utils.ts).
        if (error.getCause() instanceof androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException) {
            int status = ((androidx.media3.datasource.HttpDataSource.InvalidResponseCodeException) error.getCause()).responseCode;
            return code + " (HTTP " + status + ")";
        }

        if (!(error instanceof androidx.media3.exoplayer.ExoPlaybackException)) {
            return code;
        }

        androidx.media3.common.Format format =
            ((androidx.media3.exoplayer.ExoPlaybackException) error).rendererFormat;
        if (format == null) {
            return code;
        }

        StringBuilder detail = new StringBuilder();
        if (format.sampleMimeType != null) {
            // "video/hevc" reads better as "hevc" to anyone who has to repeat it.
            detail.append(format.sampleMimeType.replaceFirst("^\\w+/", ""));
        }
        if (format.width > 0 && format.height > 0) {
            if (detail.length() > 0) {
                detail.append(' ');
            }
            detail.append(format.width).append('x').append(format.height);
        }

        if (detail.length() == 0) {
            return code;
        }

        // "no decoder here managed", not "cannot decode": by the time this is
        // reached, every decoder the device offers has been tried and failed.
        return "no decoder on this device managed " + detail + " (" + code + ")";
    }

    private void goFullScreen() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
            View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                | View.SYSTEM_UI_FLAG_FULLSCREEN
                | View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
        );

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            getWindow().getAttributes().layoutInDisplayCutoutMode =
                WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
        }
    }

    /**
     * Channel keys, before the player view gets them. See ChannelKeys.
     *
     * Here rather than on the view, because the view only sees keys while it
     * has focus and the controller takes focus whenever it is showing.
     */
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        // A reminder over the video has OK and Back first while it shows.
        Boolean reminded = reminders.onKey(event);
        if (reminded != null) {
            return reminded;
        }
        // Then the sleep timer's list or its last minute, over everything else.
        if (sleep != null) {
            Boolean slept = sleep.onKey(event);
            if (slept != null) {
                return slept;
            }
        }
        if (film != null) {
            Boolean handled = film.onKey(event);
            if (handled != null) {
                return handled;
            }
        }
        Boolean paused = pauseKey(event);
        if (paused != null) {
            return paused;
        }
        if (session != null) {
            Boolean handled = session.onKey(event);
            if (handled != null) {
                return handled;
            }
        }
        if (event.getAction() == KeyEvent.ACTION_DOWN
            && event.getRepeatCount() == 0
            && getIntent().getBooleanExtra(ChannelKeys.EXTRA, false)) {
            boolean controlsShowing = playerView != null && playerView.isControllerFullyVisible();
            String step = ChannelKeys.stepFor(event.getKeyCode(), controlsShowing);
            if (step != null) {
                publishPosition();
                PlaybackReports.channelStep(step);
                finish();
                overridePendingTransition(0, 0);
                return true;
            }
        }
        return super.dispatchKeyEvent(event);
    }

    /** How late the subtitles are shown (SubtitleDelay), read by the text renderers. */
    private final SubtitleDelay.Shift subtitleShift = new SubtitleDelay.Shift();

    /** What FilmControls needs of Media3. */
    private final FilmPlayback filmPlayback = new FilmPlayback() {
        @Override
        public void liftSubtitles(float share) {
            SubtitleView subtitles = playerView == null ? null : playerView.getSubtitleView();
            if (subtitles != null) {
                // The whole layer, not its bottom padding: a channel's captions
                // carry their own row on the screen and ignore the padding --
                // tried first, on a user's Top Gear, and nothing moved.
                subtitles.setTranslationY(-subtitles.getHeight() * share);
            }
        }

        @Override
        public long positionMs() {
            return player == null ? 0L : Math.max(0L, player.getCurrentPosition());
        }

        @Override
        public long durationMs() {
            long duration = player == null ? C.TIME_UNSET : player.getDuration();
            return duration == C.TIME_UNSET || duration < 0 ? 0L : duration;
        }

        @Override
        public boolean isPlaying() {
            return player != null && player.isPlaying();
        }

        @Override
        public void setPlaying(boolean playing) {
            if (player != null) {
                player.setPlayWhenReady(playing);
            }
        }

        @Override
        public void seekTo(long positionMs) {
            if (player != null) {
                player.seekTo(Math.max(0L, positionMs));
            }
        }

        @Override
        public java.util.List<Track> audioTracks() {
            return tracksOf(C.TRACK_TYPE_AUDIO);
        }

        @Override
        public java.util.List<Track> subtitleTracks() {
            return tracksOf(C.TRACK_TYPE_TEXT);
        }

        @Override
        public void choose(Track track) {
            if (player == null) {
                return;
            }
            int type = track.kind == Track.AUDIO ? C.TRACK_TYPE_AUDIO : C.TRACK_TYPE_TEXT;
            TrackSelectionParameters.Builder wanted = player.getTrackSelectionParameters().buildUpon();
            if (track.isOff()) {
                wanted.setTrackTypeDisabled(C.TRACK_TYPE_TEXT, true);
            } else {
                wanted.setTrackTypeDisabled(type, false);
                wanted.setOverrideForType((androidx.media3.common.TrackSelectionOverride) track.handle);
            }
            // onTracksChanged follows, which reports the choice to be remembered.
            player.setTrackSelectionParameters(wanted.build());
        }

        @Override
        public long subtitleDelayMs() {
            return subtitleShift.ms();
        }

        @Override
        public void setSubtitleDelay(long ms) {
            subtitleShift.setMs(ms);
        }

        @Override
        public String pictureMode() {
            return pictureMode;
        }

        @Override
        public void setPictureMode(String mode) {
            pictureMode = mode;
            PictureMode.remember(PlayerActivity.this, pictureUrl, mode);
            applyPicture();
        }

        @Override
        public float speed() {
            return player == null ? 1f : player.getPlaybackParameters().speed;
        }

        @Override
        public void setSpeed(float speed) {
            if (player != null) {
                player.setPlaybackSpeed(speed);
            }
        }

        @Override
        public void close() {
            publishPosition();
            finish();
        }

        @Override
        public void stop() {
            if (player == null) {
                return;
            }
            // The next episode takes the tracks this one ended with, by name:
            // the same show names its tracks the same way episode to episode.
            Tracks tracks = player.getCurrentTracks();
            carriedAudioTitle = selectedField(tracks, C.TRACK_TYPE_AUDIO, false);
            carriedSubtitleTitle = selectedField(tracks, C.TRACK_TYPE_TEXT, false);
            carriedAudioLanguage = selectedField(tracks, C.TRACK_TYPE_AUDIO, true);
            carriedSubtitleLanguage = selectedField(tracks, C.TRACK_TYPE_TEXT, true);
            carriedSubtitlesOn = hasSelected(tracks, C.TRACK_TYPE_TEXT);
            carrying = true;
            player.stop();
            player.clearMediaItems();
        }

        @Override
        public void open(String url) {
            if (player == null) {
                return;
            }
            // The next episode keeps the shape this one was given, unless it has one of its own.
            String own = PictureMode.remembered(PlayerActivity.this, url);
            if (!PictureMode.ORIGINAL.equals(own)) {
                pictureMode = own;
                applyPicture();
            }
            pictureUrl = url;
            // The last episode's overrides name its track groups, which the
            // next one does not have; the names are taken again instead. And
            // the languages, for tracks with no name: most episodes' subtitles
            // have none, so a name alone carried nothing, and English turned on
            // in one episode was off in the next (27 September).
            TrackSelectionParameters.Builder next = player.getTrackSelectionParameters().buildUpon()
                .clearOverrides()
                .setTrackTypeDisabled(C.TRACK_TYPE_TEXT, !carriedSubtitlesOn);
            if (carriedAudioLanguage != null) {
                next.setPreferredAudioLanguage(carriedAudioLanguage);
            }
            if (carriedSubtitlesOn && carriedSubtitleLanguage != null) {
                next.setPreferredTextLanguage(carriedSubtitleLanguage);
            }
            player.setTrackSelectionParameters(next.build());
            appliedRemembered = false;
            pictured = false;
            failed = false;
            player.setMediaItem(MediaItem.fromUri(url));
            player.prepare();
            player.setPlayWhenReady(true);
        }
    };

    /** Whether an episode followed another in this player, and what the one before ended with. */
    private boolean carrying = false;
    @Nullable
    private String carriedAudioTitle = null;
    @Nullable
    private String carriedSubtitleTitle = null;
    @Nullable
    private String carriedAudioLanguage = null;
    @Nullable
    private String carriedSubtitleLanguage = null;
    private boolean carriedSubtitlesOn = false;

    /** The tracks of one kind, as the rail lists them; subtitles with "Off" first. */
    private java.util.List<FilmPlayback.Track> tracksOf(int type) {
        java.util.List<FilmPlayback.Track> out = new java.util.ArrayList<>();
        if (player == null) {
            return out;
        }
        int kind = type == C.TRACK_TYPE_AUDIO ? FilmPlayback.Track.AUDIO : FilmPlayback.Track.SUBTITLES;
        java.util.List<String> labels = new java.util.ArrayList<>();
        java.util.List<Boolean> selected = new java.util.ArrayList<>();
        java.util.List<androidx.media3.common.TrackSelectionOverride> overrides = new java.util.ArrayList<>();
        boolean anySelected = false;
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() != type) {
                continue;
            }
            for (int i = 0; i < group.length; i++) {
                if (!group.isTrackSupported(i)) {
                    continue;
                }
                boolean on = group.isTrackSelected(i);
                anySelected |= on;
                labels.add(trackLabel(group.getTrackFormat(i), type));
                selected.add(on);
                overrides.add(new androidx.media3.common.TrackSelectionOverride(group.getMediaTrackGroup(), i));
            }
        }
        java.util.List<String> named = TrackNames.toldApart(labels, type == C.TRACK_TYPE_TEXT ? "track.subtitlesNumber" : "track.audioNumber");
        for (int at = 0; at < named.size(); at++) {
            out.add(new FilmPlayback.Track(kind, named.get(at), selected.get(at), overrides.get(at)));
        }
        if (type == C.TRACK_TYPE_TEXT && !out.isEmpty()) {
            out.add(0, new FilmPlayback.Track(kind, Texts.t("track.off"), !anySelected, null));
        }
        return out;
    }

    /**
     * What to call a track: its language in the app's language, then its
     * own name when that adds something ("Spanish · Latin American"), with
     * the channel layout for audio and the kind of subtitle when the stream
     * says and the file does not. '' when nothing says anything: tracksOf
     * numbers those ("Subtitles 11"), as it numbers repeats ("Spanish 2").
     */
    static String trackLabel(androidx.media3.common.Format format, int type) {
        String own = format.label == null ? "" : format.label;
        String label = TrackNames.withLanguage(TrackNames.languageName(format.language), own);
        if (TrackNames.clean(own).isEmpty()) {
            String extra = "";
            if (type == C.TRACK_TYPE_AUDIO) {
                if (format.channelCount == 6) {
                    extra = "5.1";
                } else if (format.channelCount == 8) {
                    extra = "7.1";
                }
            } else {
                if ((format.roleFlags & C.ROLE_FLAG_DESCRIBES_MUSIC_AND_SOUND) != 0) {
                    extra = "(SDH)";
                }
                if ((format.selectionFlags & C.SELECTION_FLAG_FORCED) != 0) {
                    extra = (extra + " (forced)").trim();
                }
            }
            label = (label + " " + extra).trim();
        }
        return label;
    }

    /** What ChannelSession needs of Media3. */
    /** A reminder going off while this plays (ReminderBanner). */
    private final ReminderBanner reminders = new ReminderBanner(this, new ReminderBanner.Watcher() {
        @Override
        public boolean switchTo(String streamId) {
            return session != null && session.switchToItem(streamId);
        }

        @Override
        public void openInApp(String link) {
            publishPosition();
            finish();
            startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(link), PlayerActivity.this, app.tvinto.MainActivity.class));
        }
    });

    private final ChannelSession.Engine engine = new ChannelSession.Engine() {
        @Override
        public void stopStream() {
            // Another channel: a pause of this one goes with it.
            endPause();
            if (player != null) {
                player.stop();
                player.clearMediaItems();
            }
            pictured = false;
            failed = false;
            // The tracks remembered by name belonged to the channel first opened.
            appliedRemembered = true;
        }

        @Override
        public void openStream(String url) {
            if (player == null) {
                return;
            }
            liveAddress = url;
            player.setMediaItem(MediaItem.fromUri(url));
            player.prepare();
            player.setPlayWhenReady(true);
        }

        @Override
        public void publishPosition() {
            PlayerActivity.this.publishPosition();
        }

        @Override
        public ChannelBanner.PauseState pauseState() {
            return new ChannelBanner.PauseState() {
                @Override
                public boolean canPause() {
                    return pausable();
                }

                @Override
                public boolean paused() {
                    return livePaused();
                }

                @Override
                public boolean behind() {
                    return livePaused() || behindMs > 0L;
                }
            };
        }

        @Override
        public void togglePause() {
            PlayerActivity.this.togglePause();
        }

        @Override
        public void backToLive() {
            PlayerActivity.this.backToLive();
        }

        @Override
        public void closeWithFailure(@Nullable String errorCode) {
            if (errorCode != null) {
                failed = true;
                PlaybackReports.failure(0L, errorCode);
            }
            finish();
        }

        @Override
        public boolean controlsShowing() {
            return playerView != null && playerView.isControllerFullyVisible();
        }

        @Override
        public boolean hasControls() {
            return playerView != null;
        }

        @Override
        public void showControls() {
            if (playerView != null) {
                playerView.showController();
            }
        }

        @Override
        public void hideControls() {
            if (playerView != null) {
                playerView.hideController();
            }
        }

        /**
         * Never on its own: the controller came up over the banner at every
         * arrival, and a stopped player drew its transport buttons and spinner
         * through the switching panel. OK, Menu or a tap bring it.
         */
        @Override
        public void quietWhileSwitching(boolean switching) {
            if (playerView == null) {
                return;
            }
            playerView.setControllerAutoShow(false);
            playerView.setShowBuffering(switching ? PlayerView.SHOW_BUFFERING_NEVER : PlayerView.SHOW_BUFFERING_WHEN_PLAYING);
            if (switching) {
                playerView.hideController();
            }
        }

        @Nullable
        @Override
        public View touchSurface() {
            return playerView;
        }

        @Override
        public boolean canChooseTracks() {
            return player != null && (hasTracks(C.TRACK_TYPE_AUDIO, 2) || hasTracks(C.TRACK_TYPE_TEXT, 1));
        }

        @Override
        public FilmPlayback playback() {
            return player == null ? null : filmPlayback;
        }
    };

    /** Whether the stream carries at least this many tracks of a kind. */
    private boolean hasTracks(int kind, int atLeast) {
        if (player == null) {
            return false;
        }
        int count = 0;
        for (Tracks.Group group : player.getCurrentTracks().getGroups()) {
            if (group.getType() == kind) {
                count += group.length;
            }
        }
        return count >= atLeast;
    }

    // --- Pausing live television (LivePause) -------------------------------------

    /** Whether what plays can be paused here: a live channel with an address. */
    private boolean pausable() {
        return film == null && player != null && liveAddress != null;
    }

    private boolean livePaused() {
        return pausedAt > 0L;
    }

    /**
     * Paused, or playing behind live, on a channel that is recording: its
     * recording's own file (RecordingTail), paused by Media3 itself. There is
     * no index to step by there, and no banner -- the web app opens it without
     * the channel list -- so fast forward is how it gets back to live.
     */
    private boolean behindOnRecording() {
        return livePause == null && pausable() && liveAddress.startsWith("http://127.0.0.1") && (livePaused() || behindMs > 0L);
    }

    private void togglePause() {
        if (!pausable()) {
            return;
        }
        if (livePaused()) {
            playOn();
        } else {
            pauseLive();
        }
    }

    /**
     * Play/Pause, Pause and Play on a remote, and OK while paused with nothing
     * over the picture. Null for anything else.
     */
    @Nullable
    private Boolean pauseKey(KeyEvent event) {
        if (!pausable()) {
            return null;
        }
        int code = event.getKeyCode();
        // Behind live, Left and Right (with nothing but the banner over the
        // picture) and the remote's rewind and fast forward step within what
        // was written. Held, they go on stepping.
        boolean seekKey = code == KeyEvent.KEYCODE_MEDIA_REWIND || code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD;
        boolean sideways = code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_DPAD_RIGHT;
        boolean busy = (session != null && session.showingMoreThanBanner()) || (playerView != null && playerView.isControllerFullyVisible());
        if (code == KeyEvent.KEYCODE_MEDIA_FAST_FORWARD && behindOnRecording()) {
            // Nothing to step through in a recording's tail: forward is live.
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
                backToLive();
            }
            return true;
        }
        if (livePause != null && (seekKey || (sideways && !busy))) {
            if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() % 2 == 0) {
                boolean back = code == KeyEvent.KEYCODE_DPAD_LEFT || code == KeyEvent.KEYCODE_MEDIA_REWIND;
                long by = seekKey ? 3L * STEP_MS : STEP_MS;
                stepWithin(back ? -by : by);
            }
            return true;
        }
        boolean media = code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || code == KeyEvent.KEYCODE_MEDIA_PAUSE || code == KeyEvent.KEYCODE_MEDIA_PLAY;
        boolean ok = code == KeyEvent.KEYCODE_DPAD_CENTER || code == KeyEvent.KEYCODE_ENTER || code == KeyEvent.KEYCODE_NUMPAD_ENTER;
        boolean overPicture = (session != null && session.showingAnything()) || (playerView != null && playerView.isControllerFullyVisible());
        if (!media && !(ok && livePaused() && !overPicture)) {
            return null;
        }
        if (event.getAction() == KeyEvent.ACTION_DOWN && event.getRepeatCount() == 0) {
            if (code == KeyEvent.KEYCODE_MEDIA_PAUSE) {
                if (!livePaused()) {
                    pauseLive();
                }
            } else if (code == KeyEvent.KEYCODE_MEDIA_PLAY) {
                if (livePaused()) {
                    playOn();
                }
            } else {
                togglePause();
            }
        }
        return true;
    }

    /**
     * Pauses: from the provider, the player lets go of the channel and the
     * pause takes it; already on this device (a pause, or a recording's own
     * file), the player simply stops where it is.
     */
    private void pauseLive() {
        if (player == null || liveAddress == null) {
            return;
        }
        if (stepTarget >= 0L) {
            // A step on its way goes first: the pause is where it went.
            takeStep(false);
        }
        boolean here = livePause != null || liveAddress.startsWith("http://127.0.0.1");
        if (!here) {
            // An HLS channel that is not Xtream's is written piece by piece,
            // from the piece and variant on screen, which only the player knows.
            LivePause.Hint hint = null;
            if (LivePause.continuousAddress(liveAddress) == null) {
                androidx.media3.common.Format video = player.getVideoFormat();
                hint = LivePause.hlsHint(player.getCurrentManifest(), player.getCurrentPosition(), video == null ? -1L : video.bitrate);
                if (hint == null) {
                    android.widget.Toast.makeText(this, Texts.t("live.cannotPause"), android.widget.Toast.LENGTH_LONG).show();
                    return;
                }
            }
            // Let go first: the pause takes the one connection the subscription allows.
            player.setPlayWhenReady(false);
            player.stop();
            livePause = LivePause.start(this, liveAddress, hint, null);
        } else {
            player.setPlayWhenReady(false);
        }
        pausedAt = android.os.SystemClock.elapsedRealtime();
        showPausedBadge();
    }

    /** PAUSED and how far behind live the picture now standing still is, growing. */
    private void showPausedBadge() {
        if (pauseBadge != null) {
            pauseBadge.showPaused(() -> behindNow(android.os.SystemClock.elapsedRealtime()));
        }
    }

    /** Plays on from where the pause began, behind live by however long it was paused. */
    private void playOn() {
        if (player == null || !livePaused()) {
            return;
        }
        if (stepTarget >= 0L) {
            // A step is on its way: it plays from there.
            takeStep(true);
            return;
        }
        behindMs += android.os.SystemClock.elapsedRealtime() - pausedAt;
        pausedAt = 0L;
        LivePause pause = livePause;
        if (pause != null && player.getPlaybackState() == Player.STATE_IDLE) {
            if (!pause.writing() && pause.bytes() == 0L) {
                // The channel would not come back for the pause: nothing to play but live.
                backToLive();
                return;
            }
            try {
                player.setMediaItem(MediaItem.fromUri(pause.address()));
            } catch (java.io.IOException cannotServe) {
                backToLive();
                return;
            }
            pictured = false;
            player.prepare();
            if (pause.pieces() && pause.index.first() >= 0L) {
                // Its file starts where the piece on screen began, a little before the pause.
                behindMs = android.os.SystemClock.elapsedRealtime() - pause.index.first();
            }
        }
        player.setPlayWhenReady(true);
        if (pauseBadge != null) {
            pauseBadge.showBehind(() -> behindMs);
        }
    }

    /** Leaves a pause, or playing behind, for the channel as it is now. */
    private void backToLive() {
        boolean away = livePause != null || livePaused() || behindMs > 0L;
        endPause();
        if (!away || player == null || liveAddress == null) {
            return;
        }
        // Not stopped first, as a step is not (takeStep).
        player.setMediaItem(MediaItem.fromUri(liveAddress));
        pictured = false;
        player.prepare();
        player.setPlayWhenReady(true);
    }

    /** One press of Left or Right behind live, the stock rewind and fast forward: ten seconds. */
    private static final long STEP_MS = 10_000L;
    /** A step forward to within this of the newest written is a step to live. */
    private static final long LIVE_EDGE_MS = 5_000L;
    /** Presses close together are one step, taken once they stop: the file is opened once. */
    private static final long STEP_SETTLE_MS = 450L;
    /** The moment of the channel (PauseIndex's clock) a step is going to; -1 for none. */
    private long stepTarget = -1L;
    /** Once the presses stop: paused, the step stays paused there; playing, it plays on from there. */
    private final Runnable stepNow = () -> takeStep(!livePaused());

    /** How far behind live the picture is now: paused, that grows. */
    private long behindNow(long now) {
        return behindMs + (livePaused() ? now - pausedAt : 0L);
    }

    /**
     * Back or forward within what the pause wrote, by this much: never before
     * where it began, and forward to the end is live again. The badge says
     * the new figure at once; the file opens there once the presses stop.
     */
    private void stepWithin(long by) {
        LivePause pause = livePause;
        if (pause == null || player == null || playerView == null) {
            return;
        }
        long first = pause.index.first();
        if (first < 0L) {
            return;
        }
        long now = android.os.SystemClock.elapsedRealtime();
        long from = stepTarget >= 0L ? stepTarget : now - behindNow(now);
        // An HLS channel's pieces come ahead of the clock; live is now at most.
        long newest = Math.min(pause.index.last(), now);
        if (by > 0L && from + by >= newest - LIVE_EDGE_MS) {
            backToLive();
            return;
        }
        long target = Math.max(first, Math.min(from + by, newest));
        stepTarget = target;
        if (pauseBadge != null) {
            java.util.function.LongSupplier behind = () -> android.os.SystemClock.elapsedRealtime() - target;
            if (livePaused()) {
                pauseBadge.showPaused(behind);
            } else {
                pauseBadge.showBehind(behind);
            }
        }
        playerView.removeCallbacks(stepNow);
        playerView.postDelayed(stepNow, STEP_SETTLE_MS);
    }

    /**
     * Opens the file where the steps went, and plays on from there -- or,
     * not to play, shows the frame there and stays paused on it.
     */
    private void takeStep(boolean play) {
        long target = stepTarget;
        stepTarget = -1L;
        if (playerView != null) {
            playerView.removeCallbacks(stepNow);
        }
        LivePause pause = livePause;
        PauseIndex.Spot spot = pause == null || target < 0L ? null : pause.index.at(target);
        if (spot == null || player == null) {
            return;
        }
        String address;
        try {
            address = pause.address(spot.offset);
        } catch (java.io.IOException cannotServe) {
            backToLive();
            return;
        }
        long now = android.os.SystemClock.elapsedRealtime();
        // As far behind as what is there arrived: the badge's figure is true from the first frame.
        behindMs = now - spot.arrived;
        // Paused, it stays paused from now, still that far behind: behindNow
        // adds the time since.
        pausedAt = play ? 0L : now;
        // Not stopped first: a stopped player brings up the stock controls,
        // which would then take the next Left or Right. Prepared but not
        // playing, Media3 draws the frame there and holds it.
        player.setMediaItem(MediaItem.fromUri(address));
        pictured = false;
        player.prepare();
        player.setPlayWhenReady(play);
        if (play) {
            if (pauseBadge != null) {
                pauseBadge.showBehind(() -> behindMs);
            }
        } else {
            showPausedBadge();
        }
    }

    /** Stops a pause's writing and deletes it, and forgets where it was. */
    private void endPause() {
        stepTarget = -1L;
        if (playerView != null) {
            playerView.removeCallbacks(stepNow);
        }
        LivePause pause = livePause;
        livePause = null;
        if (pause != null) {
            pause.end();
        }
        pausedAt = 0L;
        behindMs = 0L;
        if (pauseBadge != null) {
            pauseBadge.hide();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        reminders.resumed();
        if (sleep != null) {
            sleep.resumed();
        }
    }

    /**
     * Draws the picture in the shape chosen: the film's own, cropped to fill
     * the screen, stretched to it, or a ratio of its own -- which PlayerView
     * would set back to the film's at the next size it hears of, so it is put
     * back after (the listener on the player).
     */
    private void applyPicture() {
        if (playerView == null) {
            return;
        }
        playerView.setResizeMode(
            PictureMode.FILL.equals(pictureMode) ? AspectRatioFrameLayout.RESIZE_MODE_ZOOM
                : PictureMode.STRETCH.equals(pictureMode) ? AspectRatioFrameLayout.RESIZE_MODE_FILL
                : AspectRatioFrameLayout.RESIZE_MODE_FIT
        );
        AspectRatioFrameLayout frame = playerView.findViewById(androidx.media3.ui.R.id.exo_content_frame);
        if (frame == null) {
            return;
        }
        float ratio = PictureMode.ratio(pictureMode);
        if (ratio > 0) {
            frame.setAspectRatio(ratio);
        } else if (player != null) {
            VideoSize size = player.getVideoSize();
            if (size.width > 0 && size.height > 0) {
                frame.setAspectRatio(size.width * size.pixelWidthHeightRatio / size.height);
            }
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        reminders.paused();
        if (sleep != null) {
            sleep.paused();
        }
        // Closing onto the guide: the preview has it back now, still playing,
        // rather than after this screen is destroyed -- which waited for the
        // closing animation, and paused the stream on the way, so the box
        // stayed black for a second and more (the owner's TV, 10 November).
        // A pause ends here, and the channel is live again first: the preview
        // was handed the pause's deleted file, and stood still (12 November).
        // Behind the launcher, too, a pause would hold the one connection for nothing.
        backToLive();
        handBack();
        if (player != null) {
            player.setPlayWhenReady(false);
        }
        publishPosition();
    }

    /** Whether this closes onto the guide's preview, without the fade: the guide is already there behind it. */
    @Override
    public void finish() {
        super.finish();
        if (player != null && player == adopted) {
            overridePendingTransition(0, 0);
        }
    }

    /**
     * Taken from the guide's preview, it goes back there playing, as
     * TiviMate's does -- the channel it ended on, on the same connection.
     * Once, when this screen is finishing.
     */
    private void handBack() {
        if (player != null && player == adopted && !sleptOut && isFinishing()
            && player.getPlayerError() == null && player.getPlaybackState() != Player.STATE_IDLE
            && player.getPlaybackState() != Player.STATE_ENDED && player.getCurrentMediaItem() != null
            && player.getCurrentMediaItem().localConfiguration != null) {
            publishPosition();
            if (playerView != null) {
                playerView.setPlayer(null);
            }
            String current = player.getCurrentMediaItem().localConfiguration.uri.toString();
            String itemId = session != null ? session.currentItemId() : getIntent().getStringExtra(ChannelKeys.EXTRA_ITEM_ID);
            if (ChannelPreviewPlugin.giveBack(player, current, itemId)) {
                player = null;
            }
        }
    }

    @Override
    protected void onDestroy() {
        // Before releasing, or the position is read off a player that has
        // already forgotten where it was.
        publishPosition();
        endPause();
        reporter.removeCallbacks(reportTick);
        reminders.destroy();
        if (sleep != null) {
            sleep.destroy();
        }
        if (session != null) {
            session.destroy();
        }
        if (film != null) {
            film.destroy();
        }

        // Normally handed back on pause already (handBack); here for a finish that skipped it.
        handBack();

        if (player != null) {
            player.release();
            player = null;
        }
        if (playerView != null) {
            playerView.setPlayer(null);
        }

        super.onDestroy();
    }

    private static String orEmpty(@Nullable String value) {
        return value == null ? "" : value;
    }

    /**
     * A playback URL with the credentials taken out.
     *
     * Xtream puts the username and password in the path -- /live/user/pass/1.ts
     * -- so the URL is a credential, and logcat is readable by anything that
     * can take a bug report. The host goes too: the provider's address is
     * a user's as much as the password is. What is left is the part worth
     * seeing: the kind, and the file extension actually being asked for, which
     * is the whole question when a film will not open.
     */
    static String safeToLog(String url) {
        String[] parts = url.split("/");
        // scheme, "", host, kind, user, pass, file
        if (parts.length < 7) {
            return "(unrecognised url)";
        }

        StringBuilder tail = new StringBuilder();
        for (int i = 6; i < parts.length; i++) {
            tail.append('/').append(parts[i]);
        }

        return parts[0] + "//***/" + parts[3] + "/***/***" + tail;
    }

    private static int parseColour(@Nullable String value, int fallback) {
        if (value == null || value.isEmpty()) {
            return fallback;
        }
        try {
            return Color.parseColor(value);
        } catch (IllegalArgumentException ignored) {
            return fallback;
        }
    }

}
