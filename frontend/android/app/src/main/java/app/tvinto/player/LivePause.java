package app.tvinto.player;

import android.content.Context;

import androidx.annotation.Nullable;

import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Locale;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Pausing live television on the device.
 *
 * Most subscriptions allow one connection, and the player holds it. So a
 * pause hands it over: the player lets go of the channel, and this takes it,
 * writing what arrives to a file of its own. Play is then the file, from where
 * the pause began and on as it grows, served on this device only (127.0.0.1)
 * the way a live stream arrives. Back to live, another channel or leaving the
 * player stops the writing and deletes the file. Only one connection is ever
 * open.
 *
 * An Xtream channel is asked for as one continuous TS stream. A channel that
 * is only HLS (an M3U playlist's .m3u8) is written piece by piece instead:
 * its playlist, then its MPEG-TS pieces in order, one request at a time,
 * appended to the same file (HlsPlaylist, TsTimeline), so playing, stepping
 * and the badge work the same. fMP4, encrypted and byte-range pieces are not
 * written; such a channel stays unpausable.
 *
 * Written only while paused or behind, never while watching live: a
 * television's storage is cheap flash, and an hour of a channel is a few
 * gigabytes.
 */
final class LivePause {

    /** Longest a pause can go on: past this the writing stops, and the file plays to its end. */
    static final long LONGEST_MS = 90L * 60L * 1000L;
    /** Most it may write, and what it leaves the device free. */
    static final long MOST_BYTES = 4L * 1024L * 1024L * 1024L;
    static final long KEEP_FREE_BYTES = 500L * 1024L * 1024L;

    private static final int CONNECT_TIMEOUT_MS = 10_000;
    private static final int READ_TIMEOUT_MS = 20_000;
    private static final Pattern XTREAM_LIVE = Pattern.compile("^(https?://[^?#]*/live/[^?#]+/[^?#]+/[^/?#]+)\\.m3u8?(\\?[^#]*)?$", Pattern.CASE_INSENSITIVE);

    /** What the pause says about itself as it goes, on the main thread's terms (posted by the caller). */
    interface Listener {
        /** The writing stopped by itself: too long, the device full, or the channel gone. */
        void stoppedWriting(boolean anything);
    }

    private final File file;
    private final String token = UUID.randomUUID().toString().replace("-", "");
    @Nullable
    private final Listener listener;
    private final Writer writer;
    /** When each part of the file arrived: what stepping back and forward goes by. */
    final PauseIndex index = new PauseIndex();
    @Nullable
    private ServerSocket server;
    private volatile boolean ended = false;

    private LivePause(Context context, String address, @Nullable Hint hint, @Nullable Listener listener) {
        File dir = new File(context.getCacheDir(), "live-pause");
        //noinspection ResultOfMethodCallIgnored
        dir.mkdirs();
        // A pause the app was killed during left its file: nothing reads it now.
        File[] left = dir.listFiles();
        if (left != null) {
            for (File old : left) {
                //noinspection ResultOfMethodCallIgnored
                old.delete();
            }
        }
        this.file = new File(dir, token + ".ts");
        this.listener = listener;
        this.writer = new Writer(address, hint, dir);
    }

    /**
     * What the player knew of an HLS channel it was playing, so the pause
     * carries on from the same piece of the same variant.
     */
    static final class Hint {
        /** The media playlist the player was playing: a master playlist's variant. */
        @Nullable
        final String playlist;
        final long bandwidth;
        /** The sequence number of the piece on screen; -1 when not known. */
        final long sequence;
        /** How far into that piece the picture was. */
        final long intoMs;

        Hint(@Nullable String playlist, long bandwidth, long sequence, long intoMs) {
            this.playlist = playlist;
            this.bandwidth = bandwidth;
            this.sequence = sequence;
            this.intoMs = intoMs;
        }
    }

    /**
     * What the player's HLS manifest says about the channel on screen, for
     * {@link #start}. Null when it is not HLS, or its pieces cannot be written
     * into one file (fMP4, encrypted, byte ranges, sound in a playlist of its
     * own): such a channel is not pausable.
     */
    @Nullable
    static Hint hlsHint(@Nullable Object manifest, long positionMs, long bandwidth) {
        if (!(manifest instanceof androidx.media3.exoplayer.hls.HlsManifest)) {
            return null;
        }
        androidx.media3.exoplayer.hls.HlsManifest hls = (androidx.media3.exoplayer.hls.HlsManifest) manifest;
        androidx.media3.exoplayer.hls.playlist.HlsMediaPlaylist media = hls.mediaPlaylist;
        long sequence = -1L;
        long intoUs = 0L;
        long positionUs = positionMs * 1000L;
        for (int i = 0; i < media.segments.size(); i++) {
            androidx.media3.exoplayer.hls.playlist.HlsMediaPlaylist.Segment segment = media.segments.get(i);
            if (segment.initializationSegment != null || segment.fullSegmentEncryptionKeyUri != null
                || segment.drmInitData != null || segment.byteRangeLength != androidx.media3.common.C.LENGTH_UNSET) {
                return null;
            }
            if (positionUs >= segment.relativeStartTimeUs && positionUs < segment.relativeStartTimeUs + segment.durationUs) {
                sequence = media.mediaSequence + i;
                intoUs = positionUs - segment.relativeStartTimeUs;
            }
        }
        for (androidx.media3.exoplayer.hls.playlist.HlsMultivariantPlaylist.Variant variant : hls.multivariantPlaylist.variants) {
            if (variant.url.toString().equals(media.baseUri) && variant.audioGroupId != null) {
                for (androidx.media3.exoplayer.hls.playlist.HlsMultivariantPlaylist.Rendition audio : hls.multivariantPlaylist.audios) {
                    if (audio.url != null && variant.audioGroupId.equals(audio.groupId)) {
                        return null;
                    }
                }
            }
        }
        android.util.Log.i("LivePause", "HLS pause: position " + positionMs + " ms, playlist from piece " + media.mediaSequence
            + " (" + media.segments.size() + " pieces, starts " + media.startTimeUs + " us), on screen " + sequence + ", " + intoUs / 1000L + " ms in");
        return new Hint(media.baseUri, bandwidth, sequence, intoUs / 1000L);
    }

    /**
     * Starts writing the channel at this address, which the player must have
     * let go of first: one continuous stream as it comes, or, for an HLS
     * playlist that is not an Xtream channel, its pieces fetched one after
     * another (with the hint the player's manifest gave). Null when the
     * channel cannot be paused this way.
     */
    @Nullable
    static LivePause start(Context context, String playing, @Nullable Hint hint, @Nullable Listener listener) {
        String address = continuousAddress(playing);
        if (address == null && hint == null) {
            return null;
        }
        LivePause pause = address != null
            ? new LivePause(context, address, null, listener)
            : new LivePause(context, playing, hint, listener);
        pause.writer.start();
        return pause;
    }

    /**
     * The channel as one continuous MPEG-TS stream, which can be written as it
     * comes: an Xtream channel's `.m3u8` asked for as `.ts`, as recording does.
     * Anything else already continuous is itself; another playlist is null.
     */
    @Nullable
    static String continuousAddress(@Nullable String playing) {
        if (playing == null || playing.isEmpty()) {
            return null;
        }
        Matcher xtream = XTREAM_LIVE.matcher(playing);
        if (xtream.matches()) {
            return xtream.group(1) + ".ts" + (xtream.group(2) == null ? "" : xtream.group(2));
        }
        String path = playing.toLowerCase(Locale.ROOT);
        int query = path.indexOf('?');
        if (query >= 0) {
            path = path.substring(0, query);
        }
        if (path.endsWith(".m3u8") || path.endsWith(".m3u")) {
            return null;
        }
        return playing;
    }

    /** The local address the player plays the pause from, starting it from where the pause began. */
    String address() throws IOException {
        return address(0L);
    }

    /**
     * The local address that plays the file from this many bytes in: a step
     * back or forward. The player cannot seek in a file that is still growing
     * (Media3 knows no length, so no index), so each step opens it afresh
     * from a place PauseIndex found.
     */
    synchronized String address(long from) throws IOException {
        if (server == null || server.isClosed()) {
            ServerSocket opened = new ServerSocket(0, 4, InetAddress.getByName("127.0.0.1"));
            server = opened;
            Thread accepting = new Thread(() -> accept(opened), "LivePause");
            accepting.setDaemon(true);
            accepting.start();
        }
        String path = "http://127.0.0.1:" + server.getLocalPort() + "/pause/" + token + ".ts";
        return from > 0L ? path + "?from=" + from : path;
    }

    /** Whether it is still writing: a pause past its length, or one whose channel dropped, has stopped. */
    boolean writing() {
        return writer.isAlive() && !ended;
    }

    long bytes() {
        return writer.bytes;
    }

    /**
     * Whether this is an HLS channel written piece by piece: its file starts
     * where the piece on screen began, a little before the pause.
     */
    boolean pieces() {
        return writer.hint != null;
    }

    /** Stops the writing and the serving, and deletes the file. */
    void end() {
        ended = true;
        writer.stopNow();
        ServerSocket open;
        synchronized (this) {
            open = server;
            server = null;
        }
        if (open != null) {
            try {
                open.close();
            } catch (IOException ignored) {
                // Closing anyway.
            }
        }
        // The writer may still be closing the file; it is deleted after, too.
        //noinspection ResultOfMethodCallIgnored
        file.delete();
    }

    private void accept(ServerSocket listening) {
        while (!listening.isClosed()) {
            try {
                Socket client = listening.accept();
                Thread serving = new Thread(() -> serve(client), "LivePause-client");
                serving.setDaemon(true);
                serving.start();
            } catch (IOException closed) {
                return;
            }
        }
    }

    private void serve(Socket client) {
        try (Socket socket = client; InputStream in = socket.getInputStream(); OutputStream out = socket.getOutputStream()) {
            long from = requested(in, token);
            if (from < 0L) {
                out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                return;
            }
            boolean ranged = from >= RANGED;
            from = from % RANGED;
            // A range is answered as one, with no length: the file is still growing.
            out.write(((ranged ? "HTTP/1.1 206 Partial Content\r\n" : "HTTP/1.1 200 OK\r\n")
                + "Content-Type: video/mp2t\r\nAccept-Ranges: bytes\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n")
                .getBytes(StandardCharsets.ISO_8859_1));
            // From the start (where the pause began), or from where a step asked.
            try (RandomAccessFile reading = new RandomAccessFile(file, "r")) {
                reading.seek(Math.min(from, reading.length()));
                byte[] buffer = new byte[64 * 1024];
                while (!ended) {
                    int read = reading.read(buffer);
                    if (read > 0) {
                        out.write(buffer, 0, read);
                        continue;
                    }
                    if (!writer.isAlive()) {
                        // Written to its end, and all of it sent.
                        return;
                    }
                    Thread.sleep(200L);
                }
            }
        } catch (IOException | InterruptedException gone) {
            // The player closed, or the pause ended: nothing to say.
        }
    }

    /** Added to a request's starting byte when it came as a Range, which is answered as one (206). */
    static final long RANGED = 1L << 48;
    private static final Pattern REQUEST = Pattern.compile("^GET /pause/([0-9a-f]+)\\.ts(?:\\?from=(\\d{1,14}))? HTTP/1\\.[01]$");
    private static final Pattern RANGE = Pattern.compile("^range:\\s*bytes=(\\d{1,14})-\\s*$", Pattern.CASE_INSENSITIVE);

    /**
     * Where a request for this pause's file starts: `GET /pause/<token>.ts`,
     * from a step's `?from=` or a `Range: bytes=N-`, the second plus RANGED.
     * Negative for anything else. Reads the request's headers to their end.
     */
    static long requested(InputStream in, String token) throws IOException {
        String first = line(in);
        Matcher request = REQUEST.matcher(first == null ? "" : first);
        boolean ours = request.matches() && token.equals(request.group(1));
        long from = ours && request.group(2) != null ? Long.parseLong(request.group(2)) : 0L;
        String header;
        int headers = 0;
        while ((header = line(in)) != null && !header.isEmpty() && headers++ < 64) {
            Matcher range = RANGE.matcher(header);
            if (range.matches()) {
                from = Long.parseLong(range.group(1)) + RANGED;
            }
        }
        return ours ? from : -1L;
    }

    /** One line of a request, without its end; null at the end of the request. */
    @Nullable
    private static String line(InputStream in) throws IOException {
        StringBuilder line = new StringBuilder();
        int next;
        while ((next = in.read()) >= 0 && next != '\n') {
            if (line.length() < 1024 && next != '\r') {
                line.append((char) next);
            }
        }
        return next < 0 && line.length() == 0 ? null : line.toString();
    }

    /** Fetches the channel into the file until stopped, too long, or out of room. */
    private final class Writer extends Thread {
        private final String address;
        /** For an HLS channel written piece by piece; null for one continuous stream. */
        @Nullable
        private final Hint hint;
        private final File dir;
        private volatile boolean stopped = false;
        @Nullable
        private volatile HttpURLConnection connection;
        volatile long bytes = 0L;

        Writer(String address, @Nullable Hint hint, File dir) {
            super("LivePause-writer");
            setDaemon(true);
            this.address = address;
            this.hint = hint;
            this.dir = dir;
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
            long until = System.currentTimeMillis() + LONGEST_MS;
            long room = Math.min(MOST_BYTES, Math.max(0L, dir.getUsableSpace() - KEEP_FREE_BYTES));
            try (OutputStream out = new FileOutputStream(file, true)) {
                if (hint == null) {
                    continuous(out, until, room);
                } else {
                    pieces(out, hint, until, room);
                }
            } catch (IOException cannotWrite) {
                // Out of room or the file went: what was written still plays.
            }
            if (ended) {
                //noinspection ResultOfMethodCallIgnored
                file.delete();
            } else if (listener != null) {
                listener.stoppedWriting(bytes > 0);
            }
        }

        private boolean going(long until, long room) {
            return !stopped && System.currentTimeMillis() < until && bytes < room;
        }

        /** One continuous MPEG-TS stream, written as it comes. */
        private void continuous(OutputStream out, long until, long room) throws IOException {
            int retries = 0;
            // A dropped connection is taken again a few times, as recording does;
            // the gap is lost, but the pause goes on.
            while (going(until, room) && retries < 4) {
                try {
                    HttpURLConnection open = request(address);
                    if (open.getResponseCode() != 200) {
                        throw new IOException("HTTP " + open.getResponseCode());
                    }
                    index.wrote(android.os.SystemClock.elapsedRealtime(), bytes);
                    try (InputStream in = open.getInputStream()) {
                        byte[] buffer = new byte[64 * 1024];
                        int read;
                        while (going(until, room) && (read = in.read(buffer)) >= 0) {
                            out.write(buffer, 0, read);
                            bytes += read;
                            index.wrote(android.os.SystemClock.elapsedRealtime(), bytes);
                        }
                    }
                    // The provider ended it: taken again, but not without end.
                    if (!stopped) {
                        retries++;
                    }
                } catch (IOException dropped) {
                    retries++;
                    if (!waited(1_500L)) {
                        return;
                    }
                } finally {
                    HttpURLConnection open = connection;
                    connection = null;
                    if (open != null) {
                        open.disconnect();
                    }
                }
            }
        }

        /**
         * An HLS channel: its playlist, then its pieces in order from the one
         * the player was showing, appended to the file as one TS stream, the
         * playlist read again as it moves on. One request at a time, never two
         * at once: most subscriptions allow one connection.
         *
         * PauseIndex goes by the programme's own time here, not by when a
         * piece arrived: pieces come faster than they play (the first few at
         * once). The file's first byte is the moment the piece on screen
         * began, and each piece's bytes are spread over its length.
         */
        private void pieces(OutputStream out, Hint hint, long until, long room) throws IOException {
            long began = android.os.SystemClock.elapsedRealtime() - Math.max(0L, hint.intoMs);
            String playlist = address;
            HlsPlaylist list = load(playlist);
            if (list != null && list.master) {
                HlsPlaylist.Variant variant = list.pick(hint.playlist, hint.bandwidth);
                playlist = variant == null ? null : variant.uri;
                list = playlist == null ? null : load(playlist);
            }
            if (list == null || list.master || list.unsupported() != null) {
                android.util.Log.i("LivePause", "this HLS channel cannot be paused: "
                    + (list == null ? "no media playlist" : list.master ? "a master within a master" : list.unsupported()));
                return;
            }
            TsTimeline timeline = new TsTimeline();
            long next = list.startSequence(hint.sequence);
            android.util.Log.i("LivePause", "HLS pause: writing from piece " + next + " of " + list.mediaSequence + "-"
                + (list.mediaSequence + list.segments.size() - 1));
            double written = 0.0;
            boolean missed = false;
            int failures = 0;
            long grewAt = android.os.SystemClock.elapsedRealtime();
            while (going(until, room)) {
                long loadedAt = android.os.SystemClock.elapsedRealtime();
                boolean grew = false;
                boolean failed = false;
                for (HlsPlaylist.Segment piece : list.segments) {
                    if (!going(until, room)) {
                        return;
                    }
                    if (next >= 0L && piece.sequence < next) {
                        continue;
                    }
                    // The playlist moved past pieces not fetched in time: a jump.
                    missed |= next >= 0L && piece.sequence > next;
                    byte[] body = fetch(piece.uri);
                    if (body == null) {
                        if (stopped || ++failures >= 4) {
                            return;
                        }
                        // Tried again from a fresh playlist, after a while.
                        failed = true;
                        break;
                    }
                    byte[] fitted = timeline.fit(body, body.length, piece.seconds, piece.discontinuity || missed);
                    if (fitted == null) {
                        android.util.Log.i("LivePause", "this HLS channel cannot be paused: its pieces are not MPEG-TS");
                        return;
                    }
                    append(out, fitted, began + Math.round(written * 1000.0), Math.round(piece.seconds * 1000.0), room);
                    written += piece.seconds;
                    next = piece.sequence + 1L;
                    missed = false;
                    grew = true;
                    failures = 0;
                }
                long now = android.os.SystemClock.elapsedRealtime();
                long target = Math.max(1_000L, Math.round(list.targetSeconds * 1000.0));
                if (grew) {
                    grewAt = now;
                } else if (now - grewAt > Math.max(30_000L, 6L * target)) {
                    // The playlist stopped moving on: the channel is gone.
                    return;
                }
                HlsPlaylist.Segment last = list.segments.isEmpty() ? null : list.segments.get(list.segments.size() - 1);
                if (list.ended && !failed && (last == null || next > last.sequence)) {
                    return;
                }
                // Read again a target duration after it was last read, half that
                // when nothing new came (RFC 8216, 6.3.4).
                if (!waited((grew && !failed ? target : target / 2L) - (now - loadedAt))) {
                    return;
                }
                HlsPlaylist fresh = load(playlist);
                if (fresh == null || fresh.master) {
                    if (stopped || ++failures >= 4 || !waited(1_500L)) {
                        return;
                    }
                } else {
                    list = fresh;
                }
            }
        }

        /** Appends a piece, noting its bytes as arriving evenly from its start over its length. */
        private void append(OutputStream out, byte[] piece, long startsAt, long lastsMs, long room) throws IOException {
            int chunk = 64 * TsTimeline.PACKET;
            for (int at = 0; at < piece.length && bytes < room; at += chunk) {
                int length = Math.min(chunk, piece.length - at);
                index.wrote(startsAt + lastsMs * at / piece.length, bytes);
                out.write(piece, at, length);
                bytes += length;
            }
            index.wrote(startsAt + lastsMs, bytes);
        }

        /** A playlist; null when it could not be had or is not one. */
        @Nullable
        private HlsPlaylist load(String playlist) {
            try {
                HttpURLConnection open = request(playlist);
                byte[] body = read(open, 4 * 1024 * 1024);
                String text = body == null ? null : new String(body, StandardCharsets.UTF_8);
                // Pieces are addressed from where the playlist ended up, after any redirect.
                return text != null && HlsPlaylist.looksLikePlaylist(text) ? HlsPlaylist.parse(text, open.getURL().toString()) : null;
            } catch (IOException dropped) {
                return null;
            } finally {
                connection = null;
            }
        }

        /** A piece, whole; null when it could not be had. */
        @Nullable
        private byte[] fetch(String piece) {
            try {
                return read(request(piece), 64 * 1024 * 1024);
            } catch (IOException dropped) {
                return null;
            } finally {
                connection = null;
            }
        }

        private HttpURLConnection request(String to) throws IOException {
            if (stopped) {
                throw new IOException("stopped");
            }
            HttpURLConnection open = (HttpURLConnection) new URL(to).openConnection();
            connection = open;
            open.setConnectTimeout(CONNECT_TIMEOUT_MS);
            open.setReadTimeout(READ_TIMEOUT_MS);
            return open;
        }

        /**
         * The whole body, read to its end and closed, which leaves the
         * connection to be used again for the next request. Null for anything
         * but 200, or a body larger than this.
         */
        @Nullable
        private byte[] read(HttpURLConnection open, int most) throws IOException {
            if (open.getResponseCode() != 200) {
                open.disconnect();
                return null;
            }
            try (InputStream in = open.getInputStream()) {
                java.io.ByteArrayOutputStream body = new java.io.ByteArrayOutputStream();
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = in.read(buffer)) >= 0) {
                    if (stopped || body.size() + read > most) {
                        open.disconnect();
                        return null;
                    }
                    body.write(buffer, 0, read);
                }
                return body.toByteArray();
            }
        }

        /** Waits this long unless stopped first; false if stopped. */
        private boolean waited(long ms) {
            long until = android.os.SystemClock.elapsedRealtime() + ms;
            while (!stopped && android.os.SystemClock.elapsedRealtime() < until) {
                try {
                    Thread.sleep(Math.min(100L, Math.max(1L, until - android.os.SystemClock.elapsedRealtime())));
                } catch (InterruptedException interrupted) {
                    return false;
                }
            }
            return !stopped;
        }
    }
}
