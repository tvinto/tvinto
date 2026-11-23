package app.tvinto.player;

import android.app.Activity;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.KeyEvent;
import android.view.View;
import android.view.WindowManager;

import androidx.annotation.Nullable;

import org.videolan.libvlc.LibVLC;
import org.videolan.libvlc.Media;
import org.videolan.libvlc.MediaPlayer;
import org.videolan.libvlc.interfaces.IMedia;
import org.videolan.libvlc.util.VLCVideoLayout;

import java.util.ArrayList;

/**
 * Playback for what the platform cannot decode.
 *
 * VLC carries its own decoders rather than asking Android for one, which is the
 * entire reason this exists beside the Media3 player. A device offers whatever
 * codecs its vendor shipped: this emulator has four HEVC decoders and not one
 * of them manages 10-bit, so a 4K HEVC film -- a large part of this provider's
 * catalogue -- would not play at all. VLC decodes it in software.
 *
 * Media3 stays the default because it is leaner and uses hardware decoding when
 * hardware will have it. This is what runs when that fails, and what a viewer
 * can choose outright.
 */
public class VlcPlayerActivity extends Activity implements SleepTimerPanel.Owner {

    /** How often the position is handed back, in milliseconds. */
    private static final long REPORT_INTERVAL_MS = 10_000L;

    @Nullable
    private LibVLC libVlc;
    @Nullable
    private MediaPlayer player;

    /** The sleep timer, on a television (SleepTimerPanel). */
    @Nullable
    private SleepTimerPanel sleep = null;

    @Nullable
    @Override
    public SleepTimerPanel sleepTimer() {
        return sleep;
    }
    @Nullable
    private VLCVideoLayout videoLayout;

    private volatile boolean failed = false;

    /** Changing channel without leaving the player, as in PlayerActivity. See ChannelSession. */
    @Nullable
    private ChannelSession session = null;

    /** The same film controls as the Media3 player's (design section 5b). VLC has none of its own. */
    @Nullable
    private FilmControls film = null;

    private final android.os.Handler reporter =
        new android.os.Handler(android.os.Looper.getMainLooper());

    private final Runnable reportTick = new Runnable() {
        @Override
        public void run() {
            publishPosition();
            reporter.postDelayed(this, REPORT_INTERVAL_MS);
        }
    };

    /** A live channel with no picture yet: failed once StartWatch's time is up, as in PlayerActivity. */
    private final StartWatch startWatch = new StartWatch(reporter, () -> {
        if (isFinishing() || film != null) {
            return;
        }
        android.util.Log.e("TvintoPlayer", "VLC: no picture in " + StartWatch.TIMEOUT_MS + " ms; giving up");
        if (session != null && session.onFailure(StartWatch.CODE)) {
            return;
        }
        failed = true;
        PlaybackReports.failure(0L, StartWatch.CODE);
        finish();
    });

