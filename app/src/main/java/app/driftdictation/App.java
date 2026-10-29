package app.driftdictation;

/** The app's process: starts the network log before any activity, service or receiver runs. */
public final class App extends android.app.Application {
  @Override
  public void onCreate() {
    super.onCreate();
    NetState.install(this);
  }
}
