// Minimal RFC 6455 WebSocket server support (zero runtime dependencies).
//
// Implements exactly what this project needs: the opening handshake plus a
// frame parser/serializer for text messages, fragmentation, ping/pong and
// close. Client frames must be masked per spec; server frames are unmasked.
// Binary data frames are rejected with a protocol error (1003) because every
// payload in this service is JSON text.

import { createHash } from "node:crypto";

const WEBSOCKET_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

const OP_CONTINUATION = 0x0;
const OP_TEXT = 0x1;
const OP_BINARY = 0x2;
const OP_CLOSE = 0x8;
const OP_PING = 0x9;
const OP_PONG = 0xa;

const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL_ERROR = 1002;
const CLOSE_INVALID_PAYLOAD = 1007;
const CLOSE_TOO_BIG = 1009;

export function computeWebSocketAccept(clientKey) {
  return createHash("sha1").update(`${clientKey}${WEBSOCKET_GUID}`).digest("base64");
}

/**
 * Serialize one WebSocket frame.
 * @param {number} opcode frame opcode
 * @param {Buffer|Uint8Array|string} payload frame body
 * @param {{ mask?: boolean, fin?: boolean }} [options]
 */
export function encodeFrame(opcode, payload, options = {}) {
  const body = typeof payload === "string" ? Buffer.from(payload, "utf8") : Buffer.from(payload);
  const fin = options.fin === false ? 0 : 1;
  const maskBit = options.mask ? 1 : 0;
  const length = body.length;

  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[0] = (fin << 7) | opcode;
    header[1] = (maskBit << 7) | length;
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = (fin << 7) | opcode;
    header[1] = (maskBit << 7) | 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = (fin << 7) | opcode;
    header[1] = (maskBit << 7) | 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  if (!options.mask) {
    return Buffer.concat([header, body]);
  }

  const maskKey = Buffer.from([
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256)
  ]);
  const masked = Buffer.from(body);
  for (let index = 0; index < masked.length; index += 1) {
    masked[index] ^= maskKey[index & 3];
  }
  return Buffer.concat([header, maskKey, masked]);
}

function applyMask(payload, maskKey, start = 0) {
  for (let index = start; index < payload.length; index += 1) {
    payload[index] ^= maskKey[(index - start) & 3];
  }
}

class ProtocolError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

/**
 * Incremental RFC 6455 frame decoder. Feed raw socket chunks; it reassembles
 * fragmented messages and invokes handlers for complete ones.
 */
export function createFrameParser({ onMessage, onPing, onPong, onClose, onError, maxMessageBytes = MAX_MESSAGE_BYTES }) {
  let buffer = Buffer.alloc(0);
  let fragments = null; // null | Buffer[]
  let fragmentOpcode = 0;
  let closed = false;

  const failWith = (error) => {
    if (closed || !onError) return;
    onError(error);
  };

  function dispatchFrame(frame) {
    const isControl = (frame.opcode & 0x8) !== 0;

    if (isControl) {
      if (!frame.fin || frame.payload.length > 125) {
        throw new ProtocolError("Invalid control frame", CLOSE_PROTOCOL_ERROR);
      }
      if (frame.opcode === OP_PING) {
        onPing?.(frame.payload);
        return;
      }
      if (frame.opcode === OP_PONG) {
        onPong?.(frame.payload);
        return;
      }
      // OP_CLOSE
      closed = true;
      onClose?.(frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : CLOSE_NORMAL);
      return;
    }

    if (frame.opcode === OP_BINARY) {
      throw new ProtocolError("Binary frames are not supported", CLOSE_INVALID_PAYLOAD);
    }

    if (frame.opcode === OP_TEXT || frame.opcode === OP_CONTINUATION) {
      const isFirst = frame.opcode !== OP_CONTINUATION;
      if (isFirst && fragments) {
        throw new ProtocolError("Nested fragmented message", CLOSE_PROTOCOL_ERROR);
      }
      if (!isFirst && !fragments) {
        throw new ProtocolError("Continuation without initial frame", CLOSE_PROTOCOL_ERROR);
      }
      fragments = fragments ?? [];
      fragments.push(frame.payload);

      const totalLength = fragments.reduce((sum, part) => sum + part.length, 0);
      if (totalLength > maxMessageBytes) {
        throw new ProtocolError("Message exceeds size limit", CLOSE_TOO_BIG);
      }

      if (frame.fin) {
        const message = Buffer.concat(fragments);
        fragments = null;
        const text = new TextDecoder("utf-8", { fatal: true }).decode(message);
        onMessage?.(text);
      }
      return;
    }

    throw new ProtocolError(`Unknown opcode ${frame.opcode}`, CLOSE_PROTOCOL_ERROR);
  }

  function readFrames() {
    while (!closed) {
      if (buffer.length < 2) return;

      const fin = (buffer[0] & 0x80) !== 0;
      const opcode = buffer[0] & 0x0f;
      const masked = (buffer[1] & 0x80) !== 0;
      let length = buffer[1] & 0x7f;
      let offset = 2;

      if (length === 126) {
        if (buffer.length < offset + 2) return;
        length = buffer.readUInt16BE(offset);
        offset += 2;
      } else if (length === 127) {
        if (buffer.length < offset + 8) return;
        const bigLength = buffer.readBigUInt64BE(offset);
        if (bigLength > BigInt(maxMessageBytes)) {
          throw new ProtocolError("Message exceeds size limit", CLOSE_TOO_BIG);
        }
        length = Number(bigLength);
        offset += 8;
      }

      if (length > maxMessageBytes) {
        throw new ProtocolError("Message exceeds size limit", CLOSE_TOO_BIG);
      }

      let maskKey = null;
      if (masked) {
        if (buffer.length < offset + 4) return;
        maskKey = buffer.subarray(offset, offset + 4);
        offset += 4;
      } else {
        // Client-to-server frames MUST be masked (RFC 6455 §5.1).
        throw new ProtocolError("Unmasked client frame", CLOSE_PROTOCOL_ERROR);
      }

      if (buffer.length < offset + length) return;

      const payload = Buffer.from(buffer.subarray(offset, offset + length));
      if (maskKey) applyMask(payload, maskKey);
      buffer = buffer.subarray(offset + length);

      dispatchFrame({ fin, opcode, payload });
    }
  }

  return {
    push(chunk) {
      try {
        buffer = buffer.length ? Buffer.concat([buffer, chunk]) : chunk;
        readFrames();
      } catch (error) {
        failWith(error);
      }
    },
    isClosed() {
      return closed;
    },
    markClosed() {
      closed = true;
    }
  };
}

