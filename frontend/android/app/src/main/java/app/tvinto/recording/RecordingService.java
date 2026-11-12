package app.tvinto.recording;

import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.app.Service;
import android.content.Context;
import android.content.Intent;
import android.content.pm.ServiceInfo;
import android.os.Build;
import android.os.IBinder;

import androidx.annotation.Nullable;
import androidx.core.app.NotificationCompat;
import androidx.core.app.ServiceCompat;

import org.json.JSONException;
import org.json.JSONObject;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Records a live channel to a file while the programme lasts (private plan:
 * recording). A foreground service, so Android does not stop it while
 * somebody watches something else or the television sits idle: the web app
 * behind it is held back in the background and could not do this.
 *
 * The stream is saved as it arrives -- MPEG-TS, written as is -- so a TV box
 * can do it without decoding anything. A dropped connection is opened again,
 * with a growing pause, until the programme's end. Beside each recording, a
 * small JSON file says what it is and how far it got (`Recordings.read`).
 *
 * A stream address carries the provider's login: it is never logged, and
 * never written beside the recording.
 *
 * Its type is specialUse: dataSync, the obvious one, may run only six hours
 * a day from Android 15, and a day of recordings can be longer.
 */
public class RecordingService extends Service {

    static final String ACTION_START = "app.tvinto.recording.START";
    static final String ACTION_STOP = "app.tvinto.recording.STOP";
    static final String EXTRA_ID = "id";
    static final String EXTRA_URL = "url";
    static final String EXTRA_TITLE = "title";
    static final String EXTRA_CHANNEL = "channel";
    static final String EXTRA_CHANNEL_ID = "channelId";
    static final String EXTRA_ENDS_AT = "endsAt";

    private static final String CHANNEL_ID = "recordings";
    private static final int NOTIFICATION_ID = 7310;
    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 20_000;
    private static final long LONGEST_PAUSE_MS = 15_000L;

    /** What is being recorded now, by id. */
    private final Map<String, Recorder> running = new ConcurrentHashMap<>();

    /** Told whenever a recording starts, moves on or ends (RecorderPlugin). */
    interface Listener {
        void changed(String id);
    }

    @Nullable
    static volatile Listener listener;

    @Nullable
    @Override
    public IBinder onBind(Intent intent) {
        return null;
    }

    @Override
    public int onStartCommand(@Nullable Intent intent, int flags, int startId) {
        goForeground();
        if (intent == null) {
            stopIfIdle();
            return START_NOT_STICKY;
        }
        String id = intent.getStringExtra(EXTRA_ID);
        if (ACTION_START.equals(intent.getAction()) && id != null && !running.containsKey(id)) {
            Recorder recorder = new Recorder(
                id,
                intent.getStringExtra(EXTRA_URL),
                orEmpty(intent.getStringExtra(EXTRA_TITLE)),
                orEmpty(intent.getStringExtra(EXTRA_CHANNEL)),
                orEmpty(intent.getStringExtra(EXTRA_CHANNEL_ID)),
                intent.getLongExtra(EXTRA_ENDS_AT, 0L));
            running.put(id, recorder);
            recorder.start();
            refreshNotification();
        } else if (ACTION_STOP.equals(intent.getAction()) && id != null) {
            Recorder recorder = running.get(id);
            if (recorder != null) {
                recorder.stopNow();
            }
        }
        stopIfIdle();
        return START_NOT_STICKY;
    }

    static boolean isRecording(String id) {
        return RUNNING_IDS.containsKey(id);
    }

    /** The recordings running now, by id. */
    static java.util.Set<String> runningIds() {
        return new java.util.HashSet<>(RUNNING_IDS.keySet());
    }

    /** Ids being recorded, across instances: what list() reports as recording. */
    private static final Map<String, Boolean> RUNNING_IDS = new ConcurrentHashMap<>();

