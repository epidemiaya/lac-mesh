package uk.lac.mesh;

import android.content.BroadcastReceiver;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.net.NetworkInfo;
import android.net.wifi.p2p.WifiP2pConfig;
import android.net.wifi.p2p.WifiP2pDevice;
import android.net.wifi.p2p.WifiP2pManager;
import android.net.wifi.p2p.WifiP2pManager.ActionListener;
import android.net.wifi.p2p.WifiP2pManager.Channel;
import android.os.Looper;
import android.util.Log;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.PrintWriter;
import java.net.InetSocketAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

// v2 � TCP after group formed, groupOwnerIntent=15
public class LacWifiDirect {

    private static final String TAG       = "LacWifiDirect";
    public  static final int    MESH_PORT = 47731;

    public interface Listener {
        void onPeerFound(String deviceAddress, String deviceName);
        void onPeerLost(String deviceAddress);
        void onPacketReceived(String rawJson, String fromAddress);
        void onConnected(String groupOwnerIp, boolean isGroupOwner);
        void onDisconnected();
        void onLog(String message);
    }

    private final Context         context;
    private final Listener        listener;
    private final WifiP2pManager  manager;
    private final Channel         channel;
    private final ExecutorService executor;

    private final Map<String, PeerConnection> connections    = new HashMap<>();
    private final List<WifiP2pDevice>         discoveredPeers = new ArrayList<>();

    private ServerSocket serverSocket;
    private boolean      running      = false;
    private boolean      groupFormed  = false;

    public LacWifiDirect(Context context, Listener listener) {
        this.context  = context;
        this.listener = listener;
        this.executor = Executors.newCachedThreadPool();
        this.manager  = (WifiP2pManager) context.getSystemService(Context.WIFI_P2P_SERVICE);
        this.channel  = manager.initialize(context, Looper.getMainLooper(), null);
    }

    // ── Public API ────────────────────────────────────────────────────────────

    public void start() {
        running = true;
        registerReceiver();
        startTcpServer();
        discoverPeers();
        log("LacWifiDirect started on port " + MESH_PORT);
    }

    public void stop() {
        running = false;
        try { context.unregisterReceiver(receiver); } catch (Exception ignored) {}
        closeAllConnections();
        if (serverSocket != null) {
            try { serverSocket.close(); } catch (IOException ignored) {}
        }
        manager.stopPeerDiscovery(channel, null);
        manager.removeGroup(channel, null);
        log("LacWifiDirect stopped");
    }

    public void broadcast(String rawJson) {
        synchronized (connections) {
            if (connections.isEmpty()) {
                log("broadcast: no peers connected");
                return;
            }
            for (String key : connections.keySet()) {
                sendTo(key, rawJson);
            }
        }
    }

    public void sendTo(String peerId, String rawJson) {
        PeerConnection conn = connections.get(peerId);
        if (conn == null) return;
        executor.submit(() -> {
            try {
                conn.writer.println(rawJson);
                conn.writer.flush();
            } catch (Exception e) {
                log("sendTo failed: " + e.getMessage());
                removePeer(peerId);
            }
        });
    }

    public void connectToPeer(String deviceAddress) {
        WifiP2pConfig config = new WifiP2pConfig();
        config.deviceAddress    = deviceAddress;
        config.groupOwnerIntent = 15; // prefer being Group Owner so we can accept TCP

        manager.connect(channel, config, new ActionListener() {
            @Override public void onSuccess() { log("P2P connect initiated → " + deviceAddress); }
            @Override public void onFailure(int r) { log("P2P connect failed → " + deviceAddress + " reason=" + r); }
        });
    }

    public int getConnectedCount() { return connections.size(); }

    // ── Discovery ─────────────────────────────────────────────────────────────

    private void discoverPeers() {
        manager.discoverPeers(channel, new ActionListener() {
            @Override public void onSuccess() { log("peer discovery started"); }
            @Override public void onFailure(int r) {
                log("peer discovery failed, reason=" + r);
                if (running) {
                    new android.os.Handler(Looper.getMainLooper())
                        .postDelayed(() -> discoverPeers(), 5000);
                }
            }
        });
    }

    private void requestPeerList() {
        manager.requestPeers(channel, peers -> {
            discoveredPeers.clear();
            for (WifiP2pDevice device : peers.getDeviceList()) {
                discoveredPeers.add(device);
                listener.onPeerFound(device.deviceAddress, device.deviceName);
                log("found peer: " + device.deviceName + " @ " + device.deviceAddress);

                // Initiate P2P connection — TCP will happen after group is formed
                if (!groupFormed) {
                    connectToPeer(device.deviceAddress);
                }
            }
        });
    }

    private void requestConnectionInfo() {
        manager.requestConnectionInfo(channel, info -> {
            if (info != null && info.groupFormed) {
                groupFormed = true;
                String  ownerIp = info.groupOwnerAddress.getHostAddress();
                boolean isOwner = info.isGroupOwner;
                log("group formed — ownerIp=" + ownerIp + " isOwner=" + isOwner);
                listener.onConnected(ownerIp, isOwner);

                if (!isOwner) {
                    // We are STA — connect TCP to Group Owner
                    connectTcpTo(ownerIp, "go_" + ownerIp);
                }
                // If we ARE the Group Owner, the STA will connect to our TCP server
            } else {
                groupFormed = false;
            }
        });
    }

