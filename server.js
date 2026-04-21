const express = require("express");
const http = require("http");
const { WebSocketServer } = require("ws");

const app = express();
const server = http.createServer(app);

const PORT = process.env.PORT || 10000;
const MAX_PACKETS = 500;

const packets = [];
const browserClients = new Set();

function nowIso() {
  return new Date().toISOString();
}

function safeJsonParse(str) {
  try {
    return JSON.parse(str);
  } catch {
    return null;
  }
}

function addPacket(packet) {
  packets.unshift(packet);
  if (packets.length > MAX_PACKETS) packets.length = MAX_PACKETS;
}

function broadcastToBrowsers(messageObj) {
  const msg = JSON.stringify(messageObj);
  for (const ws of browserClients) {
    if (ws.readyState === ws.OPEN) {
      ws.send(msg);
    }
  }
}

function summarizePacket(data, req) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0]?.trim() ||
    req.socket.remoteAddress ||
    "unknown";

  return {
    receivedAt: nowIso(),
    ip,
    deviceId: data?.deviceId || "unknown",
    homeLabel: data?.homeLabel || "-",
    fw: data?.fw || "-",
    type: data?.type || "unknown",
    event: data?.event || "-",
    flow: data?.flow || "-",
    severity: data?.severity || "-",
    metrics: {
      voltage: data?.metrics?.voltage ?? null,
      amps: data?.metrics?.amps ?? null,
      watts: data?.metrics?.watts ?? null,
      peakWatts: data?.metrics?.peakWatts ?? null,
      chipTempC: data?.metrics?.chipTempC ?? null,
      rssi: data?.metrics?.rssi ?? null
    },
    state: {
      running: data?.state?.running ?? null,
      alert: data?.state?.alert ?? "-",
      health: data?.state?.health ?? null
    },
    runtime: {
      durationMs: data?.runtime?.durationMs ?? null
    },
    stats: {
      sampleCount: data?.stats?.sampleCount ?? null
    },
    raw: data
  };
}

const wss = new WebSocketServer({ noServer: true });

// Cloud websocket is ROOT "/"
server.on("upgrade", (req, socket, head) => {
  if (req.url !== "/") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

wss.on("connection", (ws, req) => {
  const ua = (req.headers["user-agent"] || "").toLowerCase();
  const isBrowser = ua.includes("mozilla");

  if (isBrowser) {
    browserClients.add(ws);
  }

  ws.send(
    JSON.stringify({
      type: "hello",
      role: isBrowser ? "browser" : "device",
      serverTime: nowIso(),
      recentPackets: isBrowser ? packets.slice(0, 100) : undefined
    })
  );

  ws.on("message", (message) => {
    const text = message.toString();
    const parsed = safeJsonParse(text);

    if (!parsed) {
      ws.send(
        JSON.stringify({
          type: "ack",
          ok: false,
          reason: "invalid_json",
          serverTime: nowIso()
        })
      );
      return;
    }

    const packet = summarizePacket(parsed, req);
    addPacket(packet);

    console.log("[PACKET]", JSON.stringify(packet));

    broadcastToBrowsers({
      type: "packet",
      packet
    });

    ws.send(
      JSON.stringify({
        type: "ack",
        ok: true,
        serverTime: nowIso(),
        deviceId: packet.deviceId,
        packetType: packet.type
      })
    );
  });

  ws.on("close", () => {
    browserClients.delete(ws);
  });

  ws.on("error", (err) => {
    console.error("[WS ERROR]", err.message);
    browserClients.delete(ws);
  });

  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });
});

setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

app.get("/healthz", (req, res) => {
  res.json({
    ok: true,
    serverTime: nowIso(),
    packetCount: packets.length,
    wsClients: wss.clients.size,
    browserClients: browserClients.size
  });
});

app.get("/packets", (req, res) => {
  res.json({
    ok: true,
    count: packets.length,
    packets
  });
});

