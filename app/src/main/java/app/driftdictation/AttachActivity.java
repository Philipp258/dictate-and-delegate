package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.Intent;
import android.os.Bundle;
import android.view.Gravity;
import android.view.ViewGroup;
import android.widget.Button;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.util.List;

/**
 * The 📎 of the floating button and of Home: add context to the dictation being recorded (or the
 * next one): paste what you copied, or attach a file. A small window over the app you are in, so
 * Android lets Dictate & Delegate read the clipboard; recording keeps going behind it. The clipboard is read
 * only when you tap Paste: Android announces every read.
 */
public final class AttachActivity extends Activity {
  private static final int PICK = 1;
  private Ui ui;
  private Attachments attachments;
  private LinearLayout list;

  @Override
  public void onCreate(Bundle state) {
    super.onCreate(state);
    I18n.init(this);
    ui = new Ui(this);
    attachments = new Attachments(this);
    LinearLayout root = ui.vertical();
    root.setPadding(ui.dp(22), ui.dp(20), ui.dp(22), ui.dp(16));
    root.setBackground(ui.shape(Ui.BG, 0, 24));
    root.addView(ui.title(tr("Add to this dictation"), 22));
    ui.add(
        root,
        ui.text(
            tr("Give Dictate & Delegate what you're talking about, like the offer you're replying to. It's used when you ask for something."),
            14,
            Ui.MUTED),
        6);
    Button paste = ui.add(root, ui.button(tr("Paste what you copied"), Ui.Kind.PRIMARY, v -> paste()), 16);
    paste.setMinHeight(ui.dp(52));
    ui.add(root, ui.button(tr("Attach a file"), Ui.Kind.OUTLINE, v -> pick()), 10);
    ui.add(root, ui.text(tr("Images, PDFs or text files, up to 10 MB."), 12, Ui.MUTED), 4);
    if (!Assistants.ready(this).isEmpty())
      ui.add(
          root,
          ui.text(
              tr("Your chief of staff gets all of it: pasted text in the message, images and PDFs as attachments."),
              12,
              Ui.MUTED),
          4);
    list = ui.add(root, ui.vertical(), 12);
    Button done = ui.button(tr("Done"), Ui.Kind.QUIET, v -> finish());
    ui.add(root, done, 8);
    ScrollView scroll = new ScrollView(this);
    scroll.addView(root);
    setContentView(scroll);
    getWindow().setLayout(Math.round(getResources().getDisplayMetrics().widthPixels * 0.92f), ViewGroup.LayoutParams.WRAP_CONTENT);
    getWindow().setGravity(Gravity.CENTER);
    render();
  }

  private String clipboardText() {
    ClipData data = getSystemService(ClipboardManager.class).getPrimaryClip();
    if (data == null || data.getItemCount() == 0) return "";
    CharSequence t = data.getItemAt(0).coerceToText(this);
    return t == null ? "" : t.toString().trim();
  }

  private void paste() {
    try {
      attachments.addText(clipboardText());
      Toast.makeText(this, tr("Added"), Toast.LENGTH_SHORT).show();
    } catch (Exception ex) {
      Toast.makeText(this, DictationService.friendly(ex), Toast.LENGTH_LONG).show();
    }
    render();
  }

  private void pick() {
    Intent intent =
        new Intent(Intent.ACTION_OPEN_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType("*/*")
            .putExtra(Intent.EXTRA_MIME_TYPES, new String[] {"image/*", "application/pdf", "text/*"});
    try {
      // The floating panels go while the picker is open: some pickers take no taps under them.
      DictationService.picking(true);
      startActivityForResult(intent, PICK);
    } catch (Exception ex) {
      DictationService.picking(false);
      Toast.makeText(this, tr("No app to pick files with."), Toast.LENGTH_LONG).show();
    }
  }

  @Override
  protected void onResume() {
    super.onResume();
    if (DictationService.picking) DictationService.picking(false); // Back from the picker.
  }

  @Override
  protected void onDestroy() {
    if (DictationService.picking) DictationService.picking(false);
    super.onDestroy();
  }

  @Override
  protected void onActivityResult(int request, int result, Intent data) {
    super.onActivityResult(request, result, data);
    if (request != PICK || result != RESULT_OK || data == null || data.getData() == null) return;
    try {
      attachments.addFile(data.getData());
      Toast.makeText(this, tr("Added"), Toast.LENGTH_SHORT).show();
    } catch (Exception ex) {
      Toast.makeText(this, DictationService.friendly(ex), Toast.LENGTH_LONG).show();
    }
    render();
  }

  private void render() {
    list.removeAllViews();
    List<Attachments.Item> items = attachments.pending();
    if (items.isEmpty()) return;
    list.addView(ui.label(tr("Attached")));
    for (Attachments.Item item : items) {
      LinearLayout row = ui.horizontal();
      row.setGravity(Gravity.CENTER_VERTICAL);
      String kind =
          switch (item.kind()) {
            case "text" -> tr("Text");
            case "image" -> tr("Image");
            case "pdf" -> "PDF";
            default -> tr("File");
          };
      row.addView(ui.text(kind + " · " + item.name(), 14, Ui.INK), new LinearLayout.LayoutParams(0, -2, 1));
      Button remove =
          ui.button(
              "✕",
              Ui.Kind.QUIET,
              v -> {
                try {
                  attachments.remove(item);
                } catch (Exception ignored) {
                  /* Shown again below. */
                }
                render();
              });
      remove.setContentDescription(tr("Remove %1$s", item.name()));
      row.addView(remove);
      ui.add(list, row, 4);
    }
    DictationTile.refresh(this);
  }
}
