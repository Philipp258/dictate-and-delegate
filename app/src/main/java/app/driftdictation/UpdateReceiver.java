package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageInstaller;

/**
 * What Android's installer says about an update the app handed it: it needs your confirmation
 * (shown at once), or it failed (said in a toast and kept for the update banner). On success the
 * app is replaced and restarted, so nothing comes here.
 */
public final class UpdateReceiver extends BroadcastReceiver {
  static final String ACTION = "app.driftdictation.UPDATE_STATUS";

  /** The installer's last failure, for the banner; "" after a start. */
  static volatile String failure = "";

  @Override
  public void onReceive(Context context, Intent intent) {
    int status = intent.getIntExtra(PackageInstaller.EXTRA_STATUS, PackageInstaller.STATUS_FAILURE);
    if (status == PackageInstaller.STATUS_PENDING_USER_ACTION) {
      Intent confirm = intent.getParcelableExtra(Intent.EXTRA_INTENT, Intent.class);
      if (confirm != null) context.startActivity(confirm.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK));
      return;
    }
    if (status == PackageInstaller.STATUS_SUCCESS) return;
    String why = intent.getStringExtra(PackageInstaller.EXTRA_STATUS_MESSAGE);
    failure =
        status == PackageInstaller.STATUS_FAILURE_ABORTED
            ? tr("You cancelled the update.")
            : tr("The update couldn't be installed: %1$s", why == null || why.isEmpty() ? "status " + status : why);
    android.widget.Toast.makeText(context, failure, android.widget.Toast.LENGTH_LONG).show();
  }
}