    @Override
    protected void onCreate(@Nullable Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        Texts.use(getIntent().getStringExtra(PlayerActivity.EXTRA_LANGUAGE), getIntent().getStringExtra(PlayerActivity.EXTRA_TEXTS));

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        goFullScreen();

        setContentView(app.tvinto.R.layout.activity_vlc_player);
        videoLayout = findViewById(app.tvinto.R.id.vlc_video_layout);

        Intent intent = getIntent();
        String url = intent.getStringExtra(PlayerActivity.EXTRA_URL);
        if (url == null || url.isEmpty()) {
            finish();
            return;
        }

        android.util.Log.i("TvintoPlayer", "Opening with VLC " + PlayerActivity.safeToLog(url));

        libVlc = new LibVLC(this, vlcOptions(intent));
        player = new MediaPlayer(libVlc);
        player.attachViews(videoLayout, null, false, false);
        pictureFor(url);
        session = ChannelSession.start(this, engine);
        film = FilmControls.start(this, filmPlayback);
        frameRate = FrameRateMatch.start(this);
        // After the film's controls and the channel's banner, so it draws over them.
        sleep = SleepTimerPanel.forTelevision(this, new SleepTimerPanel.Host() {
            @Override
            public void setVolume(float volume) {
                if (player != null) {
                    player.setVolume(Math.round(volume * 100f));
                }
            }

            @Override
            public void stopForSleep() {
                // Paused, as in PlayerActivity: stopped, VLC reports the film's
                // position as 0 when closing reports it again.
                publishPosition();
                if (player != null) {
                    player.pause();
                }
                // Behind the launcher, as in PlayerActivity.
                moveTaskToBack(true);
                finish();
            }
        });

        player.setEventListener(event -> {
            if (event.type == MediaPlayer.Event.Vout && event.getVoutCount() > 0) {
                matchFrameRate();
                // The video's size is known now, which Fill screen needs.
                applyPicture();
                // VLC's nearest thing to a first frame: a video output exists.
                startWatch.disarm();
                if (session != null) {
                    session.onFirstFrame();
                }
                if (film != null) {
                    film.onFirstFrame();
                }
            } else if (event.type == MediaPlayer.Event.Playing || event.type == MediaPlayer.Event.Paused) {
                boolean playing = event.type == MediaPlayer.Event.Playing;
                if (session != null) {
                    session.onPlaying(playing);
                }
                if (film != null) {
                    film.onPlaying(playing);
                    film.onPaused(!playing);
                }
            } else if (event.type == MediaPlayer.Event.Buffering) {
                if (film != null) {
                    film.onBuffering(event.getBuffering() < 100f);
                }
            } else if (event.type == MediaPlayer.Event.ESAdded
                || event.type == MediaPlayer.Event.ESDeleted
                || event.type == MediaPlayer.Event.ESSelected) {
                matchFrameRate();
                applyPicture();
                if (film != null) {
                    film.onTracksChanged();
                }
            } else if (event.type == MediaPlayer.Event.EndReached) {
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
            } else if (event.type == MediaPlayer.Event.EncounteredError) {
                if (session != null && session.onFailure("VLC could not play this")) {
                    android.util.Log.e("TvintoPlayer", "VLC could not play a switched channel");
                    return;
                }
                if (film != null && film.onOpenFailed("VLC could not play this")) {
                    return;
                }
                // VLC does not say what went wrong in any structured way, so
                // there is nothing more specific to pass on than the fact.
                failed = true;
                PlaybackReports.failure(currentPositionSeconds(), "VLC could not play this");
                android.util.Log.e("TvintoPlayer", "VLC playback failed");
                finish();
            }
        });

        openAt(url, intent.getLongExtra(PlayerActivity.EXTRA_START_AT, 0L));

        reporter.postDelayed(reportTick, REPORT_INTERVAL_MS);
    }

    /** The television's refresh rate, matched to what plays. See FrameRateMatch. */
    @Nullable
    private FrameRateMatch frameRate = null;

    /** The rate VLC read from the video track, once it has one. */
    private void matchFrameRate() {
        if (player == null || frameRate == null) {
            return;
        }
        org.videolan.libvlc.interfaces.IMedia.VideoTrack track = player.getCurrentVideoTrack();
        if (track != null && track.frameRateDen > 0 && track.frameRateNum > 0) {
            frameRate.onDeclaredRate((float) track.frameRateNum / track.frameRateDen);
        }
    }

    private void open(String url) {
        openAt(url, 0L);
    }

    /** The picture's shape (PictureMode), and the address it is remembered for. */
    private String pictureMode = PictureMode.ORIGINAL;
    @Nullable
    private String pictureUrl;

    /** Takes up the shape remembered for an address; the next episode keeps the last one's otherwise. */
    private void pictureFor(String url) {
        String own = PictureMode.remembered(this, url);
        if (pictureUrl == null || !PictureMode.ORIGINAL.equals(own)) {
            pictureMode = own;
        }
        pictureUrl = url;
        applyPicture();
    }

