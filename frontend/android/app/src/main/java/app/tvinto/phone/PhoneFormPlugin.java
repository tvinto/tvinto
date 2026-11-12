package app.tvinto.phone;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.Inet4Address;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.NetworkInterface;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.Locale;

/**
 * Typing on the television from a phone: a page served on the home network
 * while the screen with the QR code is open (phone-form.utils.ts in the web
 * app, which seals and opens what is sent).
 *
 * This side never reads what the phone typed. It serves the page the web app
 * hands it, and passes up whatever is posted to /send, sealed, for the web
 * app to open with the key only it and the QR code hold. So it is careful
 * about who it answers and how much, and not about content:
 *
 * - only addresses on the home network (private, link-local, loopback);
 * - a request of a few kilobytes at most, read with a timeout;
 * - five forms at most, then it stops listening -- a wrong one is a phone
 *   with an old code, or somebody guessing, and neither should go on;
 * - and it stops by itself after ten minutes, or when the screen goes.
 *
 * The server runs on a thread of its own: every Capacitor plugin call runs on
 * one thread in turn, and a blocked accept() there would hold up all of them.
 */
@CapacitorPlugin(name = "PhoneForm")
public class PhoneFormPlugin extends Plugin {

    private static final int PREFERRED_PORT = 8790;
    private static final long OPEN_FOR_MS = 10 * 60 * 1000L;
    private static final int MOST_HEAD_BYTES = 8 * 1024;
    private static final int MOST_BODY_BYTES = 24 * 1024;
    private static final int MOST_FORMS = 5;
    private static final int READ_TIMEOUT_MS = 5000;

    private ServerSocket server;
    private Thread serving;
    private byte[] page = new byte[0];
    private int forms;
    private long closesAt;

    @PluginMethod
    public void start(PluginCall call) {
        stopServer();
        String html = call.getString("html", "");
        String address = homeAddress();
        if (html == null || html.isEmpty()) {
            call.reject("No page to serve");
            return;
        }
        if (address == null) {
            call.reject("Not on a network");
            return;
        }
        page = html.getBytes(StandardCharsets.UTF_8);
        forms = 0;
        closesAt = System.currentTimeMillis() + OPEN_FOR_MS;
        try {
            server = open();
        } catch (IOException failed) {
            call.reject("Could not listen", failed);
            return;
        }
        final ServerSocket listening = server;
        serving = new Thread(() -> serve(listening), "PhoneForm");
        serving.setDaemon(true);
        serving.start();
        JSObject answer = new JSObject();
        answer.put("address", "http://" + address + ":" + listening.getLocalPort());
        call.resolve(answer);
    }

    @PluginMethod
    public void stop(PluginCall call) {
        stopServer();
        call.resolve();
    }

    @Override
    protected void handleOnDestroy() {
        stopServer();
    }

    private static ServerSocket open() throws IOException {
        ServerSocket socket = new ServerSocket();
        socket.setReuseAddress(true);
        try {
            socket.bind(new InetSocketAddress(PREFERRED_PORT));
        } catch (IOException taken) {
            // Something else has the usual port: any free one will do, the QR code says which.
            socket.close();
            socket = new ServerSocket();
            socket.bind(new InetSocketAddress(0));
        }
        socket.setSoTimeout(1000);
        return socket;
    }

    private synchronized void stopServer() {
        if (server != null) {
            try {
                server.close();
            } catch (IOException ignored) {
                // Closing is all that was wanted.
            }
        }
        server = null;
        serving = null;
    }

    private void serve(ServerSocket listening) {
        while (!listening.isClosed()) {
            if (System.currentTimeMillis() > closesAt) {
                notifyListeners("closed", new JSObject());
                stopServer();
                return;
            }
            try (Socket client = listening.accept()) {
                answer(client);
            } catch (java.net.SocketTimeoutException waiting) {
                // A second without a visitor: look at the clock again.
            } catch (IOException gone) {
                // A visitor who went away, or the socket closed by stop().
            }
        }
    }

