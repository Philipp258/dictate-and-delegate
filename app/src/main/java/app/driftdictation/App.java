package app.driftdictation;

/** The app's process: starts the network log before any activity, service or receiver runs. */
public final class App extends android.app.Application {
  /** How long an idle connection is kept for reuse (Android's default: 5 minutes). */
  static final String KEEP_ALIVE_MS = "30000";

  static {
    // A kept-alive connection the network forgot while idle (a router's or carrier's NAT) is
    // answered with a reset when the next request reuses it: the first request after a pause
    // failed within a round trip (bb, OpenRouter). Android's connection pool reads this once, at
    // the process's first request, so it's set before any code here runs.
    System.setProperty("http.keepAliveDuration", KEEP_ALIVE_MS);
  }

  @Override
  public void onCreate() {
    super.onCreate();
    NetState.install(this);
    // Notes not at the chief yet, and failures not reported: a try soon, once there's a network.
    new Thread(() -> Outbox.kick(this), "outbox-start").start();
  }
}
