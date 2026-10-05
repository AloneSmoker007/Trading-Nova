// Minimal RFC6455 WebSocket server fixture for controlled fault injection.
// TEST FIXTURE ONLY - not a market-data source, must never be cited as feed evidence.
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

function encodeFrame(payload) {
  const body = Buffer.from(payload, "utf8");
  const len = body.length;
  let header;
  if (len < 126) {
    header = Buffer.from([0x81, len]);
  } else if (len < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x81; header[1] = 126; header.writeUInt16BE(len, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x81; header[1] = 127; header.writeBigUInt64BE(BigInt(len), 2);
  }
  return Buffer.concat([header, body]);
}

export async function startWsFixture() {
  const clients = new Set();
  const server = createServer();
  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    const accept = createHash("sha1").update(String(key) + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n\r\n`
    );
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("error", () => clients.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `ws://127.0.0.1:${port}/ws/test`,
    get clientCount() { return clients.size; },
    send(text) { for (const c of clients) c.write(encodeFrame(text)); },
    drop() { for (const c of clients) c.destroy(); },
    async stop() { for (const c of clients) c.destroy(); await new Promise((r) => server.close(r)); }
  };
}
