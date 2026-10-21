/**
 * Simple AI Chat Server
 * Receives messages from client and streams responses from Ollama
 */

const http = require("http");
const { WebSocketServer, OPEN } = require("ws");
const OllamaBot = require("./bot/OllamaBot");

const PORT = 8080;
const WS_PATH = "/ws";

const httpServer = http.createServer();
const wss = new WebSocketServer({ noServer: true });
const ollamaBot = new OllamaBot();

function send(ws, obj) {
  if (ws.readyState === OPEN) {
    ws.send(JSON.stringify(obj));
  }
}

httpServer.on("upgrade", (req, sock, head) => {
  if (req.url !== WS_PATH) {
    return sock.end("HTTP/1.1 404 Not Found\r\n\r\n");
  }
  wss.handleUpgrade(req, sock, head, ws => wss.emit("connection", ws, req));
});

wss.on("connection", (ws, req) => {
  console.log(`[WS] Client connected from ${req.socket.remoteAddress}`);

  ws.on("message", async (buf) => {
    let msg;
    try {
      msg = JSON.parse(buf.toString());
    } catch {
      return;
    }

    const messageText = msg?.data?.message || "";
    const history = msg?.data?.history || [];
    if (!messageText.trim()) return;

    console.log(`[Chat] User: ${messageText}`);

    // Generate stream ID
    const streamId = `stream-${Date.now()}`;

    // Stream response from Ollama with history
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
});
