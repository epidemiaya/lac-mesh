package uk.lac.mesh;

import android.Manifest;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;

/**
 * LacWifiDirectPlugin — Capacitor bridge between JS and LacWifiDirect.java
 *
 * JS usage (in WifiDirectTransport.js):
 *   const plugin = window.Capacitor.Plugins.LacWifiDirect
 *   await plugin.start()
 *   await plugin.broadcast({ data: rawJson })
 *   plugin.addListener('packet',    handler)
 *   plugin.addListener('peerFound', handler)
 *   plugin.addListener('peerLost',  handler)
 *   plugin.addListener('log',       handler)
 */
@CapacitorPlugin(
    name = "LacWifiDirect",
    permissions = {
        @Permission(strings = { Manifest.permission.ACCESS_FINE_LOCATION },    alias = "location"),
        @Permission(strings = { Manifest.permission.NEARBY_WIFI_DEVICES },     alias = "nearbyWifi"),
        @Permission(strings = { Manifest.permission.ACCESS_WIFI_STATE },       alias = "wifiState"),
        @Permission(strings = { Manifest.permission.CHANGE_WIFI_STATE },       alias = "changeWifi"),
        @Permission(strings = { Manifest.permission.INTERNET },                alias = "internet"),
    }
)
public class LacWifiDirectPlugin extends Plugin {

    private LacWifiDirect wifiDirect;

    // ── JS-callable methods ───────────────────────────────────────────────────

    @PluginMethod
    public void start(PluginCall call) {
        requestAllPermissions(call, "permissionsCallback");
    }

    @PermissionCallback
    private void permissionsCallback(PluginCall call) {
        wifiDirect = new LacWifiDirect(getContext(), new LacWifiDirect.Listener() {

            @Override
            public void onPeerFound(String address, String name) {
                JSObject data = new JSObject();
                data.put("address", address);
                data.put("name", name);
                notifyListeners("peerFound", data);
            }

            @Override
            public void onPeerLost(String address) {
                JSObject data = new JSObject();
                data.put("address", address);
                notifyListeners("peerLost", data);
            }

            @Override
            public void onPacketReceived(String rawJson, String fromAddress) {
                JSObject data = new JSObject();
                data.put("data", rawJson);
                data.put("from", fromAddress);
                notifyListeners("packet", data);
            }

            @Override
            public void onConnected(String groupOwnerIp, boolean isGroupOwner) {
                JSObject data = new JSObject();
                data.put("groupOwnerIp", groupOwnerIp);
                data.put("isGroupOwner", isGroupOwner);
                notifyListeners("connected", data);
            }

            @Override
            public void onDisconnected() {
                notifyListeners("disconnected", new JSObject());
            }

            @Override
            public void onLog(String message) {
                JSObject data = new JSObject();
                data.put("message", message);
                notifyListeners("log", data);
            }
        });

        wifiDirect.start();
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        if (wifiDirect != null) {
            wifiDirect.stop();
            wifiDirect = null;
        }
        call.resolve();
    }

    @PluginMethod
    public void broadcast(PluginCall call) {
        String data = call.getString("data");
        if (data == null) {
            call.reject("data is required");
            return;
        }
        if (wifiDirect == null) {
            call.reject("not started");
            return;
        }
        wifiDirect.broadcast(data);
        call.resolve();
    }

    @PluginMethod
    public void connectToPeer(PluginCall call) {
        String address = call.getString("address");
        if (address == null) {
            call.reject("address is required");
            return;
        }
        if (wifiDirect == null) {
            call.reject("not started");
            return;
        }
        wifiDirect.connectToPeer(address);
        call.resolve();
    }

    @PluginMethod
    public void getStatus(PluginCall call) {
        JSObject result = new JSObject();
        result.put("running", wifiDirect != null);
        result.put("peers", wifiDirect != null ? wifiDirect.getConnectedCount() : 0);
        call.resolve(result);
    }
}
