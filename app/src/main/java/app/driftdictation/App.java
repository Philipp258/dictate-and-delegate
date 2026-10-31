package app.driftdictation;

/** The app's process: starts the network log before any activity, service or receiver runs. */
public final class App extends android.app.Application {
  @Override
  public void onCreate() {
    super.onCreate();
    NetState.install(this);
    // Notes not at the chief yet, and failures not reported: a try soon, once there's a network.
    new Thread(() -> Outbox.kick(this), "outbox-start").start();
  }
}
