// Minimal WebSocket server (RFC 6455) for one local peer: text messages,
// ping/pong and close. No dependencies, so the plugin runs without npm install.
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
const MAX_MESSAGE = 64 * 1024 * 1024;

export function acceptKey(key) {
  return createHash('sha1').update(key + GUID).digest('base64');
}

export class Socket extends EventEmitter {
  constructor(socket) {
    super();
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.fragments = [];
    this.closed = false;
    socket.setNoDelay(true);
    socket.on('data', (chunk) => this.receive(chunk));
    socket.on('close', () => this.finish());
    socket.on('error', () => this.finish());
  }

  receive(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    for (;;) {
      if (this.buffer.length < 2) return;
      const fin = (this.buffer[0] & 0x80) !== 0;
      const opcode = this.buffer[0] & 0x0f;
      const masked = (this.buffer[1] & 0x80) !== 0;
      let length = this.buffer[1] & 0x7f;
      let offset = 2;
      if (length === 126) {
        if (this.buffer.length < 4) return;
        length = this.buffer.readUInt16BE(2);
        offset = 4;
      } else if (length === 127) {
        if (this.buffer.length < 10) return;
        const big = this.buffer.readBigUInt64BE(2);
        if (big > BigInt(MAX_MESSAGE)) return this.close(1009, 'Message too big');
        length = Number(big);
        offset = 10;
      }
      // Clients must mask their frames.
      if (!masked) return this.close(1002, 'Unmasked frame');
      if (this.buffer.length < offset + 4 + length) return;
      const mask = this.buffer.subarray(offset, offset + 4);
      const payload = Buffer.from(this.buffer.subarray(offset + 4, offset + 4 + length));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      this.buffer = this.buffer.subarray(offset + 4 + length);
      this.frame(fin, opcode, payload);
      if (this.closed) return;
    }
  }

  frame(fin, opcode, payload) {
    if (opcode === 0x8) return this.close(1000);
    if (opcode === 0x9) return this.write(0xa, payload);
    if (opcode === 0xa) return undefined;
    if (opcode === 0x1 || opcode === 0x2 || opcode === 0x0) {
      this.fragments.push(payload);
      const size = this.fragments.reduce((sum, part) => sum + part.length, 0);
      if (size > MAX_MESSAGE) return this.close(1009, 'Message too big');
      if (!fin) return undefined;
      const message = Buffer.concat(this.fragments).toString('utf8');
      this.fragments = [];
      return this.emit('message', message);
    }
    return this.close(1002, 'Unknown opcode');
  }

  write(opcode, payload) {
    if (this.closed) return;
    const length = payload.length;
    let header;
    if (length < 126) {
      header = Buffer.from([0x80 | opcode, length]);
    } else if (length < 65536) {
      header = Buffer.alloc(4);
      header[0] = 0x80 | opcode;
      header[1] = 126;
      header.writeUInt16BE(length, 2);
    } else {
      header = Buffer.alloc(10);
      header[0] = 0x80 | opcode;
      header[1] = 127;
      header.writeBigUInt64BE(BigInt(length), 2);
    }
    this.socket.write(Buffer.concat([header, payload]));
  }

  send(text) {
    this.write(0x1, Buffer.from(text, 'utf8'));
  }

  ping() {
    this.write(0x9, Buffer.alloc(0));
  }

  close(code = 1000, reason = '') {
    if (this.closed) return;
    const body = Buffer.alloc(2 + Buffer.byteLength(reason));
    body.writeUInt16BE(code, 0);
    body.write(reason, 2);
    this.write(0x8, body);
    this.socket.end();
    this.finish();
  }

  finish() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroy();
    this.emit('close');
  }
}

/** Completes the upgrade handshake; returns a Socket, or null after rejecting. */
export function upgrade(request, socket, allow) {
  const key = request.headers['sec-websocket-key'];
  const reject = (status, text) => {
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return null;
  };
  if (request.headers.upgrade?.toLowerCase() !== 'websocket' || !key) return reject(400, 'Bad Request');
  if (!allow(request)) return reject(403, 'Forbidden');
  socket.write([
    'HTTP/1.1 101 Switching Protocols',
    'Upgrade: websocket',
    'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`,
    '', '',
  ].join('\r\n'));
  return new Socket(socket);
}