    private void goForeground() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && manager != null) {
            manager.createNotificationChannel(new NotificationChannel(CHANNEL_ID, "Recordings", NotificationManager.IMPORTANCE_LOW));
        }
        ServiceCompat.startForeground(this, NOTIFICATION_ID, notification(),
            Build.VERSION.SDK_INT >= 34 ? ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE : 0);
    }

    private Notification notification() {
        StringBuilder titles = new StringBuilder();
        for (Recorder recorder : running.values()) {
            if (titles.length() > 0) {
                titles.append(", ");
            }
            titles.append(recorder.title.isEmpty() ? recorder.channel : recorder.title);
        }
        Intent open = getPackageManager().getLaunchIntentForPackage(getPackageName());
        PendingIntent tap = open == null ? null : PendingIntent.getActivity(this, 0, open, PendingIntent.FLAG_IMMUTABLE);
        return new NotificationCompat.Builder(this, CHANNEL_ID)
            .setSmallIcon(android.R.drawable.presence_video_online)
            .setContentTitle("Recording")
            .setContentText(titles.length() > 0 ? titles.toString() : "Starting")
            .setOngoing(true)
            .setContentIntent(tap)
            .build();
    }

    private void refreshNotification() {
        NotificationManager manager = (NotificationManager) getSystemService(Context.NOTIFICATION_SERVICE);
        if (manager != null && !running.isEmpty()) {
            manager.notify(NOTIFICATION_ID, notification());
        }
    }

    private void stopIfIdle() {
        if (running.isEmpty()) {
            ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE);
            stopSelf();
        }
    }

    private void finished(Recorder recorder) {
        running.remove(recorder.id);
        RUNNING_IDS.remove(recorder.id);
        Listener told = listener;
        if (told != null) {
            told.changed(recorder.id);
        }
        // Back on the main thread for the notification and stopping.
        new android.os.Handler(getMainLooper()).post(() -> {
            refreshNotification();
            stopIfIdle();
        });
    }

    private static String orEmpty(@Nullable String text) {
        return text == null ? "" : text;
    }

    /** One recording: its thread, its file, and what it says about itself. */
    private final class Recorder extends Thread {
        final String id;
        @Nullable
        final String url;
        final String title;
        final String channel;
        /** The app's id for the channel, so watching it can use the recording (RecordingTail). */
        final String channelId;
        final long endsAt;
        private volatile boolean stopped;
        private volatile HttpURLConnection connection;
        private long bytes;
        private int reconnects;
        /** The drive this recording is written to, chosen when it starts: a choice made later does not split it. */
        private File dir;

        Recorder(String id, @Nullable String url, String title, String channel, String channelId, long endsAt) {
            super("Recording");
            this.id = id;
            this.url = url;
            this.title = title;
            this.channel = channel;
            this.channelId = channelId;
            this.endsAt = endsAt;
            RUNNING_IDS.put(id, Boolean.TRUE);
        }

        void stopNow() {
            stopped = true;
            HttpURLConnection open = connection;
            if (open != null) {
                open.disconnect();
            }
        }

        @Override
        public void run() {
            dir = Recordings.dir(RecordingService.this);
            File video = new File(dir, id + ".ts");
            long startedAt = System.currentTimeMillis();
            String failure = null;
            long pause = 2_000L;
            describe("recording", startedAt, null);
            try (OutputStream out = new FileOutputStream(video, true)) {
                while (!stopped && System.currentTimeMillis() < endsAt && url != null) {
                    try {
                        HttpURLConnection open = (HttpURLConnection) new URL(url).openConnection();
                        connection = open;
                        open.setConnectTimeout(CONNECT_TIMEOUT_MS);
                        open.setReadTimeout(READ_TIMEOUT_MS);
                        int status = open.getResponseCode();
                        if (status != 200) {
                            // A refusal is said by its status only, never with the address.
                            failure = "HTTP " + status;
                            throw new IOException(failure);
                        }
                        String type = open.getContentType();
                        if (type != null && type.toLowerCase(java.util.Locale.ROOT).contains("mpegurl")) {
                            // HLS: a playlist naming pieces, not the picture. Asking again will not change it.
                            failure = "the channel is a playlist (HLS), which cannot be recorded yet";
                            stopped = true;
                            throw new IOException(failure);
                        }
                        failure = null;
                        pause = 2_000L;
                        try (InputStream in = open.getInputStream()) {
                            byte[] buffer = new byte[64 * 1024];
                            long lastNote = System.currentTimeMillis();
                            int read;
                            while (!stopped && System.currentTimeMillis() < endsAt && (read = in.read(buffer)) >= 0) {
                                out.write(buffer, 0, read);
                                bytes += read;
                                if (System.currentTimeMillis() - lastNote > 10_000L) {
                                    lastNote = System.currentTimeMillis();
                                    describe("recording", startedAt, null);
                                }
                            }
                        }
                    } catch (IOException dropped) {
                        if (failure == null) {
                            failure = "connection dropped";
                        }
                    } finally {
                        HttpURLConnection open = connection;
                        connection = null;
                        if (open != null) {
                            open.disconnect();
                        }
                    }
                    if (!stopped && System.currentTimeMillis() < endsAt) {
                        reconnects++;
                        sleepQuietly(Math.min(pause, endsAt - System.currentTimeMillis()));
                        pause = Math.min(LONGEST_PAUSE_MS, pause * 2);
                    }
                }
            } catch (IOException cannotWrite) {
                failure = "could not write the recording";
            }
            describe(bytes > 0 ? "done" : "failed", startedAt, bytes > 0 ? null : failure);
            finished(this);
        }

        private void describe(String state, long startedAt, @Nullable String failure) {
            JSONObject about = new JSONObject();
            try {
                about.put("id", id);
                about.put("title", title);
                about.put("channel", channel);
                about.put("channelId", channelId);
                about.put("startedAt", startedAt);
                about.put("endsAt", endsAt);
                about.put("state", state);
                about.put("bytes", bytes);
                about.put("reconnects", reconnects);
                if (failure != null) {
                    about.put("failure", failure);
                }
            } catch (JSONException ignored) {
                return;
            }
            File file = new File(dir != null ? dir : Recordings.dir(RecordingService.this), id + ".json");
            try (OutputStream out = new FileOutputStream(file, false)) {
                out.write(about.toString().getBytes(StandardCharsets.UTF_8));
            } catch (IOException ignored) {
                // The recording goes on; only its description is late.
            }
            Listener told = listener;
            if (told != null) {
                told.changed(id);
            }
        }

        private void sleepQuietly(long ms) {
            try {
                Thread.sleep(Math.max(0L, ms));
            } catch (InterruptedException ignored) {
                Thread.currentThread().interrupt();
            }
        }
    }
}
