/**
 * Simple AI Chat Server
 * Receives messages from client and streams responses from the language model
 */

const fs = require("fs");
const path = require("path");
const http = require("http");
const { WebSocketServer, OPEN } = require("ws");

// Local settings (API key etc.) from server/.env; on the hosting platform they are set there
const ENV_PATH = path.join(__dirname, ".env");
if (fs.existsSync(ENV_PATH)) process.loadEnvFile(ENV_PATH);

const OllamaBot = require("./bot/OllamaBot");

const PORT = process.env.PORT || 8080;
const WS_PATH = "/ws";
// Only these websites may use the chat (comma-separated); empty allows all, e.g. locally
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(o => o.trim().replace(/\/$/, ""))
  .filter(Boolean);
// Protects the API quota from a single visitor (or script) sending endless questions
const MAX_QUESTIONS_PER_HOUR = Number(process.env.MAX_QUESTIONS_PER_HOUR) || 30;
const HOUR = 60 * 60 * 1000;

// Health check for the hosting platform and uptime monitors
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OK");
  }
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const ollamaBot = new OllamaBot();
const questionTimes = new Map(); // visitor IP -> timestamps of their questions in the last hour

function send(ws, obj) {
  if (ws.readyState === OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Behind the hosting platform's proxy the visitor's IP is in X-Forwarded-For
function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
}

function overLimit(ip) {
  const now = Date.now();
  const times = (questionTimes.get(ip) || []).filter(t => now - t < HOUR);
  if (times.length >= MAX_QUESTIONS_PER_HOUR) return true;
  times.push(now);
  questionTimes.set(ip, times);
  return false;
}

// Forget visitors who haven't asked anything for an hour
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of questionTimes) {
    if (now - times[times.length - 1] >= HOUR) questionTimes.delete(ip);
  }
}, 10 * 60 * 1000).unref();

httpServer.on("upgrade", (req, sock, head) => {
  if (req.url !== WS_PATH) {
    return sock.end("HTTP/1.1 404 Not Found\r\n\r\n");
  }
  if (ALLOWED_ORIGINS.length && !ALLOWED_ORIGINS.includes(req.headers.origin)) {
    console.warn(`[WS] Rejected connection from origin ${req.headers.origin}`);
    return sock.end("HTTP/1.1 403 Forbidden\r\n\r\n");
  }
  wss.handleUpgrade(req, sock, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  const ip = clientIp(req);
  console.log(`[WS] Client connected from ${ip}`);

  ws.on("message", async (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    const messageText = msg?.data?.message || "";
    const history = msg?.data?.history || [];
    if (typeof messageText !== "string" || !messageText.trim()) return;

    console.log(`[Chat] User: ${messageText}`);

    // Generate stream ID
    const streamId = `stream-${Date.now()}`;

    if (overLimit(ip)) {
      console.warn(`[Chat] Question limit reached for ${ip}`);
      send(ws, {
        type: "StreamMessage",
        data: { streamId, chunk: ollamaBot.limitReply(messageText), isDone: true }
      });
      return;
    }

    // Stream response from the model with history
    ollamaBot.processStreaming(messageText, history, (chunk, isDone) => {
      send(ws, {
        type: "StreamMessage",
        data: { streamId, chunk, isDone }
      });
    });
  });

  ws.on("close", () => {
    console.log("[WS] Client disconnected");
  });

  ws.on("error", (e) => {
    console.error("[WS] Error:", e.message);
  });
});

httpServer.listen(PORT, () => {
  console.log(`[Server] AI Chat running on ws://localhost:${PORT}${WS_PATH}`);
  console.log(`[Server] Model: ${ollamaBot.describeModel()}`);
  if (ALLOWED_ORIGINS.length) console.log(`[Server] Allowed websites: ${ALLOWED_ORIGINS.join(", ")}`);
});
