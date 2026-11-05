package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.app.PendingIntent;
import android.content.*;
import android.service.quicksettings.*;

/** The tile opens a brief visible bridge for Android's microphone while-in-use permission. */
public final class DictationTile extends TileService {
  static void refresh(Context context) {
    requestListeningState(context, new ComponentName(context, DictationTile.class));
  }

  /** Dictate & Delegate only suggests adding the tile until it is there. */
  @Override
  public void onTileAdded() {
    getSharedPreferences("settings", 0).edit().putBoolean("tileAdded", true).apply();
  }

  @Override
  public void onTileRemoved() {
    getSharedPreferences("settings", 0).edit().putBoolean("tileAdded", false).apply();
  }

  @Override
  public void onStartListening() {
    update();
  }

  private void update() {
    I18n.init(this);
    Tile tile = getQsTile();
    if (tile == null) return;
    String state =
        DictationService.instance == null
            ? ""
            : getSharedPreferences("settings", 0).getString("state", "");
    boolean recording = DictationService.RECORDING.equals(state);
    boolean working = DictationService.busy() && !recording;
    tile.setLabel(tr("Dictate & Delegate"));
    tile.setSubtitle(
        recording
            ? tr("Tap to stop")
            : working ? tr("Saving recording…") : tr("Tap to record"));
    tile.setState(
        working ? Tile.STATE_UNAVAILABLE : recording ? Tile.STATE_ACTIVE : Tile.STATE_INACTIVE);
    tile.setContentDescription(recording ? tr("Stop dictation") : tr("Start dictation"));
    tile.updateTile();
  }

  @Override
  public void onClick() {
    super.onClick();
    I18n.init(this);
    if (DictationService.busy()
        && !DictationService.RECORDING.equals(
            getSharedPreferences("settings", 0).getString("state", ""))) return;
    Runnable open =
        () ->
            startActivityAndCollapse(
                PendingIntent.getActivity(
                    this,
                    31,
                    new Intent(this, RecordActivity.class)
                        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_ACTIVITY_CLEAR_TOP),
                    PendingIntent.FLAG_IMMUTABLE | PendingIntent.FLAG_UPDATE_CURRENT));
    if (isLocked()) unlockAndRun(open);
    else open.run();
  }
}