    /**
     * Draws the picture in the shape chosen, by sizing the video's view
     * rather than through VLC: VLC's own shapes and aspect ratio did nothing
     * on the emulator, whose output says "request not implemented" to them
     * (21 October), and which output a television uses is the device's.
     * VLC fits the film into the view as it always does; the view is then
     * stretched, squeezed or enlarged into the shape asked for.
     */
    private void applyPicture() {
        if (player == null || videoLayout == null) {
            return;
        }
        float width = videoLayout.getWidth();
        float height = videoLayout.getHeight();
        IMedia.VideoTrack video = player.getCurrentVideoTrack();
        android.view.View surface = surfaceIn(videoLayout);
        float scaleX = 1f;
        float scaleY = 1f;
        // The film's own shape: from VLC when it says (often 0 x 0 for a
        // stream), else from the surface it draws on, which VLC sizes to the
        // film when it renders straight to it.
        float own = 0f;
        if (video != null && video.width > 0 && video.height > 0) {
            float sar = video.sarNum > 0 && video.sarDen > 0 ? (float) video.sarNum / video.sarDen : 1f;
            own = video.width * sar / video.height;
        } else if (surface != null && surface.getWidth() > 0 && surface.getHeight() > 0) {
            own = (float) surface.getWidth() / surface.getHeight();
        }
        if (width > 0 && height > 0 && own > 0) {
            // The box VLC draws the film in: fitted to the view.
            float shownWidth = own > width / height ? width : height * own;
            float shownHeight = own > width / height ? width / own : height;
            float wantedWidth = shownWidth;
            float wantedHeight = shownHeight;
            float ratio = PictureMode.ratio(pictureMode);
            if (ratio > 0) {
                wantedWidth = ratio > width / height ? width : height * ratio;
                wantedHeight = ratio > width / height ? width / ratio : height;
            } else if (PictureMode.STRETCH.equals(pictureMode)) {
                wantedWidth = width;
                wantedHeight = height;
            } else if (PictureMode.FILL.equals(pictureMode)) {
                float cover = Math.max(width / shownWidth, height / shownHeight);
                wantedWidth = shownWidth * cover;
                wantedHeight = shownHeight * cover;
            }
            scaleX = wantedWidth / shownWidth;
            scaleY = wantedHeight / shownHeight;
        }
        videoLayout.setPivotX(width / 2f);
        videoLayout.setPivotY(height / 2f);
        videoLayout.setScaleX(scaleX);
        videoLayout.setScaleY(scaleY);
    }

    /** The surface VLC draws the video on, inside its layout. */
    @Nullable
    private static android.view.View surfaceIn(android.view.View view) {
        if (view instanceof android.view.SurfaceView || view instanceof android.view.TextureView) {
            return view;
        }
        if (view instanceof android.view.ViewGroup) {
            android.view.ViewGroup group = (android.view.ViewGroup) view;
            for (int i = 0; i < group.getChildCount(); i++) {
                android.view.View found = surfaceIn(group.getChildAt(i));
                if (found != null) {
                    return found;
                }
            }
        }
        return null;
    }

    /**
     * Opens a stream, at a position when there is one.
     *
     * The position is part of the media (`:start-time`) rather than a seek
     * after play(). The seek was ignored whenever the stream had not opened
     * yet, which on the provider is a matter of luck: S4 E13 resumed at 1:11
     * once and then, the next time, started over from the recap and wrote
     * 1:26 over 4:24 (26 September).
     */
    private void openAt(String url, long startSeconds) {
        if (player == null || libVlc == null) {
            return;
        }
        if (frameRate != null) {
            frameRate.restart();
        }
        Media media = new Media(libVlc, Uri.parse(url));
        if (film == null) {
            startWatch.arm();
        }
        if (startSeconds > 0) {
            media.addOption(":start-time=" + startSeconds);
        }

        // Try hardware, fall back to software. The second argument is "force":
        // false, because the hardware decoder is exactly what failed to get us
        // here, and being locked to it would fail the same way. Where hardware
        // does work -- a real television box -- this is far cheaper than
        // decoding on the CPU.
        media.setHWDecoderEnabled(true, false);

        // Subtitles the account added, as slaves beside the stream. Added
        // before the media is set, so they are there from the first frame.
        // Only for the first thing opened: they were added for that one, not for
        // an episode that followed it.
        for (AddedSubtitles.Added subtitle : openedOnce ? java.util.Collections.<AddedSubtitles.Added>emptyList() : AddedSubtitles.from(getIntent())) {
            media.addSlave(new org.videolan.libvlc.interfaces.IMedia.Slave(
                org.videolan.libvlc.interfaces.IMedia.Slave.Type.Subtitle, 4, subtitle.uri().toString()));
        }
        openedOnce = true;

        // An episode that followed another: the languages that one ended with,
        // as options on this media, which outrank the player's own.
        if (carrying) {
            if (carriedAudioLanguage != null) {
                media.addOption(":audio-language=" + carriedAudioLanguage);
            }
            if (carriedSubtitlesOn) {
                media.addOption(":spu");
                if (carriedSubtitleLanguage != null) {
                    media.addOption(":sub-language=" + carriedSubtitleLanguage);
                }
            } else {
                media.addOption(":no-spu");
            }
        }

        player.setMedia(media);
        // Released here rather than kept: the player retains what it needs, and
        // holding a second reference leaks the whole demuxer.
        media.release();

        player.play();
    }

