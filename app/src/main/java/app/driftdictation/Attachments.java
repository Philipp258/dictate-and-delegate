package app.driftdictation;

import static app.driftdictation.I18n.tr;

import android.content.Context;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.net.Uri;
import android.provider.OpenableColumns;
import android.database.Cursor;
import java.io.ByteArrayOutputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.Base64;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * What the user adds to a dictation while recording, with the 📎 on the floating button or in
 * Dictate & Delegate: pasted text or files (images, PDFs, text). They wait in "pending" for the dictation
 * being recorded (or the next one), then move to that note's folder, so a redo or "process again"
 * has them too, and are kept as long as its audio. The request check sees a short summary; the
 * text model gets the content; a dictation that asks for nothing ignores them.
 */
final class Attachments {
  /** One attachment: "text", "image", "pdf" or "file" (read as text); path inside the folder. */
  record Item(String kind, String name, String file, long size) {
    JSONObject json() throws Exception {
      return new JSONObject().put("kind", kind).put("name", name).put("file", file).put("size", size);
    }

    static Item of(JSONObject o) {
      return new Item(o.optString("kind"), o.optString("name"), o.optString("file"), o.optLong("size"));
    }
  }

  static final long MAX_FILE = 10_000_000, MAX_TEXT = 60_000;
  static final int MAX_ITEMS = 6;

  private final Context context;

  Attachments(Context context) {
    this.context = context;
  }

  private File root() {
    return new File(context.getNoBackupFilesDir(), "attachments");
  }

  private File folder(String note) {
    return new File(root(), note);
  }

  /** The attachments waiting for the current or next dictation. */
  List<Item> pending() {
    return read(folder("pending"));
  }

  List<Item> of(String note) {
    return read(folder(note));
  }

  void addText(String text) throws Exception {
    String clean = text.trim();
    if (clean.isEmpty()) throw new IOException(tr("Nothing to paste: copy some text first."));
    if (clean.length() > MAX_TEXT) clean = clean.substring(0, (int) MAX_TEXT);
    String first = clean.replace('\n', ' ');
    add(
        "text",
        first.length() > 40 ? first.substring(0, 40) + "…" : first,
        clean.getBytes(StandardCharsets.UTF_8),
        ".txt");
  }

  /** Copies a file the user picked; images are scaled down to keep notes small and cheap. */
  void addFile(Uri uri) throws Exception {
    String type = String.valueOf(context.getContentResolver().getType(uri));
    String name = displayName(uri);
    byte[] data;
    try (InputStream in = context.getContentResolver().openInputStream(uri)) {
      if (in == null) throw new IOException(tr("Could not read this file."));
      data = readAll(in);
    }
    if (type.startsWith("image/")) add("image", name, shrink(data), ".jpg");
    else if (type.equals("application/pdf") || name.toLowerCase().endsWith(".pdf"))
      add("pdf", name, data, ".pdf");
    else add("file", name, data, ".txt");
  }

  void remove(Item item) throws Exception {
    File f = folder("pending");
    List<Item> list = read(f);
    list.removeIf(i -> i.file().equals(item.file()));
    new File(f, item.file()).delete();
    write(f, list);
  }

  void clearPending() {
    delete(folder("pending"));
  }

  /** The finished dictation keeps what was attached while it was recorded. */
  void claimPending(String note) {
    File from = folder("pending"), to = folder(note);
    if (!from.exists() || read(from).isEmpty()) return;
    delete(to);
    root().mkdirs();
    if (!from.renameTo(to)) delete(from);
  }

  void deleteNote(String note) {
    delete(folder(note));
  }

  void deleteAll() {
    delete(root());
  }

  /** Same time limit as saved audio: a week, then only the note's text stays (not for a note still queued for the chief). */
  void prune() {
    File[] notes = root().listFiles();
    long weekAgo = System.currentTimeMillis() - 7L * 86_400_000L;
    java.util.Set<String> queued = null;
    for (int i = 0; notes != null && i < notes.length; i++)
      if (!notes[i].getName().equals("pending") && notes[i].lastModified() < weekAgo) {
        if (queued == null) queued = Outbox.queuedRecordings(context);
        if (!queued.contains(notes[i].getName())) delete(notes[i]);
      }
  }

