package app.driftdictation;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import org.json.JSONArray;
import org.json.JSONObject;

/**
 * A small client for MCP servers over Streamable HTTP: initialize, list tools, call a tool. An
 * optional token is sent as a bearer header. BbBridge uses it to talk to bb's MCP server.
 */
final class Mcp {
  static final String PROTOCOL = "2025-06-18";

  /** A server the user runs: a name for messages, its address and an optional token. */
  record Server(String name, String url, String token) {}

  record Tool(String name, String description, JSONObject schema) {}

  /**
   * Dictate & Delegate's own message about a server; anything else from the network gets one. status is the
   * HTTP status when the server answered with an error, otherwise 0.
   */
  static final class McpException extends IOException {
    final int status;

    /** The server wasn't reached, or the connection broke off: worth trying again soon. */
    boolean unreachable;

    McpException(String message) {
      this(message, 0);
    }

    McpException(String message, int status) {
      super(message);
      this.status = status;
    }

    /**
     * bb couldn't be reached for now: no connection, or bb Connect's gateway answering for it
     * while the tunnel to bb reconnects (502, 503, 504), or too busy (429).
     */
    boolean passing() {
      return unreachable || status == 429 || status == 502 || status == 503 || status == 504;
    }
  }

  /** One session with one server. */
  static final class Connection {
    final Server server;
    private String session;
    private int nextId = 1;

    /** What this session is for, in the network log ("bb tell chief"), and which try it is. */
    String what = "MCP";

    int retry;

    Connection(Server server) {
      this.server = server;
    }

    void open() throws Exception {
      request(
          "initialize",
          new JSONObject()
              .put("protocolVersion", PROTOCOL)
              .put("capabilities", new JSONObject())
              .put(
                  "clientInfo",
                  new JSONObject().put("name", "Dictate & Delegate").put("version", BuildConfig.VERSION_NAME)));
      notify("notifications/initialized");
    }

    List<Tool> tools() throws Exception {
      List<Tool> out = new ArrayList<>();
      String cursor = null;
      for (int page = 0; page < 5; page++) {
        JSONObject params = new JSONObject();
        if (cursor != null) params.put("cursor", cursor);
        JSONObject result = request("tools/list", params);
        JSONArray tools = result.optJSONArray("tools");
        for (int i = 0; tools != null && i < tools.length(); i++) {
          JSONObject t = tools.getJSONObject(i);
          JSONObject schema = t.optJSONObject("inputSchema");
          out.add(
              new Tool(
                  t.getString("name"),
                  t.optString("description"),
                  schema == null ? new JSONObject().put("type", "object") : schema));
        }
        cursor = result.optString("nextCursor", null);
        if (cursor == null || cursor.isEmpty()) break;
      }
      return out;
    }

    /** The tool's text result; errors come back as text too, prefixed with "Error: ". */
    String call(String tool, JSONObject arguments) throws Exception {
      JSONObject result = callResult(tool, arguments);
      return (result.optBoolean("isError") ? "Error: " : "") + text(result);
    }

    /** The raw result of tools/call: {"content": [...], "isError": …}. */
    JSONObject callResult(String tool, JSONObject arguments) throws Exception {
      return request("tools/call", new JSONObject().put("name", tool).put("arguments", arguments));
    }

    /** A tool result's content as text, parts joined by line breaks. */
    static String text(JSONObject result) throws Exception {
      StringBuilder s = new StringBuilder();
      JSONArray content = result.optJSONArray("content");
      for (int i = 0; content != null && i < content.length(); i++) {
        JSONObject part = content.getJSONObject(i);
        if (s.length() > 0) s.append("\n");
        switch (part.optString("type")) {
          case "text" -> s.append(part.optString("text"));
          case "resource" -> {
            JSONObject r = part.optJSONObject("resource");
            s.append(r == null ? "" : r.optString("text", r.optString("uri")));
          }
          default -> s.append("[").append(part.optString("type")).append("]");
        }
      }
      if (s.length() == 0 && result.has("structuredContent"))
        s.append(result.get("structuredContent").toString());
      return s.toString();
    }

    private void notify(String method) throws Exception {
      post(new JSONObject().put("jsonrpc", "2.0").put("method", method));
    }

    private JSONObject request(String method, JSONObject params) throws Exception {
      int id = nextId++;
      JSONObject reply =
          post(
              new JSONObject()
                  .put("jsonrpc", "2.0")
                  .put("id", id)
                  .put("method", method)
                  .put("params", params));
      if (reply == null) throw new McpException(tr("%1$s didn't answer.", server.name()));
      JSONObject error = reply.optJSONObject("error");
      if (error != null)
        throw new McpException(server.name() + ": " + error.optString("message", "error"));
      return reply.optJSONObject("result") == null ? new JSONObject() : reply.getJSONObject("result");
    }