    /** Whether something has been opened already; see the added subtitles above. */
    private boolean openedOnce = false;

    /** Whether an episode followed another in this player, and the languages the one before ended with. */
    private boolean carrying = false;
    @Nullable
    private String carriedAudioLanguage = null;
    @Nullable
    private String carriedSubtitleLanguage = null;
    private boolean carriedSubtitlesOn = false;

    /** The subtitle delay asked for, kept to say it back: VLC is told it as it changes. */
    private long subtitleDelayMs = 0L;

    /** What FilmControls needs of VLC. */
    private final FilmPlayback filmPlayback = new FilmPlayback() {
        /** VLC places its own subtitles. */
        @Override
        public void liftSubtitles(float share) {
        }

        @Override
        public long positionMs() {
            return player == null ? 0L : Math.max(0L, player.getTime());
        }

        @Override
        public long durationMs() {
            return player == null ? 0L : Math.max(0L, player.getLength());
        }

        @Override
        public boolean isPlaying() {
            return player != null && player.isPlaying();
        }

        @Override
        public void setPlaying(boolean playing) {
            if (player == null) {
                return;
            }
            if (playing) {
                player.play();
            } else {
                player.pause();
            }
        }

        @Override
        public void seekTo(long positionMs) {
            if (player != null) {
                player.setTime(Math.max(0L, positionMs));
            }
        }

        /** The tracks with their labels told apart (TrackNames.toldApart): "Spanish", "Spanish 2", "Audio 3". */
        private java.util.List<Track> named(java.util.List<Track> tracks, java.util.List<String> labels, String unnamedKey) {
            java.util.List<String> told = TrackNames.toldApart(labels, unnamedKey);
            java.util.List<Track> out = new java.util.ArrayList<>(tracks.size());
            for (int at = 0; at < tracks.size(); at++) {
                Track track = tracks.get(at);
                String own = labels.get(at) == null ? "" : labels.get(at).trim();
                out.add(new Track(track.kind, told.get(at), track.inUse, track.handle, own.isEmpty(), false));
            }
            return out;
        }

        @Override
        public java.util.List<Track> audioTracks() {
            java.util.List<Track> out = new java.util.ArrayList<>();
            if (player == null) {
                return out;
            }
            MediaPlayer.TrackDescription[] tracks = player.getAudioTracks();
            int current = player.getAudioTrack();
            java.util.List<String> labels = new java.util.ArrayList<>();
            if (tracks != null) {
                for (MediaPlayer.TrackDescription track : tracks) {
                    // -1 is VLC's "Disable", which is not a thing to offer for sound.
                    if (track.id >= 0) {
                        labels.add(TrackNames.fromVlc(track.name));
                        out.add(new Track(Track.AUDIO, "", track.id == current, track.id));
                    }
                }
            }
            return named(out, labels, "track.audioNumber");
        }

        @Override
        public java.util.List<Track> subtitleTracks() {
            java.util.List<Track> out = new java.util.ArrayList<>();
            if (player == null) {
                return out;
            }
            MediaPlayer.TrackDescription[] tracks = player.getSpuTracks();
            int current = player.getSpuTrack();
            java.util.List<String> labels = new java.util.ArrayList<>();
            if (tracks != null) {
                for (MediaPlayer.TrackDescription track : tracks) {
                    if (track.id >= 0) {
                        labels.add(TrackNames.fromVlc(track.name));
                        out.add(new Track(Track.SUBTITLES, "", track.id == current, track.id));
                    }
                }
            }
            out = named(out, labels, "track.subtitlesNumber");
            if (!out.isEmpty()) {
                out.add(0, new Track(Track.SUBTITLES, Texts.t("track.off"), current < 0, null));
            }
            return out;
        }

        @Override
        public void choose(Track track) {
            if (player == null) {
                return;
            }
            if (track.kind == Track.AUDIO && track.handle != null) {
                player.setAudioTrack((Integer) track.handle);
            } else if (track.kind == Track.SUBTITLES) {
                player.setSpuTrack(track.handle == null ? -1 : (Integer) track.handle);
            }
            publishTracks();
        }

        @Override
        public long subtitleDelayMs() {
            return subtitleDelayMs;
        }

        /** VLC has it built in, in microseconds, either way (SubtitleDelay for Media3's). */
        @Override
        public void setSubtitleDelay(long ms) {
            subtitleDelayMs = SubtitleDelay.clamp(ms);
            if (player != null) {
                player.setSpuDelay(subtitleDelayMs * 1000L);
            }
        }

        @Override
        public String pictureMode() {
            return pictureMode;
        }

        @Override
        public void setPictureMode(String mode) {
            pictureMode = mode;
            PictureMode.remember(VlcPlayerActivity.this, pictureUrl, mode);
            applyPicture();
        }

        @Override
        public float speed() {
            return player == null ? 1f : player.getRate();
        }

        @Override
        public void setSpeed(float speed) {
            if (player != null) {
                player.setRate(speed);
            }
        }

        @Override
        public void close() {
            publishPosition();
            finish();
        }

        @Override
        public void stop() {
            if (player != null) {
                // The next episode opens with the languages this one ended
                // with. The player's own options were set from what was asked
                // for at the start, so a subtitle turned on part way through
                // was lost at the next episode.
                try {
                    int spu = player.getSpuTrack();
                    carriedAudioLanguage = languageOf(player.getAudioTrack(), IMedia.Track.Type.Audio);
                    carriedSubtitleLanguage = spu >= 0 ? languageOf(spu, IMedia.Track.Type.Text) : null;
                    carriedSubtitlesOn = spu >= 0;
                    carrying = true;
                } catch (Exception ignored) {
                    // Nothing to carry; the options from the start stand.
                }
                player.stop();
            }
        }

        @Override
        public void open(String url) {
            failed = false;
            pictureFor(url);
            VlcPlayerActivity.this.open(url);
        }
    };