/**
 * Complete the WebSocket handshake on an upgraded socket and wrap it in a
 * small connection object.
 *
 * @returns {{
 *   send(text: string): boolean,
 *   ping(payload?: string): boolean,
 *   close(code?: number, reason?: string): void,
 *   handleMessage: ((text: string) => void) | null,
 *   handleClose: (() => void) | null,
 *   handleError: ((error: Error) => void) | null
 * }}
 */
export function acceptWebSocketUpgrade(request, socket, head) {
  const key = request.headers["sec-websocket-key"];
  const upgradeHeader = request.headers.upgrade;

  if (typeof key !== "string" || !key || String(upgradeHeader).toLowerCase() !== "websocket") {
    throw new Error("Not a WebSocket handshake");
  }

  const accept = computeWebSocketAccept(key);
  socket.write(
    "HTTP/1.1 101 Switching Protocols\r\n" +
      "Upgrade: websocket\r\n" +
      "Connection: Upgrade\r\n" +
      `Sec-WebSocket-Accept: ${accept}\r\n` +
      "\r\n"
  );

  let closeSent = false;
  let closeTimer = null;

  const connection = {
    handleMessage: null,
    handleClose: null,
    handleError: null,

    send(text) {
      if (closeSent || socket.destroyed) return false;
      return socket.write(encodeFrame(OP_TEXT, text));
    },

    ping(payload = "") {
      if (closeSent || socket.destroyed) return false;
      return socket.write(encodeFrame(OP_PING, payload));
    },

    close(code = CLOSE_NORMAL, reason = "") {
      if (closeSent || socket.destroyed) return;
      closeSent = true;
      const body = Buffer.alloc(2 + Buffer.byteLength(reason, "utf8"));
      body.writeUInt16BE(code, 0);
      body.write(reason, 2, "utf8");
      socket.write(encodeFrame(OP_CLOSE, body));
      // Give the peer a moment to echo the close frame, then tear down.
      closeTimer = setTimeout(() => socket.destroy(), 1000);
      closeTimer.unref?.();
      socket.end();
    }
  };

  const failWithProtocolError = (error) => {
    connection.close(error.code ?? CLOSE_PROTOCOL_ERROR, error.message.slice(0, 100));
    connection.handleError?.(error);
  };

  const parser = createFrameParser({
    maxMessageBytes: MAX_MESSAGE_BYTES,
    onMessage: (text) => {
      if (closeSent) return;
      connection.handleMessage?.(text);
    },
    onPing: (payload) => {
      if (!socket.destroyed) socket.write(encodeFrame(OP_PONG, payload));
    },
    onPong: () => {},
    onClose: () => {
      clearTimeout(closeTimer);
      if (!socket.destroyed) socket.end();
      connection.handleClose?.();
    },
    onError: failWithProtocolError
  });

  socket.on("data", (chunk) => parser.push(chunk));
  socket.on("close", () => {
    clearTimeout(closeTimer);
    parser.markClosed();
    connection.handleClose?.();
  });
  socket.on("error", () => {
    clearTimeout(closeTimer);
    parser.markClosed();
    connection.handleClose?.();
  });
  socket.setNoDelay(true);

  if (head?.length) {
    parser.push(head);
  }

  return connection;
}
