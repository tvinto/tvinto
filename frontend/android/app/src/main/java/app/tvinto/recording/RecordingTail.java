package app.tvinto.recording;

import android.content.Context;

import androidx.annotation.Nullable;

import java.io.File;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;

/**
 * Watching a channel while it records, without a second connection to the
 * provider (private plan: recording, stage 3). Most subscriptions allow one
 * stream, and the recording holds it; so the player is given this instead --
 * the recording's own file, served on this device only, from near its newest
 * part and on as it grows, the way a live stream arrives.
 *
 * `/rec/<id>.ts` answers MPEG-TS without an end until the recording has
 * finished and everything written has been sent. Only 127.0.0.1 is listened
 * on: nothing else on the network sees it.
 */
final class RecordingTail {

    /** How far behind the newest part watching starts: a few seconds of picture, so it begins at once. */
    private static final long BEHIND_BYTES = 2L * 1024 * 1024;
    private static final int PACKET = 188;

    @Nullable
    private static ServerSocket server;

    private RecordingTail() {}

    /** The local address to watch a recording at, starting the server if it is not running. */
    static synchronized String address(Context context, String id) throws IOException {
        if (server == null || server.isClosed()) {
            ServerSocket opened = new ServerSocket(0, 8, InetAddress.getByName("127.0.0.1"));
            server = opened;
            Context app = context.getApplicationContext();
            Thread accepting = new Thread(() -> accept(app, opened), "RecordingTail");
            accepting.setDaemon(true);
            accepting.start();
        }
        return "http://127.0.0.1:" + server.getLocalPort() + "/rec/" + id + ".ts";
    }

    private static void accept(Context context, ServerSocket listening) {
        while (!listening.isClosed()) {
            try {
                Socket client = listening.accept();
                Thread serving = new Thread(() -> serve(context, client), "RecordingTail-client");
                serving.setDaemon(true);
                serving.start();
            } catch (IOException closed) {
                return;
            }
        }
    }

    private static void serve(Context context, Socket client) {
        try (Socket socket = client; InputStream in = socket.getInputStream(); OutputStream out = socket.getOutputStream()) {
            String id = requestedId(in);
            File video = id == null ? null : Recordings.find(context, id + ".ts");
            if (video == null || !video.exists()) {
                out.write("HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                return;
            }
            out.write(("HTTP/1.1 200 OK\r\nContent-Type: video/mp2t\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n")
                .getBytes(StandardCharsets.ISO_8859_1));
            try (RandomAccessFile file = new RandomAccessFile(video, "r")) {
                // Near the newest part, on a packet boundary, so the player finds its footing at once.
                long at = Math.max(0L, file.length() - BEHIND_BYTES);
                at -= at % PACKET;
                file.seek(at);
                byte[] buffer = new byte[64 * 1024];
                while (true) {
                    int read = file.read(buffer);
                    if (read > 0) {
                        out.write(buffer, 0, read);
                        continue;
                    }
                    if (!RecordingService.isRecording(id)) {
                        // Finished, and all of it sent.
                        return;
                    }
                    // Caught up with the recording: wait for it to write more.
                    Thread.sleep(200L);
                }
            }
        } catch (IOException | InterruptedException gone) {
            // The player closed, or the recording's file went: nothing to say.
        }
    }

    /** The id in `GET /rec/<id>.ts`, or null for anything else. */
    @Nullable
    private static String requestedId(InputStream in) throws IOException {
        StringBuilder line = new StringBuilder();
        int next;
        while ((next = in.read()) >= 0 && next != '\n' && line.length() < 512) {
            line.append((char) next);
        }
        java.util.regex.Matcher found = java.util.regex.Pattern.compile("^GET /rec/([A-Za-z0-9_-]{1,64})\\.ts[ ?]").matcher(line);
        return found.find() ? found.group(1) : null;
    }
}