app.get("/", (req, res) => {
  res.type("html").send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>NOHM Predict Live Monitor</title>
  <style>
    :root{
      --bg:#07111d;
      --card:rgba(255,255,255,.05);
      --line:rgba(255,255,255,.10);
      --text:#e7eef7;
      --muted:#8ea1b7;
      --brand:#00bfa5;
      --brand2:#11e3c2;
    }
    *{box-sizing:border-box}
    body{
      margin:0;
      font-family:Arial,Helvetica,sans-serif;
      background:
        radial-gradient(circle at top, rgba(0,191,165,.16), transparent 30%),
        linear-gradient(180deg,#08111c 0%, #03070d 100%);
      color:var(--text);
      min-height:100vh;
    }
    .wrap{
      max-width:1400px;
      margin:0 auto;
      padding:24px;
    }
    .hero{
      display:flex;
      justify-content:space-between;
      gap:20px;
      align-items:flex-start;
      margin-bottom:20px;
      flex-wrap:wrap;
    }
    .title{
      font-size:38px;
      font-weight:800;
      margin:0 0 8px;
      letter-spacing:-.03em;
    }
    .subtitle{
      color:var(--muted);
      max-width:760px;
      line-height:1.5;
    }
    .grid{
      display:grid;
      grid-template-columns:repeat(4,minmax(0,1fr));
      gap:16px;
      margin:20px 0 24px;
    }
    .card{
      background:var(--card);
      border:1px solid var(--line);
      border-radius:22px;
      padding:18px;
      backdrop-filter:blur(16px);
      box-shadow:0 10px 30px rgba(0,0,0,.20);
    }
    .eyebrow{
      color:var(--muted);
      font-size:12px;
      text-transform:uppercase;
      letter-spacing:.14em;
      margin-bottom:10px;
      font-weight:700;
    }
    .value{
      font-size:28px;
      font-weight:800;
    }
    .good{color:var(--brand2)}
    .tableWrap{
      background:var(--card);
      border:1px solid var(--line);
      border-radius:22px;
      overflow:hidden;
    }
    table{
      width:100%;
      border-collapse:collapse;
    }
    thead{
      background:rgba(255,255,255,0.03);
    }
    th,td{
      text-align:left;
      padding:14px 12px;
      border-bottom:1px solid rgba(255,255,255,0.06);
      font-size:14px;
      vertical-align:top;
    }
    th{
      color:#b6c4d5;
      text-transform:uppercase;
      letter-spacing:.1em;
      font-size:11px;
    }
    .payload{
      max-width:520px;
      white-space:pre-wrap;
      word-break:break-word;
      font-family:ui-monospace,SFMono-Regular,Menlo,monospace;
      font-size:12px;
      line-height:1.45;
      color:#cfe2ff;
    }
    .pill{
      display:inline-block;
      padding:6px 10px;
      border-radius:999px;
      background:rgba(255,255,255,.06);
      border:1px solid rgba(255,255,255,.08);
      font-size:12px;
      font-weight:700;
    }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="hero">
      <div>
        <h1 class="title">NOHM Predict Live Monitor</h1>
        <div class="subtitle">Dashboard and websocket test server. Devices connect to the root websocket on this same host.</div>
      </div>
      <div>
        <span class="pill" id="wsState">Connecting...</span>
      </div>
    </div>

    <div class="grid">
      <div class="card">
        <div class="eyebrow">Server Status</div>
        <div class="value good">Online</div>
      </div>
      <div class="card">
        <div class="eyebrow">Browser Stream</div>
        <div class="value" id="browserState">Connecting</div>
      </div>
      <div class="card">
        <div class="eyebrow">Packets Seen</div>
        <div class="value" id="packetCount">0</div>
      </div>
      <div class="card">
        <div class="eyebrow">Latest Device</div>
        <div class="value" id="latestDevice">--</div>
      </div>
    </div>

    <div class="tableWrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Device</th>
            <th>Home</th>
            <th>Type</th>
            <th>Flow/Event</th>
            <th>Watts</th>
            <th>Alert</th>
            <th>Health</th>
            <th>Payload</th>
          </tr>
        </thead>
        <tbody id="tbody"></tbody>
      </table>
    </div>
  </div>

<script>
  const wsProtocol = location.protocol === "https:" ? "wss:" : "ws:";
  const wsUrl = wsProtocol + "//" + location.host + "/";

  const wsState = document.getElementById("wsState");
  const browserState = document.getElementById("browserState");
  const packetCount = document.getElementById("packetCount");
  const latestDevice = document.getElementById("latestDevice");
  const tbody = document.getElementById("tbody");

  let total = 0;
  let socket;

  function esc(str) {
    return String(str ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;");
  }

  function renderRow(packet) {
    const tr = document.createElement("tr");
    const flowOrEvent = packet.flow && packet.flow !== "-" ? packet.flow : packet.event;
    tr.innerHTML = \`
      <td>\${esc(new Date(packet.receivedAt).toLocaleTimeString())}</td>
      <td>\${esc(packet.deviceId || "-")}</td>
      <td>\${esc(packet.homeLabel || "-")}</td>
      <td><span class="pill">\${esc(packet.type || "-")}</span></td>
      <td>\${esc(flowOrEvent || "-")}</td>
      <td>\${packet.metrics?.watts == null ? "-" : esc(Number(packet.metrics.watts).toFixed(1))}</td>
      <td>\${esc(packet.state?.alert || "-")}</td>
      <td>\${packet.state?.health == null ? "-" : esc(Number(packet.state.health).toFixed(1))}</td>
      <td><div class="payload">\${esc(JSON.stringify(packet.raw, null, 2))}</div></td>
    \`;
    tbody.prepend(tr);
  }

  function connect() {
    socket = new WebSocket(wsUrl);

    socket.onopen = () => {
      wsState.textContent = "WebSocket Connected";
      browserState.textContent = "Live";
    };

    socket.onclose = () => {
      wsState.textContent = "Disconnected";
      browserState.textContent = "Reconnecting";
      setTimeout(connect, 1500);
    };

    socket.onerror = () => {
      wsState.textContent = "Error";
      browserState.textContent = "Error";
    };

    socket.onmessage = (event) => {
      const msg = JSON.parse(event.data);

      if (msg.type === "hello" && Array.isArray(msg.recentPackets)) {
        tbody.innerHTML = "";
        const rows = msg.recentPackets.slice().reverse();
        rows.forEach(renderRow);
        total = msg.recentPackets.length;
        packetCount.textContent = total;
        if (msg.recentPackets[0]?.deviceId) latestDevice.textContent = msg.recentPackets[0].deviceId;
        return;
      }

      if (msg.type === "packet" && msg.packet) {
        total += 1;
        packetCount.textContent = total;
        latestDevice.textContent = msg.packet.deviceId || "--";
        renderRow(msg.packet);
      }
    };
  }

  connect();
</script>
</body>
</html>`);
});

server.listen(PORT, () => {
  console.log(\`NOHM Predict server listening on port \${PORT}\`);
});
