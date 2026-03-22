// v3 � autonomous group, multi-hop, 3+ devices
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
import android.os.Build;
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

/**
 * LacWifiDirect v3 — Multi-hop WiFi Direct mesh for LAC
 *
 * Supports 3+ devices via autonomous group (Android 9+):
 *
 *   Phone A (GO)  ←── Phone B (STA to A + autonomous GO) ←── Phone C (STA)
 *        TCP                        TCP
 *
 * Each device:
 *   1. Creates an autonomous WiFi Direct group (becomes GO/AP)
 *   2. Simultaneously connects as STA to discovered peers
 *   3. Relays packets to all connected peers (flood routing)
 *
 * Relay logic is handled by MeshRouter.js (TTL + dedup).
 * This class is pure transport — send/receive raw JSON strings.
 */
public class LacWifiDirect {

    private static final String TAG       = "LacWifiDirect";
    public  static final int    MESH_PORT = 47731;

    public interface Listener {
        void onPeerFound(String peerId, String peerName);
        void onPeerLost(String peerId);
        void onPacketReceived(String rawJson, String fromId);
        void onConnected(String groupOwnerIp, boolean isGroupOwner);
        void onDisconnected();
        void onLog(String message);
    }

    private final Context         context;
    private final Listener        listener;
    private final WifiP2pManager  manager;
    private final Channel         channel;
    private final ExecutorService executor;

    private final Map<String, PeerConnection> connections     = new HashMap<>();
    private final List<String>                connectingPeers = new ArrayList<>();

    private ServerSocket serverSocket;
    private boolean      running     = false;
    private boolean      groupActive = false;
    private String       myGroupIp   = null;

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

