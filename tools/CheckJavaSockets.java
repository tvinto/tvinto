import java.nio.channels.Selector;

/**
 * Checks whether Java can open a network selector on this machine.
 *
 * Here because the Android build depends on it and it is not obvious from the
 * error. Gradle runs a background daemon and talks to it over a loopback
 * socket; opening that needs a Selector, and on Windows a Selector is built on
 * an internal loopback socket pair the JVM creates for itself. When that
 * creation fails, Gradle reports:
 *
 *     java.io.IOException: Unable to establish loopback connection
 *
 * which names neither Java nor sockets, and looks like a Gradle problem. It is
 * not. Nothing Java can build will build until this prints ok -- not this
 * project, not any other Android project on the machine.
 *
 * Run it with:
 *
 *     java tools/CheckJavaSockets.java
 *
 * Single-file source mode, so it needs no compiling and leaves nothing behind.
 */
public class CheckJavaSockets {
  public static void main(String[] args) {
    System.out.println("java     " + System.getProperty("java.version"));
    System.out.println("provider " + java.nio.channels.spi.SelectorProvider.provider().getClass().getSimpleName());

    int failures = 0;
    Exception lastFailure = null;

    // Repeated, because something intermittently racing the JVM's handshake
    // looks quite different from something blocking it outright, and the
    // difference points at different causes.
    for (int attempt = 1; attempt <= 5; attempt++) {
      try (Selector selector = Selector.open()) {
        System.out.println("attempt " + attempt + ": ok");
      } catch (Exception e) {
        failures++;
        lastFailure = e;
        System.out.println("attempt " + attempt + ": FAILED");
      }
    }

    System.out.println();
    if (failures == 0) {
      System.out.println("Java networking is healthy. Gradle should run.");
    } else {
      System.out.println(failures + " of 5 failed: " + lastFailure);
      System.out.println();
      System.out.println("No Gradle build can start while this fails. Try, in order:");
      System.out.println("  1. netsh winsock reset   (as administrator), then reboot");
      System.out.println("  2. check for security software installed or updated recently");
      System.out.println("     -- a network filter driver can block this and show up nowhere");
      System.out.println("        in the firewall rules or the Winsock catalogue");
    }

    System.exit(failures == 0 ? 0 : 1);
  }
}