    private void answer(Socket client) throws IOException {
        client.setSoTimeout(READ_TIMEOUT_MS);
        OutputStream out = client.getOutputStream();
        if (!fromHome(client.getInetAddress())) {
            reply(out, 403, "text/plain", "Only from the same network".getBytes(StandardCharsets.UTF_8));
            return;
        }
        InputStream in = client.getInputStream();
        String head = readHead(in);
        if (head == null) {
            reply(out, 400, "text/plain", new byte[0]);
            return;
        }
        String[] first = head.split("\r\n", 2)[0].split(" ");
        String method = first.length > 0 ? first[0] : "";
        String path = first.length > 1 ? first[1] : "";
        if ("GET".equals(method) && ("/".equals(path) || path.startsWith("/?"))) {
            reply(out, 200, "text/html; charset=utf-8", page);
            return;
        }
        if ("POST".equals(method) && "/send".equals(path)) {
            int length = contentLength(head);
            if (length <= 0 || length > MOST_BODY_BYTES) {
                reply(out, 413, "text/plain", new byte[0]);
                return;
            }
            byte[] body = readBody(in, length);
            if (body == null) {
                reply(out, 400, "text/plain", new byte[0]);
                return;
            }
            forms++;
            JSObject sent = new JSObject();
            sent.put("body", new String(body, StandardCharsets.UTF_8));
            notifyListeners("formArrived", sent);
            reply(out, 202, "application/json", "{}".getBytes(StandardCharsets.UTF_8));
            if (forms >= MOST_FORMS) {
                notifyListeners("closed", new JSObject());
                stopServer();
            }
            return;
        }
        reply(out, 404, "text/plain", new byte[0]);
    }

    /** The request line and headers, up to the blank line; null when longer than allowed or cut short. */
    private static String readHead(InputStream in) throws IOException {
        ByteArrayOutputStream head = new ByteArrayOutputStream();
        int matched = 0;
        while (head.size() < MOST_HEAD_BYTES) {
            int next = in.read();
            if (next < 0) {
                return null;
            }
            head.write(next);
            matched = (next == '\r' && (matched == 0 || matched == 2)) || (next == '\n' && (matched == 1 || matched == 3)) ? matched + 1 : 0;
            if (matched == 4) {
                return head.toString("ISO-8859-1");
            }
        }
        return null;
    }

    private static int contentLength(String head) {
        for (String line : head.split("\r\n")) {
            if (line.toLowerCase(Locale.ROOT).startsWith("content-length:")) {
                try {
                    return Integer.parseInt(line.substring(15).trim());
                } catch (NumberFormatException ignored) {
                    return -1;
                }
            }
        }
        return -1;
    }

    private static byte[] readBody(InputStream in, int length) throws IOException {
        byte[] body = new byte[length];
        int read = 0;
        while (read < length) {
            int got = in.read(body, read, length - read);
            if (got < 0) {
                return null;
            }
            read += got;
        }
        return body;
    }

    private static void reply(OutputStream out, int status, String type, byte[] body) throws IOException {
        String head = "HTTP/1.1 " + status + " " + reason(status) + "\r\n"
            + "Content-Type: " + type + "\r\n"
            + "Content-Length: " + body.length + "\r\n"
            + "Cache-Control: no-store\r\n"
            + "X-Content-Type-Options: nosniff\r\n"
            + "Referrer-Policy: no-referrer\r\n"
            + "Connection: close\r\n\r\n";
        out.write(head.getBytes(StandardCharsets.ISO_8859_1));
        out.write(body);
        out.flush();
    }

    private static String reason(int status) {
        switch (status) {
            case 200: return "OK";
            case 202: return "Accepted";
            case 400: return "Bad Request";
            case 403: return "Forbidden";
            case 413: return "Payload Too Large";
            default: return "Not Found";
        }
    }

    /** Whether a visitor is on the home network rather than somewhere a router let in. */
    static boolean fromHome(InetAddress address) {
        return address != null
            && (address.isSiteLocalAddress() || address.isLinkLocalAddress() || address.isLoopbackAddress());
    }

    /** This device's address on the home network, for the QR code: Wi-Fi or Ethernet, IPv4. */
    private static String homeAddress() {
        try {
            String fallback = null;
            for (NetworkInterface face : Collections.list(NetworkInterface.getNetworkInterfaces())) {
                if (!face.isUp() || face.isLoopback() || face.isVirtual()) {
                    continue;
                }
                for (InetAddress address : Collections.list(face.getInetAddresses())) {
                    if (address instanceof Inet4Address && address.isSiteLocalAddress()) {
                        String name = face.getName();
                        if (name.startsWith("wlan") || name.startsWith("eth")) {
                            return address.getHostAddress();
                        }
                        if (fallback == null) {
                            fallback = address.getHostAddress();
                        }
                    }
                }
            }
            return fallback;
        } catch (java.net.SocketException none) {
            return null;
        }
    }
}