  /** "Attached: pasted text (1,234 characters): "…"; image photo.jpg; PDF offer.pdf" */
  String summary(String note) {
    List<Item> items = of(note);
    if (items.isEmpty()) return "";
    StringBuilder s = new StringBuilder("The user attached:");
    for (Item i : items) {
      s.append("\n- ");
      switch (i.kind()) {
        case "text" -> {
          String text = readText(note, i);
          s.append("pasted text (").append(text.length()).append(" characters): \"")
              .append(text.length() > 300 ? text.substring(0, 300) + "…" : text).append("\"");
        }
        case "image" -> s.append("an image (").append(i.name()).append(")");
        case "pdf" -> s.append("a PDF (").append(i.name()).append(")");
        default -> s.append("a file (").append(i.name()).append(")");
      }
    }
    return s.toString();
  }

  /**
   * For the chief of staff: pasted text and text files as {name, text}. Images and PDFs aren't
   * sent to it in this version; their names go to skipped.
   */
  /** Pasted text and text files, for the chief: {name, text}. */
  List<String[]> texts(String note) {
    List<String[]> out = new ArrayList<>();
    for (Item i : of(note)) {
      switch (i.kind()) {
        case "text" -> out.add(new String[] {"pasted text", readText(note, i)});
        case "file" -> out.add(new String[] {i.name(), readText(note, i)});
        default -> {}
      }
    }
    return out;
  }

  /** An image or PDF as bytes, for the chief. */
  record Binary(String kind, String name, String mimeType, byte[] data) {
    boolean image() {
      return kind.equals("image");
    }

    /** The name with the extension its bytes have (images are stored as JPEG). */
    String fileName() {
      String ext = image() ? ".jpg" : ".pdf";
      String base = name.replaceAll("[^A-Za-z0-9._-]", "_");
      return base.toLowerCase().endsWith(ext) ? base : base.replaceFirst("\\.[A-Za-z0-9]+$", "") + ext;
    }
  }

  /** Images, then PDFs: what goes to the chief as attachments. */
  List<Binary> binaries(String note) throws IOException {
    List<Binary> images = new ArrayList<>(), others = new ArrayList<>();
    for (Item i : of(note)) {
      if (!i.kind().equals("image") && !i.kind().equals("pdf")) continue;
      byte[] data = Files.readAllBytes(new File(folder(note), i.file()).toPath());
      if (i.kind().equals("image")) images.add(new Binary("image", i.name(), "image/jpeg", data));
      else others.add(new Binary("pdf", i.name(), "application/pdf", data));
    }
    images.addAll(others);
    return images;
  }

  /** Message parts for the model: text inline, images and PDFs as base64. */
  JSONArray parts(String note) throws Exception {
    JSONArray parts = new JSONArray();
    for (Item i : of(note)) {
      File f = new File(folder(note), i.file());
      switch (i.kind()) {
        case "image" ->
            parts.put(
                new JSONObject()
                    .put("type", "image_url")
                    .put(
                        "image_url",
                        new JSONObject()
                            .put(
                                "url",
                                "data:image/jpeg;base64,"
                                    + Base64.getEncoder().encodeToString(Files.readAllBytes(f.toPath())))));
        case "pdf" ->
            parts.put(
                new JSONObject()
                    .put("type", "file")
                    .put(
                        "file",
                        new JSONObject()
                            .put("filename", i.name())
                            .put(
                                "file_data",
                                "data:application/pdf;base64,"
                                    + Base64.getEncoder().encodeToString(Files.readAllBytes(f.toPath())))));
        default ->
            parts.put(
                new JSONObject()
                    .put("type", "text")
                    .put(
                        "text",
                        "<attachment name=\""
                            + i.name().replace("\"", "'")
                            + "\">\n"
                            + readText(note, i)
                            + "\n</attachment>"));
      }
    }
    return parts;
  }

