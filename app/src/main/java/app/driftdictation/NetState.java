package app.driftdictation;

import android.content.Context;
import android.net.ConnectivityManager;
import android.net.LinkAddress;
import android.net.LinkProperties;
import android.net.Network;
import android.net.NetworkCapabilities;
import android.net.TelephonyNetworkSpecifier;
import android.telephony.SubscriptionManager;
import android.telephony.TelephonyManager;
import java.net.Inet4Address;
import java.net.Inet6Address;
import java.util.ArrayList;
import java.util.List;

/**
 * The network at a moment, for the network log: "wifi, v4+v6" or "mobile Vodafone.de (data SIM,
 * slot 2), v6 only, roaming". Only what Android tells an app without extra permissions: no Wi-Fi
 * name, no phone number. Network changes go into the log as they happen.
 */
final class NetState {
  private NetState() {}

  /** Starts the network log for the app (App.onCreate). */
  static void install(Context context) {
    Context app = context.getApplicationContext();
    NetLog.init(new java.io.File(app.getFilesDir(), "network.log"), () -> describe(app));
    ConnectivityManager cm = app.getSystemService(ConnectivityManager.class);
    if (cm == null) return;
    try {
      cm.registerDefaultNetworkCallback(
          new ConnectivityManager.NetworkCallback() {
            @Override
            public void onCapabilitiesChanged(Network n, NetworkCapabilities caps) {
              NetLog.networkChanged(describe(app, cm, n, caps));
            }

            @Override
            public void onLinkPropertiesChanged(Network n, LinkProperties lp) {
              NetLog.networkChanged(describe(app, cm, n, cm.getNetworkCapabilities(n)));
            }

            @Override
            public void onLost(Network n) {
              NetLog.networkChanged(describe(app));
            }
          });
    } catch (RuntimeException ex) {
      /* Too many callbacks or no permission: the entries still say the network. */
    }
  }

  static String describe(Context context) {
    ConnectivityManager cm = context.getSystemService(ConnectivityManager.class);
    if (cm == null) return "network unknown";
    Network n = cm.getActiveNetwork();
    if (n == null) return "offline";
    return describe(context, cm, n, cm.getNetworkCapabilities(n));
  }

  private static String describe(Context context, ConnectivityManager cm, Network n, NetworkCapabilities caps) {
    if (caps == null) return "offline";
    List<String> parts = new ArrayList<>();
    String kind =
        caps.hasTransport(NetworkCapabilities.TRANSPORT_WIFI)
            ? "wifi"
            : caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)
                ? "mobile"
                : caps.hasTransport(NetworkCapabilities.TRANSPORT_ETHERNET)
                    ? "ethernet"
                    : caps.hasTransport(NetworkCapabilities.TRANSPORT_BLUETOOTH) ? "bluetooth" : "other";
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_VPN)) kind = "vpn" + (kind.equals("other") ? "" : " over " + kind);
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR)) kind += mobile(context, caps);
    parts.add(kind);
    LinkProperties lp = cm.getLinkProperties(n);
    if (lp != null) {
      boolean v4 = false, v6 = false;
      for (LinkAddress a : lp.getLinkAddresses()) {
        if (a.getAddress() instanceof Inet4Address) v4 = true;
        else if (a.getAddress() instanceof Inet6Address && !a.getAddress().isLinkLocalAddress()) v6 = true;
      }
      parts.add(v4 && v6 ? "v4+v6" : v4 ? "v4 only" : v6 ? "v6 only" : "no address");
      if (lp.isPrivateDnsActive()) parts.add("private DNS");
    }
    if (!caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_VALIDATED)) parts.add("not validated");
    if (caps.hasTransport(NetworkCapabilities.TRANSPORT_CELLULAR) && !caps.hasCapability(NetworkCapabilities.NET_CAPABILITY_NOT_ROAMING))
      parts.add("roaming");
    return String.join(", ", parts);
  }

  /** " Vodafone.de (data SIM, slot 2)": the carrier, and whether this network is the data SIM's. */
  private static String mobile(Context context, NetworkCapabilities caps) {
    try {
      int dataSub = SubscriptionManager.getDefaultDataSubscriptionId();
      int sub = caps.getNetworkSpecifier() instanceof TelephonyNetworkSpecifier t ? t.getSubscriptionId() : -1;
      int shown = sub >= 0 ? sub : dataSub;
      TelephonyManager tm = context.getSystemService(TelephonyManager.class);
      String carrier = "";
      if (tm != null && shown >= 0) carrier = tm.createForSubscriptionId(shown).getNetworkOperatorName();
      int slot = shown >= 0 ? SubscriptionManager.getSlotIndex(shown) : -1;
      String sim = sub < 0 ? "data SIM" : sub == dataSub ? "data SIM" : "not the data SIM";
      return (carrier == null || carrier.isEmpty() ? "" : " " + carrier)
          + " (" + sim + (slot >= 0 ? ", slot " + (slot + 1) : "") + ")";
    } catch (RuntimeException ex) {
      return "";
    }
  }
}