        // Step 1: create autonomous group (we become GO/AP for others)
        createAutonomousGroup();
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
        log("stopped");
    }

    public void broadcast(String rawJson) {
        synchronized (connections) {
            if (connections.isEmpty()) {
                log("broadcast: no peers connected");
                return;
            }
            for (String key : new ArrayList<>(connections.keySet())) {
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
                log("sendTo failed " + peerId + ": " + e.getMessage());
                removePeer(peerId);
            }
        });
    }

    public int getConnectedCount() { return connections.size(); }

    /** Manual connect by device address (called from JS via plugin) */
    public void connectToPeer(String deviceAddress) {
        if (!connections.containsKey(deviceAddress) && !connectingPeers.contains(deviceAddress)) {
            initiateP2pConnect(deviceAddress);
        }
    }

    // ── Autonomous Group (AP+STA core) ────────────────────────────────────────

    /**
     * Create a persistent WiFi Direct group.
     * This makes us a Group Owner (AP) that others can connect to.
     * After group is created, we start discovering and connecting to OTHER peers as STA.
     * Result: we are simultaneously AP (accepting) and STA (connecting) = true mesh node.
     */
    private void createAutonomousGroup() {
        manager.createGroup(channel, new ActionListener() {
            @Override
            public void onSuccess() {
                log("autonomous group created — we are GO/AP");
                groupActive = true;
                // Now discover peers to connect to as STA
                new android.os.Handler(Looper.getMainLooper())
                    .postDelayed(() -> discoverPeers(), 1000);
            }
            @Override
            public void onFailure(int reason) {
                log("createGroup failed reason=" + reason + " — trying removeGroup first");
                // Group might already exist — remove and retry
                manager.removeGroup(channel, new ActionListener() {
                    @Override public void onSuccess() {
                        new android.os.Handler(Looper.getMainLooper())
                            .postDelayed(() -> createAutonomousGroup(), 1000);
                    }
                    @Override public void onFailure(int r) {
                        log("removeGroup also failed — starting discovery anyway");
                        discoverPeers();
                    }
                });
            }
        });
    }

    // ── Discovery ─────────────────────────────────────────────────────────────

    private void discoverPeers() {
        if (!running) return;
        manager.discoverPeers(channel, new ActionListener() {
            @Override public void onSuccess() { log("peer discovery started"); }
            @Override public void onFailure(int r) {
                log("peer discovery failed reason=" + r);
                if (running) {
                    new android.os.Handler(Looper.getMainLooper())
                        .postDelayed(() -> discoverPeers(), 5000);
                }
            }
        });
    }

    private void requestPeerList() {
        manager.requestPeers(channel, peers -> {
            for (WifiP2pDevice device : peers.getDeviceList()) {
                String addr = device.deviceAddress;
                listener.onPeerFound(addr, device.deviceName);
                log("found peer: " + device.deviceName + " @ " + addr);

                // Connect as STA to this peer's group
                // (we are already GO ourselves — AP+STA mode)
                if (!connections.containsKey(addr) && !connectingPeers.contains(addr)) {
                    initiateP2pConnect(addr);
                }
            }
        });
    }

    private void initiateP2pConnect(String deviceAddress) {
        connectingPeers.add(deviceAddress);
        WifiP2pConfig config = new WifiP2pConfig();
        config.deviceAddress    = deviceAddress;
        config.groupOwnerIntent = 0; // prefer being STA (peer is GO)

        manager.connect(channel, config, new ActionListener() {
            @Override public void onSuccess() {
                log("P2P connect initiated → " + deviceAddress);
            }
            @Override public void onFailure(int r) {
                log("P2P connect failed → " + deviceAddress + " reason=" + r);
                connectingPeers.remove(deviceAddress);
            }
        });
    }

    private void requestConnectionInfo() {
        manager.requestConnectionInfo(channel, info -> {
            if (info != null && info.groupFormed) {
                String  ownerIp = info.groupOwnerAddress.getHostAddress();
                boolean isOwner = info.isGroupOwner;
                log("P2P group formed — ownerIp=" + ownerIp + " isOwner=" + isOwner);
                listener.onConnected(ownerIp, isOwner);

                if (!isOwner) {
                    // We joined as STA — TCP connect to Group Owner
                    connectTcpTo(ownerIp, "go_" + ownerIp);
                }
                // If we ARE the owner — STA will TCP connect to our server
            }
        });
    }

    // ── TCP Server (always on — accepts incoming STA connections) ─────────────

    private void startTcpServer() {
        executor.submit(() -> {
            try {
                serverSocket = new ServerSocket(MESH_PORT);
                log("TCP server on :" + MESH_PORT);
                while (running) {
                    try {
                        Socket client = serverSocket.accept();
                        String ip = client.getInetAddress().getHostAddress();
                        log("incoming TCP from " + ip);
                        handleIncomingSocket(client, "cli_" + ip);
                    } catch (IOException e) {
                        if (running) log("accept error: " + e.getMessage());
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
                log("peer connected (in): " + peerId + " total=" + connections.size());

                BufferedReader reader = new BufferedReader(
                    new InputStreamReader(socket.getInputStream()));
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

    // ── TCP Client (STA — connect to peer's GO) ───────────────────────────────

    private void connectTcpTo(String ip, String peerId) {
        if (connections.containsKey(peerId)) return;
        executor.submit(() -> {
            int retries = 0;
            while (running && retries < 8) {
                try {
                    log("TCP → " + ip + ":" + MESH_PORT + " (try " + (retries+1) + ")");
                    Socket socket = new Socket();
                    socket.connect(new InetSocketAddress(ip, MESH_PORT), 5000);

                    PrintWriter    writer = new PrintWriter(socket.getOutputStream(), true);
                    PeerConnection conn   = new PeerConnection(socket, writer, peerId);
                    synchronized (connections) { connections.put(peerId, conn); }
                    listener.onPeerFound(peerId, ip);
                    log("TCP connected ✓ " + ip + " total=" + connections.size());

                    // Continue discovery — find more peers
                    new android.os.Handler(Looper.getMainLooper())
                        .postDelayed(() -> discoverPeers(), 2000);

                    BufferedReader reader = new BufferedReader(
                        new InputStreamReader(socket.getInputStream()));
                    String line;
                    while (running && (line = reader.readLine()) != null) {
                        if (!line.isEmpty()) listener.onPacketReceived(line, peerId);
                    }
                    break;
                } catch (IOException e) {
                    retries++;
                    log("TCP failed (" + retries + "): " + e.getMessage());
                    try { Thread.sleep(2000); } catch (InterruptedException ignored) {}
                }
            }
            connectingPeers.remove(peerId);
            if (retries >= 8) log("gave up TCP to " + ip);
        });
    }

    // ── BroadcastReceiver ─────────────────────────────────────────────────────

    private final BroadcastReceiver receiver = new BroadcastReceiver() {
        @Override
        public void onReceive(Context ctx, Intent intent) {
            String action = intent.getAction();
            if (action == null) return;
            switch (action) {
                case WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION:
                    requestPeerList();
                    break;
                case WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION:
                    NetworkInfo net = intent.getParcelableExtra(WifiP2pManager.EXTRA_NETWORK_INFO);
                    if (net != null && net.isConnected()) {
                        requestConnectionInfo();
                    } else {
                        listener.onDisconnected();
                        log("P2P disconnected — restarting discovery");
                        if (running) {
                            new android.os.Handler(Looper.getMainLooper())
                                .postDelayed(() -> discoverPeers(), 3000);
                        }
                    }
                    break;
                case WifiP2pManager.WIFI_P2P_DISCOVERY_CHANGED_ACTION:
                    int state = intent.getIntExtra(WifiP2pManager.EXTRA_DISCOVERY_STATE, -1);
                    if (state == WifiP2pManager.WIFI_P2P_DISCOVERY_STOPPED && running) {
                        new android.os.Handler(Looper.getMainLooper())
                            .postDelayed(() -> discoverPeers(), 3000);
                    }
                    break;
            }
        }
    };

    private void registerReceiver() {
        IntentFilter f = new IntentFilter();
        f.addAction(WifiP2pManager.WIFI_P2P_PEERS_CHANGED_ACTION);
        f.addAction(WifiP2pManager.WIFI_P2P_CONNECTION_CHANGED_ACTION);
        f.addAction(WifiP2pManager.WIFI_P2P_DISCOVERY_CHANGED_ACTION);
        context.registerReceiver(receiver, f);
    }

    // ── Helpers ───────────────────────────────────────────────────────────────

    private void removePeer(String id) {
        PeerConnection conn = connections.remove(id);
        if (conn != null) {
            try { conn.socket.close(); } catch (IOException ignored) {}
            listener.onPeerLost(id);
            log("peer left: " + id + " total=" + connections.size());
        }
    }

    private void closeAllConnections() {
        synchronized (connections) {
            for (PeerConnection c : connections.values()) {
                try { c.socket.close(); } catch (IOException ignored) {}
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

