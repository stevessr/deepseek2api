import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

import {
  acceptWebSocketUpgrade,
  computeWebSocketAccept,
  createFrameParser,
  encodeFrame
} from "../src/utils/websocket.js";
import { handleOpenAiUpgrade } from "../src/routes/openai-ws-routes.js";

function collectParserEvents() {
  const events = { messages: [], pings: [], pongs: 0, closes: [], errors: [] };
  const parser = createFrameParser({
    onMessage: (text) => events.messages.push(text),
    onPing: (payload) => events.pings.push(payload),
    onPong: () => {
      events.pongs += 1;
    },
    onClose: (code) => events.closes.push(code),
    onError: (error) => events.errors.push(error)
  });
  return { parser, events };
}

function createFakeSocket() {
  return {
    writes: [],
    destroyed: false,
    writableEnded: false,
    write(chunk) {
      this.writes.push(String(chunk));
      return true;
    },
    destroy() {
      this.destroyed = true;
    },
    end() {
      this.writableEnded = true;
    },
    on() {},
    setNoDelay() {}
  };
}

test("computeWebSocketAccept matches the RFC 6455 example vector", () => {
  assert.equal(
    computeWebSocketAccept("dGhlIHNhbXBsZSBub25jZQ=="),
    "s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
  );
});

test("frame parser decodes small masked text frames", () => {
  const { parser, events } = collectParserEvents();
  parser.push(encodeFrame(0x1, "hello", { mask: true }));
  assert.deepEqual(events.messages, ["hello"]);
  assert.equal(events.errors.length, 0);
});

test("frame parser supports 16-bit and 64-bit extended lengths", () => {
  const { parser, events } = collectParserEvents();

  const medium = "x".repeat(300);
  const large = "y".repeat(70_000);
  parser.push(encodeFrame(0x1, medium, { mask: true }));
  parser.push(encodeFrame(0x1, large, { mask: true }));

  assert.deepEqual(events.messages, [medium, large]);
});

test("frame parser reassembles fragmented messages", () => {
  const { parser, events } = collectParserEvents();

  parser.push(encodeFrame(0x1, "frag1-", { fin: false, mask: true }));
  parser.push(encodeFrame(0x0, "frag2", { fin: false, mask: true }));
  parser.push(encodeFrame(0x0, "-frag3", { fin: true, mask: true }));

  assert.deepEqual(events.messages, ["frag1-frag2-frag3"]);
});

test("control frames may interleave fragmented messages", () => {
  const { parser, events } = collectParserEvents();

  parser.push(encodeFrame(0x1, "part-", { fin: false, mask: true }));
  parser.push(encodeFrame(0x9, "ping-body", { mask: true }));
  parser.push(encodeFrame(0x0, "rest", { fin: true, mask: true }));

  assert.deepEqual(events.pings, [Buffer.from("ping-body")]);
  assert.deepEqual(events.messages, ["part-rest"]);
});

test("unmasked client frames fail with a protocol error", () => {
  const { parser, events } = collectParserEvents();

  // Server-style unmasked frames never appear on the wire from a client.
  parser.push(encodeFrame(0x1, "no-mask"));

  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].code, 1002);
});

test("binary data frames are rejected", () => {
  const { parser, events } = collectParserEvents();

  parser.push(encodeFrame(0x2, Buffer.from([1, 2, 3]), { mask: true }));

  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].code, 1007);
});

test("invalid UTF-8 text payloads surface a parser error", () => {
  const { parser, events } = collectParserEvents();

  // A lone continuation byte is never valid UTF-8.
  parser.push(encodeFrame(0x1, Buffer.from([0x80]), { mask: true }));

  assert.equal(events.errors.length, 1);
  assert.deepEqual(events.messages, []);
});

test("oversize declared lengths fail fast as too-big", () => {
  const { parser, events } = collectParserEvents();

  const header = Buffer.alloc(10);
  header[0] = 0x81; // FIN + text opcode
  header[1] = 0xff; // masked bit + 127 -> 64-bit length follows
  header.writeBigUInt64BE(BigInt(1024 * 1024 * 1024), 2);
  parser.push(header);

  assert.equal(events.errors.length, 1);
  assert.equal(events.errors[0].code, 1009);
});