    // ── TCP Server ────────────────────────────────────────────────────────────

    private void startTcpServer() {
        executor.submit(() -> {
            try {
                serverSocket = new ServerSocket(MESH_PORT);
                log("TCP server listening on :" + MESH_PORT);
                while (running) {
                    try {
                        Socket client = serverSocket.accept();
                        String ip = client.getInetAddress().getHostAddress();
                        log("incoming TCP from " + ip);
                        handleIncomingSocket(client, "client_" + ip);
                    } catch (IOException e) {
                        if (running) log("server accept error: " + e.getMessage());
                    }
                }
            } catch (IOException e) {
                log("TCP server failed: " + e.getMessage());
            }
        });
    }

    private void handleIncomingSocket(Socket socket, String peerId) {
        executor.submit(() -> {
            try {
                PrintWriter    writer = new PrintWriter(socket.getOutputStream(), true);
                PeerConnection conn   = new PeerConnection(socket, writer, peerId);
                synchronized (connections) { connections.put(peerId, conn); }
                listener.onPeerFound(peerId, peerId);
                log("TCP peer connected (incoming): " + peerId);

                BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream()));
                String line;
                while (running && (line = reader.readLine()) != null) {
                    if (!line.isEmpty()) listener.onPacketReceived(line, peerId);
                }
            } catch (IOException e) {
                log("incoming peer error: " + e.getMessage());
            } finally {
                removePeer(peerId);
            }
        });
    }

    // ── TCP Client ────────────────────────────────────────────────────────────

    private void connectTcpTo(String ip, String peerId) {
        if (connections.containsKey(peerId)) return;
        executor.submit(() -> {
            int retries = 0;
            while (running && retries < 8) {
                try {
                    log("TCP connecting to " + ip + ":" + MESH_PORT + " (attempt " + (retries + 1) + ")");
                    Socket socket = new Socket();
                    socket.connect(new InetSocketAddress(ip, MESH_PORT), 5000);

                    PrintWriter    writer = new PrintWriter(socket.getOutputStream(), true);
                    PeerConnection conn   = new PeerConnection(socket, writer, peerId);
                    synchronized (connections) { connections.put(peerId, conn); }
                    listener.onPeerFound(peerId, ip);
                    log("TCP connected to " + ip + " ✓");

                    BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream()));
                    String line;
                    while (running && (line = reader.readLine()) != null) {
                        if (!line.isEmpty()) listener.onPacketReceived(line, peerId);
                    }
                    break;
                } catch (IOException e) {
                    retries++;
                    log("TCP connect failed (" + retries + "): " + e.getMessage());
                    try { Thread.sleep(2000); } catch (InterruptedException ignored) {}
                }
            }
            if (retries >= 8) {
                log("gave up TCP to " + ip);
            }
        });
    }

    // ── BroadcastReceiver ─────────────────────────────────────────────────────

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context context, Intent intent) {
            String action = intent.getAction();
            if (action == null) return;
            switch (action) {
                case WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION:
                    requestPeerList();
                    break;
                case WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION:
                    NetworkInfo netInfo = intent.getParcelableExtra(WifiP2pManager.EXTRA_NETWORK_INFO);
                    if (netInfo != null && netInfo.isConnected()) {
                        requestConnectionInfo();
                    } else {
                        groupFormed = false;
                        listener.onDisconnected();
                        log("WiFi P2P disconnected");
                        // Restart discovery
                        if (running) discoverPeers();
                    }
                    break;
                case WifiP2pManager.WIFI_P2P_DISCOVERY_CHANGED_ACTION:
                    int state = intent.getIntExtra(WifiP2pManager.EXTRA_DISCOVERY_STATE, -1);
                    if (state == WifiP2pManager.WIFI_P2P_DISCOVERY_STOPPED && running && !groupFormed) {
                        log("discovery stopped — restarting");
                        discoverPeers();
                    }
                    break;
            }
        }
    };

    private void registerReceiver() {
        IntentFilter filter = new IntentFilter();
        filter.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
        filter.addAction(WifiP2pManager.WIFI_P2P_DISCOVERY_CHANGED_ACTION);
        context.registerReceiver(receiver, filter);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void removePeer(String id) {
        PeerConnection conn = connections.remove(id);
        if (conn != null) {
            try { conn.socket.close(); } catch (IOException ignored) {}
            listener.onPeerLost(id);
        }
    }

    private void closeAllConnections() {
        synchronized (connections) {
            for (PeerConnection conn : connections.values()) {
                try { conn.socket.close(); } catch (IOException ignored) {}
            }
            connections.clear();
        }
    }

    private void log(String msg) {
        Log.d(TAG, msg);
        listener.onLog(msg);
    }

    private static class PeerConnection {
        final Socket      socket;
        final PrintWriter writer;
        final String      id;
        PeerConnection(Socket s, PrintWriter w, String id) {
            this.socket = s; this.writer = w; this.id = id;
        }
    }
}