  private String readText(String note, Item i) {
    try {
      String text = new String(Files.readAllBytes(new File(folder(note), i.file()).toPath()), StandardCharsets.UTF_8);
      return text.length() > MAX_TEXT ? text.substring(0, (int) MAX_TEXT) : text;
    } catch (IOException ex) {
      return "";
    }
  }

  /** Also used by the device tests to attach bytes directly. */
  void add(String kind, String name, byte[] data, String suffix) throws Exception {
    if (data.length > MAX_FILE) throw new IOException(tr("This file is too large (at most 10 MB)."));
    File f = folder("pending");
    List<Item> list = read(f);
    if (list.size() >= MAX_ITEMS) throw new IOException(tr("At most %1$d attachments per dictation.", MAX_ITEMS));
    f.mkdirs();
    String file = System.currentTimeMillis() + "-" + list.size() + suffix;
    try (FileOutputStream out = new FileOutputStream(new File(f, file))) {
      out.write(data);
    }
    list.add(new Item(kind, name.isBlank() ? kind : name, file, data.length));
    write(f, list);
  }

  private static byte[] shrink(byte[] data) throws IOException {
    BitmapFactory.Options bounds = new BitmapFactory.Options();
    bounds.inJustDecodeBounds = true;
    BitmapFactory.decodeByteArray(data, 0, data.length, bounds);
    // At most 1600 wide and 8000 tall: a long screenshot of a whole listing stays readable.
    int scale = 1;
    while (bounds.outWidth / scale > 3200 || bounds.outHeight / scale > 16000) scale *= 2;
    BitmapFactory.Options options = new BitmapFactory.Options();
    options.inSampleSize = scale;
    Bitmap bitmap = BitmapFactory.decodeByteArray(data, 0, data.length, options);
    if (bitmap == null) throw new IOException(tr("Could not read this image."));
    float f = Math.min(1f, Math.min(1600f / bitmap.getWidth(), 8000f / bitmap.getHeight()));
    if (f < 1f)
      bitmap =
          Bitmap.createScaledBitmap(
              bitmap, Math.round(bitmap.getWidth() * f), Math.round(bitmap.getHeight() * f), true);
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    bitmap.compress(Bitmap.CompressFormat.JPEG, 85, out);
    return out.toByteArray();
  }

  private String displayName(Uri uri) {
    try (Cursor c = context.getContentResolver().query(uri, new String[] {OpenableColumns.DISPLAY_NAME}, null, null, null)) {
      if (c != null && c.moveToFirst()) return c.getString(0);
    } catch (Exception ignored) {
      /* Fall back to the last part of the address. */
    }
    String last = uri.getLastPathSegment();
    return last == null ? "file" : last;
  }

  private static byte[] readAll(InputStream in) throws IOException {
    ByteArrayOutputStream out = new ByteArrayOutputStream();
    byte[] buffer = new byte[16384];
    for (int n; (n = in.read(buffer)) > 0; ) {
      out.write(buffer, 0, n);
      if (out.size() > MAX_FILE) throw new IOException(tr("This file is too large (at most 10 MB)."));
    }
    return out.toByteArray();
  }

  private static List<Item> read(File folder) {
    List<Item> out = new ArrayList<>();
    try {
      JSONArray a = new JSONArray(new String(Files.readAllBytes(new File(folder, "items.json").toPath()), StandardCharsets.UTF_8));
      for (int i = 0; i < a.length(); i++) out.add(Item.of(a.getJSONObject(i)));
    } catch (Exception ignored) {
      /* No attachments. */
    }
    return out;
  }

  private static void write(File folder, List<Item> list) throws Exception {
    JSONArray a = new JSONArray();
    for (Item i : list) a.put(i.json());
    folder.mkdirs();
    Files.write(new File(folder, "items.json").toPath(), a.toString().getBytes(StandardCharsets.UTF_8));
  }

  private static void delete(File f) {
    File[] children = f.listFiles();
    for (int i = 0; children != null && i < children.length; i++) delete(children[i]);
    f.delete();
  }
}
