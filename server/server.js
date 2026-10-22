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
const MAX_CONTACTS_PER_HOUR = 5;
const HOUR = 60 * 60 * 1000;

const httpServer = http.createServer((req, res) => {
  // Health check for the hosting platform and uptime monitors
  if (req.url === "/health" || req.url === "/") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end("OK");
  }
  if (req.url === "/contact") return handleContact(req, res);
  res.writeHead(404);
  res.end();
});
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
const ollamaBot = new OllamaBot();
// Visitor IP -> timestamps of their questions / contact messages in the last hour
const questionTimes = new Map();
const contactTimes = new Map();

function send(ws, obj) {
  if (ws.readyState === OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

// Behind the hosting platform's proxy the visitor's IP is in X-Forwarded-For
function clientIp(req) {
  return req.headers["x-forwarded-for"]?.split(",")[0].trim() || req.socket.remoteAddress;
}

function overLimit(log, ip, max) {
  const now = Date.now();
  const times = (log.get(ip) || []).filter(t => now - t < HOUR);
  if (times.length >= max) return true;
  times.push(now);
  log.set(ip, times);
  return false;
}

// Forget visitors who haven't sent anything for an hour
setInterval(() => {
  const now = Date.now();
  for (const log of [questionTimes, contactTimes]) {
    for (const [ip, times] of log) {
      if (now - times[times.length - 1] >= HOUR) log.delete(ip);
    }
  }
}, 10 * 60 * 1000).unref();

function originAllowed(origin) {
  return !ALLOWED_ORIGINS.length || ALLOWED_ORIGINS.includes(origin);
}

// Contact form: the server forwards the message to Discord, so the webhook address
// stays secret instead of sitting in the website's JavaScript
function handleContact(req, res) {
  const origin = req.headers.origin;
  const allowed = originAllowed(origin);
  if (allowed && origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Methods", "POST");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }
  if (req.method === "OPTIONS") {
    res.writeHead(allowed ? 204 : 403);
    return res.end();
  }
  if (req.method !== "POST" || !allowed || !process.env.DISCORD_WEBHOOK_URL) {
    res.writeHead(403);
    return res.end();
  }
  if (overLimit(contactTimes, clientIp(req), MAX_CONTACTS_PER_HOUR)) {
    res.writeHead(429);
    return res.end();
  }

  let body = "";
  req.on("data", chunk => {
    body += chunk;
    if (body.length > 10000) req.destroy();
  });
  req.on("end", async () => {
    let msg;
    try {
      msg = JSON.parse(body);
    } catch {
      res.writeHead(400);
      return res.end();
    }
    const field = (value, max) => (typeof value === "string" ? value.trim().slice(0, max) : "");
    const name = field(msg.name, 40);
    const email = field(msg.email, 100);
    const message = field(msg.message, 1900); // Discord allows 2,000 characters

    if (!name || !email || !message) {
      res.writeHead(400);
      return res.end();
    }

    try {
      const discord = await fetch(process.env.DISCORD_WEBHOOK_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username: `${name} | ${email}`.slice(0, 80),
          content: message,
          allowed_mentions: { parse: [] } // no @everyone pings from visitors
        })
      });
      console.log(`[Contact] Message from ${email} forwarded: ${discord.status}`);
      res.writeHead(discord.ok ? 204 : 502);
    } catch (e) {
      console.error("[Contact] Error:", e.message);
      res.writeHead(502);
    }
    res.end();
  });
}

httpServer.on("upgrade", (req, sock, head) => {
  if (req.url !== WS_PATH) {
    return sock.end("HTTP/1.1 404 Not Found\r\n\r\n");
  }
  if (!originAllowed(req.headers.origin)) {
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

    if (overLimit(questionTimes, ip, MAX_QUESTIONS_PER_HOUR)) {
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