test("close frames report the peer close code", () => {
  const { parser, events } = collectParserEvents();

  const body = Buffer.alloc(2);
  body.writeUInt16BE(1001, 0);
  parser.push(encodeFrame(0x8, body, { mask: true }));

  assert.deepEqual(events.closes, [1001]);
});

test("parser accepts frames delivered one byte at a time", () => {
  const { parser, events } = collectParserEvents();
  const frame = encodeFrame(0x1, "chunked delivery", { mask: true });

  for (const byte of frame) {
    parser.push(Buffer.from([byte]));
  }

  assert.deepEqual(events.messages, ["chunked delivery"]);
});

test("acceptWebSocketUpgrade interoperates with a real WebSocket client", async () => {
  const server = createServer(() => {});
  server.on("upgrade", (request, socket, head) => {
    const connection = acceptWebSocketUpgrade(request, socket, head);
    connection.handleMessage = (text) => connection.send(`echo:${text}`);
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;

  try {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise((resolve, reject) => {
      ws.onopen = resolve;
      ws.onerror = () => reject(new Error("handshake failed"));
    });

    ws.send("hi");
    const first = new Promise((resolve) => {
      ws.onmessage = (event) => resolve(String(event.data));
    });
    assert.equal(await first, "echo:hi");

    // Exercise 64-bit length framing in both directions.
    const largePayload = "z".repeat(70_000);
    const second = new Promise((resolve) => {
      ws.onmessage = (event) => resolve(String(event.data));
    });
    ws.send(largePayload);
    assert.equal(await second, `echo:${largePayload}`);

    ws.close();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("upgrade route rejects non-WebSocket paths", () => {
  const handled = handleOpenAiUpgrade({ url: "/v1/models", headers: {} }, createFakeSocket(), undefined);
  assert.equal(handled, false);
});

test("upgrade route rejects missing API keys before the handshake", () => {
  const socket = createFakeSocket();
  const handled = handleOpenAiUpgrade(
    { url: "/v1/responses/ws", headers: { "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==" } },
    socket,
    undefined
  );

  assert.equal(handled, true);
  assert.match(socket.writes[0], /^HTTP\/1\.1 401/);
  assert.equal(socket.destroyed, true);
});

test("upgrade route validates keys against the store and completes the handshake", () => {
  const directory = mkdtempSync(join(tmpdir(), "deepseek2api-ws-upgrade-"));
  const script = [
    `const routes = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "src", "routes", "openai-ws-routes.js")).href)});`,
    `const apiKeys = await import(${JSON.stringify(pathToFileURL(join(process.cwd(), "src", "services", "api-key-service.js")).href)});`,
    `apiKeys.createApiKeyRecord({ ownerId: "admin", label: "ws", plainKey: "dsr_ws_upgrade" });`,
    `const socket = { writes: [], destroyed: false, writableEnded: false, write(c) { this.writes.push(String(c)); return true; }, destroy() { this.destroyed = true; }, end() { this.writableEnded = true; }, on() {}, setNoDelay() {} };`,
    `const handled = await routes.handleOpenAiUpgrade(`,
    `  { url: "/v1/responses/ws", headers: { authorization: "Bearer dsr_ws_upgrade", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==", upgrade: "websocket" } },`,
    `  socket,`,
    `  undefined`,
    `);`,
    `console.log(JSON.stringify({ handled, firstWrite: socket.writes[0] ?? "" }));`
  ].join("\n");

  const result = spawnSync(process.execPath, ["--input-type=module", "--eval", script], {
    cwd: directory,
    encoding: "utf8",
    env: { ...process.env }
  });

  try {
    assert.equal(result.status, 0, result.stderr);
    const { handled, firstWrite } = JSON.parse(result.stdout.trim());
    assert.equal(handled, true);
    assert.match(firstWrite, /^HTTP\/1\.1 101 Switching Protocols/);
    assert.match(firstWrite, /Sec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK\+xOo=/);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