    /**
     * One JSON-RPC message; the answer comes as JSON or as an event stream. A connection that
     * broke off (often a kept-alive one the server had closed) is tried once more, except for
     * tools/call: that one may have run already.
     */
    private JSONObject post(JSONObject message) throws Exception {
      try {
        try {
          return send(message, retry);
        } catch (McpException ex) {
          throw ex;
        } catch (IOException ex) {
          if (message.optString("method").equals("tools/call")
              || ex instanceof java.net.ConnectException
              || ex instanceof java.net.SocketTimeoutException
              || ex instanceof java.net.UnknownHostException) throw ex;
          return send(message, retry + 1);
        }
      } catch (McpException ex) {
        throw ex;
      } catch (IOException ex) {
        String why =
            ex instanceof java.net.ConnectException
                ? tr("nothing answers at this address")
                : ex instanceof java.net.SocketTimeoutException
                    ? tr("no answer in time")
                    : ex instanceof java.net.UnknownHostException
                        ? tr("unknown address")
                        : tr("the connection broke off; is it an MCP server (Streamable HTTP)?");
        McpException failed = new McpException(tr("Could not reach %1$s at %2$s: %3$s.", server.name(), server.url(), why));
        failed.unreachable = true;
        failed.initCause(ex);
        throw failed;
      }
    }

    /** One POST, in the network log as what this session is for, with the JSON-RPC method (and tool). */
    private JSONObject send(JSONObject message, int retry) throws Exception {
      String method = message.optString("method");
      JSONObject params = message.optJSONObject("params");
      String tool = method.equals("tools/call") && params != null ? " " + params.optString("name") : "";
      return NetLog.request(what, "POST", server.url(), retry, net -> send(message, net.note(method + tool)));
    }

    private JSONObject send(JSONObject message, NetLog.Call net) throws Exception {
      HttpURLConnection c = (HttpURLConnection) new URL(server.url()).openConnection();
      try {
        c.setConnectTimeout(10_000);
        c.setReadTimeout(60_000);
        c.setInstanceFollowRedirects(false);
        c.setRequestMethod("POST");
        c.setRequestProperty("Content-Type", "application/json");
        c.setRequestProperty("Accept", "application/json, text/event-stream");
        c.setRequestProperty("MCP-Protocol-Version", PROTOCOL);
        if (session != null) c.setRequestProperty("Mcp-Session-Id", session);
        if (!server.token().isBlank())
          c.setRequestProperty("Authorization", "Bearer " + server.token().trim());
        String text = message.toString();
        byte[] payload = text.getBytes(StandardCharsets.UTF_8);
        net.request(NetLog.requestIn(text)).sent(payload.length);
        c.setDoOutput(true);
        c.setFixedLengthStreamingMode(payload.length);
        try (OutputStream out = c.getOutputStream()) {
          out.write(payload);
        }
        int status = c.getResponseCode();
        net.status(status);
        String id = c.getHeaderField("Mcp-Session-Id");
        if (id != null && !id.isBlank()) session = id;
        if (status == 202 || status == 204) return null;
        if (status >= 300 && status < 400)
          throw new McpException(
              tr("%1$s answered with a redirect (HTTP %2$d). Check the address.", server.name(), status),
              status);
        if (status >= 400)
          throw new McpException(tr("%1$s answered with HTTP %2$d.", server.name(), status), status);
        String type = String.valueOf(c.getContentType());
        String body = read(c.getInputStream());
        net.received(body.getBytes(StandardCharsets.UTF_8).length);
        if (type.contains("text/event-stream")) return fromStream(body, message.opt("id"));
        return body.isBlank() ? null : new JSONObject(body);
      } finally {
        c.disconnect();
      }
    }

    /**
     * The event that answers this request; servers may send notifications before it. Events end
     * with a blank line (split keeps the trailing empty lines with limit -1).
     */
    static JSONObject fromStream(String stream, Object id) throws Exception {
      JSONObject last = null;
      StringBuilder data = new StringBuilder();
      for (String line : (stream.replace("\r\n", "\n") + "\n\n").split("\n", -1)) {
        if (line.startsWith("data:")) data.append(line.substring(5).trim());
        else if (line.isBlank() && data.length() > 0) {
          JSONObject event = new JSONObject(data.toString());
          data.setLength(0);
          if (id != null && String.valueOf(id).equals(String.valueOf(event.opt("id")))) return event;
          if (event.has("result") || event.has("error")) last = event;
        }
      }
      return last;
    }

    private static String read(InputStream in) throws IOException {
      try (in) {
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        byte[] buffer = new byte[8192];
        for (int n; (n = in.read(buffer)) > 0; ) {
          out.write(buffer, 0, n);
          if (out.size() > 4_000_000) throw new IOException("The MCP answer is too large.");
        }
        return out.toString(StandardCharsets.UTF_8);
      }
    }

    private static String tr(String english, Object... args) {
      return I18n.tr(english, args);
    }
  }
}