    /** What ChannelSession needs of VLC, which has no controls of its own here. */
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
            startActivity(new Intent(Intent.ACTION_VIEW, android.net.Uri.parse(link), VlcPlayerActivity.this, app.tvinto.MainActivity.class));
        }
    });

    private final ChannelSession.Engine engine = new ChannelSession.Engine() {
        @Override
        public void stopStream() {
            startWatch.disarm();
            if (player != null) {
                player.stop();
            }
            failed = false;
        }

        @Override
        public void openStream(String url) {
            open(url);
        }

        /** Not here: a live channel plays in Media3, which pauses one (LivePause). */
        @Override
        public ChannelBanner.PauseState pauseState() {
            return new ChannelBanner.PauseState() {
                @Override
                public boolean canPause() {
                    return false;
                }

                @Override
                public boolean paused() {
                    return false;
                }

                @Override
                public boolean behind() {
                    return false;
                }
            };
        }

        @Override
        public void togglePause() {
            // Nothing to pause here.
        }

        @Override
        public void backToLive() {
            // Never behind here.
        }

        @Override
        public void publishPosition() {
            VlcPlayerActivity.this.publishPosition();
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
            return false;
        }

        @Override
        public boolean hasControls() {
            return false;
        }

        @Override
        public void showControls() {}

        @Override
        public void hideControls() {}

        @Override
        public void quietWhileSwitching(boolean switching) {}

        @Nullable
        @Override
        public View touchSurface() {
            return videoLayout;
        }

        /** The same tracks a film on VLC lists (FilmControls), so a channel here has Audio & subtitles too. */
        @Override
        public FilmPlayback playback() {
            return player == null ? null : filmPlayback;
        }

        @Override
        public boolean canChooseTracks() {
            return filmPlayback.audioTracks().size() > 1 || !filmPlayback.subtitleTracks().isEmpty();
        }
    };

    /**
     * How VLC is configured, including subtitle appearance.
     *
     * Subtitle styling is a construction option here rather than a property to
     * set later -- VLC builds its text renderer once. That is why these are read
     * off the intent before anything starts, and why changing them takes effect
     * on the next thing played rather than immediately.
     */
    private ArrayList<String> vlcOptions(Intent intent) {
        ArrayList<String> options = new ArrayList<>();

        // Nothing from VLC itself. Its log names every address it opens and
        // every redirect it follows, and the provider's carry the account's
        // credentials -- found in the emulator's log, 26 September. Failures
        // are logged by this app, with the address masked (PlayerActivity).
        options.add("--quiet");

        /*
         * Everything that makes a software decode cheaper.
         *
         * This player runs precisely when the platform could not decode
         * something, which means the work is being done on the CPU and the
         * question is whether it can keep up. On the television emulator a 4K
         * HEVC film decodes correctly and arrives several seconds late, every
         * frame dropped, leaving a black screen -- VLC's own log says "computer
         * too slow?" and is right.
         *
         * skiploopfilter drops the deblocking filter, which is a large part of
         * HEVC decode cost and costs some sharpness. `fast` permits shortcuts
         * that are not quite standards-compliant and are imperceptible in
         * practice. Threads at zero means one per core rather than VLC's
         * conservative guess.
         *
         * None of this will rescue 4K on an emulator. It is the difference
         * between playing and not on a modest real device.
         */
        options.add("--avcodec-fast");
        options.add("--avcodec-skiploopfilter=all");
        options.add("--avcodec-threads=0");

        // The stored size is a percentage; VLC takes the same scale directly.
        int scale = intent.getIntExtra(PlayerActivity.EXTRA_SUBTITLE_SCALE, 100);
        options.add("--sub-text-scale=" + Math.max(10, Math.min(500, scale)));

        int colour = parseColour(intent.getStringExtra(PlayerActivity.EXTRA_SUBTITLE_COLOUR));
        options.add("--freetype-color=" + colour);

        String background = orEmpty(intent.getStringExtra(PlayerActivity.EXTRA_SUBTITLE_BACKGROUND));
        if ("solid".equals(background)) {
            options.add("--freetype-background-opacity=255");
        } else if ("translucent".equals(background)) {
            options.add("--freetype-background-opacity=160");
        } else {
            options.add("--freetype-background-opacity=0");
        }

        String edge = orEmpty(intent.getStringExtra(PlayerActivity.EXTRA_SUBTITLE_EDGE));
        if ("outline".equals(edge)) {
            options.add("--freetype-outline-thickness=4");
            options.add("--freetype-shadow-opacity=0");
        } else if ("shadow".equals(edge)) {
            options.add("--freetype-outline-thickness=0");
            options.add("--freetype-shadow-opacity=190");
        } else {
            options.add("--freetype-outline-thickness=0");
            options.add("--freetype-shadow-opacity=0");
        }

        String audioLanguage = orEmpty(intent.getStringExtra(PlayerActivity.EXTRA_AUDIO_LANGUAGE));
        if (!audioLanguage.isEmpty()) {
            options.add("--audio-language=" + audioLanguage);
        }

        boolean subtitlesOn = intent.getBooleanExtra(PlayerActivity.EXTRA_SUBTITLES_ENABLED, false);
        String subtitleLanguage =
            orEmpty(intent.getStringExtra(PlayerActivity.EXTRA_SUBTITLE_LANGUAGE));
        if (subtitlesOn && !subtitleLanguage.isEmpty()) {
            options.add("--sub-language=" + subtitleLanguage);
        } else if (!subtitlesOn) {
            options.add("--no-spu");
        }

        return options;
    }

    private long currentPositionSeconds() {
        return player == null ? 0L : Math.max(0L, player.getTime()) / 1000L;
    }

    private void publishPosition() {
        if (player == null || failed) {
            return;
        }

        long length = player.getLength();
        // Live has no length to speak of, and VLC reports zero or less for it.
        // Zero already means "unknown" everywhere above.
        long runtime = length > 0 ? length / 1000L : 0L;

        long position = currentPositionSeconds();
        PlaybackReports.position(position, runtime);
        PlaybackCheckpoint.reached(this, position, runtime);
        publishTracks();
    }

    /**
     * Writes down the tracks it ended up playing: each one's language, as the
     * file declares it, and the file's own name for it.
     *
     * Not guessed from VLC's description of a track -- "Track 2 - Croatian" is
     * a label -- but read from the media's own list of tracks, which carries
     * the declared language code. It used to say only whether subtitles were
     * on, so English audio and English subtitles chosen in one episode of
     * Supernatural came back as German and German in the next (26
     * September). A language nobody declared stays null.
     */
    private void publishTracks() {
        if (player == null) {
            return;
        }

        try {
            int audio = player.getAudioTrack();
            // -1 is libVLC's "no subtitle track".
            int spu = player.getSpuTrack();
            boolean subtitles = spu >= 0;
            PlaybackReports.tracks(
                languageOf(audio, IMedia.Track.Type.Audio),
                subtitles ? languageOf(spu, IMedia.Track.Type.Text) : null,
                ownNameOf(player.getAudioTracks(), audio),
                subtitles ? ownNameOf(player.getSpuTracks(), spu) : null,
                subtitles
            );
        } catch (Exception ignored) {
            // An older libVLC, or a player already torn down. Saying nothing
            // leaves whatever was remembered alone, which is the safe answer.
        }
    }

    /** The declared language of the track VLC knows by this id, or null. */
    @Nullable
    private String languageOf(int id, int type) {
        if (player == null || id < 0) {
            return null;
        }
        IMedia media = player.getMedia();
        if (media == null) {
            return null;
        }
        try {
            for (int i = 0; i < media.getTrackCount(); i++) {
                IMedia.Track track = media.getTrack(i);
                if (track != null && track.id == id && track.type == type) {
                    String language = track.language == null ? "" : track.language.trim();
                    return language.isEmpty() || "und".equals(language) ? null : language;
                }
            }
            return null;
        } finally {
            media.release();
        }
    }

    @Nullable
    private static String ownNameOf(@Nullable MediaPlayer.TrackDescription[] tracks, int id) {
        if (tracks == null || id < 0) {
            return null;
        }
        for (MediaPlayer.TrackDescription track : tracks) {
            if (track.id == id) {
                return TrackNames.ownNameFromVlc(track.name);
            }
        }
        return null;
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

    /** Channel keys, as in PlayerActivity. This player has no controls to be showing. */
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
        if (session != null) {
            Boolean handled = session.onKey(event);
            if (handled != null) {
                return handled;
            }
        }
        if (event.getAction() == KeyEvent.ACTION_DOWN
            && event.getRepeatCount() == 0
            && getIntent().getBooleanExtra(ChannelKeys.EXTRA, false)) {
            String step = ChannelKeys.stepFor(event.getKeyCode(), false);
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

    @Override
    protected void onResume() {
        super.onResume();
        reminders.resumed();
        if (sleep != null) {
            sleep.resumed();
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
        reminders.paused();
        if (sleep != null) {
            sleep.paused();
        }
        if (player != null && player.isPlaying()) {
            player.pause();
        }
        publishPosition();
    }

    @Override
    protected void onDestroy() {
        publishPosition();
        reporter.removeCallbacks(reportTick);
        startWatch.disarm();
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

        if (player != null) {
            player.stop();
            player.detachViews();
            player.release();
            player = null;
        }
        if (libVlc != null) {
            libVlc.release();
            libVlc = null;
        }

        super.onDestroy();
    }

    private static String orEmpty(@Nullable String value) {
        return value == null ? "" : value;
    }

    /** VLC wants a colour as an integer, and has no use for the alpha byte. */
    private static int parseColour(@Nullable String value) {
        if (value == null || value.isEmpty()) {
            return 0xFFFFFF;
        }
        try {
            return android.graphics.Color.parseColor(value) & 0xFFFFFF;
        } catch (IllegalArgumentException ignored) {
            return 0xFFFFFF;
        }
    }
}
