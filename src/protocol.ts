import crypto from 'crypto';

export const PREFIX = 0x000055aa;
export const SUFFIX = 0x0000aa55;

export const CMD = {
  CONTROL: 7,
  STATUS: 8,
  HEART_BEAT: 9,
  DP_QUERY: 10,
} as const;

export const VERSION = '3.3';

const VERSION_HEADER_LENGTH = 15;
const HEADER_LENGTH = 16;
const TRAILER_LENGTH = 8;

const NO_VERSION_HEADER = new Set<number>([CMD.DP_QUERY, CMD.HEART_BEAT]);

export type Dps = Record<string, unknown>;

export interface Frame {
  seq: number;
  cmd: number;
  payload: Buffer;
}

export interface Message {
  retcode?: number;
  data?: Record<string, unknown>;
  text?: string;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function keyBuffer(localKey: string): Buffer {
  const key = Buffer.from(localKey, 'utf8');
  if (key.length !== 16) {
    throw new Error('local key must be 16 characters');
  }
  return key;
}

export function encrypt(localKey: string, plaintext: Buffer): Buffer {
  const cipher = crypto.createCipheriv('aes-128-ecb', keyBuffer(localKey), null);
  return Buffer.concat([cipher.update(plaintext), cipher.final()]);
}

export function decrypt(localKey: string, ciphertext: Buffer): Buffer {
  const decipher = crypto.createDecipheriv('aes-128-ecb', keyBuffer(localKey), null);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export function encodeFrame(seq: number, cmd: number, payload: Buffer): Buffer {
  const header = Buffer.alloc(HEADER_LENGTH);
  header.writeUInt32BE(PREFIX, 0);
  header.writeUInt32BE(seq >>> 0, 4);
  header.writeUInt32BE(cmd, 8);
  header.writeUInt32BE(payload.length + TRAILER_LENGTH, 12);
  const body = Buffer.concat([header, payload]);
  const trailer = Buffer.alloc(TRAILER_LENGTH);
  trailer.writeUInt32BE(crc32(body), 0);
  trailer.writeUInt32BE(SUFFIX, 4);
  return Buffer.concat([body, trailer]);
}

export class FrameParser {
  private buffer = Buffer.alloc(0);

  push(chunk: Buffer): Frame[] {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    const frames: Frame[] = [];
    for (;;) {
      const start = this.findPrefix();
      if (start < 0) {
        this.buffer = this.buffer.subarray(Math.max(0, this.buffer.length - 3));
        return frames;
      }
      this.buffer = this.buffer.subarray(start);
      if (this.buffer.length < HEADER_LENGTH) {
        return frames;
      }
      const length = this.buffer.readUInt32BE(12);
      if (length < TRAILER_LENGTH || length > 0x10000) {
        this.buffer = this.buffer.subarray(4);
        continue;
      }
      const total = HEADER_LENGTH + length;
      if (this.buffer.length < total) {
        return frames;
      }
      const frame = this.buffer.subarray(0, total);
      this.buffer = this.buffer.subarray(total);
      const crc = frame.readUInt32BE(total - 8);
      if (frame.readUInt32BE(total - 4) !== SUFFIX || crc !== crc32(frame.subarray(0, total - 8))) {
        continue;
      }
      frames.push({
        seq: frame.readUInt32BE(4),
        cmd: frame.readUInt32BE(8),
        payload: Buffer.from(frame.subarray(HEADER_LENGTH, total - 8)),
      });
    }
  }

  private findPrefix(): number {
    for (let i = 0; i + 4 <= this.buffer.length; i++) {
      if (this.buffer.readUInt32BE(i) === PREFIX) {
        return i;
      }
    }
    return -1;
  }
}

export function timestamp(): string {
  return String(Math.floor(Date.now() / 1000));
}

export function queryBody(id: string, t = timestamp()): Record<string, unknown> {
  return {gwId: id, devId: id, uid: id, t};
}

export function controlBody(id: string, dps: Dps, t = timestamp()): Record<string, unknown> {
  return {devId: id, uid: id, t, dps};
}

export function encodePayload(cmd: number, localKey: string, body: Record<string, unknown> | null): Buffer {
  if (body === null) {
    return Buffer.alloc(0);
  }
  const ciphertext = encrypt(localKey, Buffer.from(JSON.stringify(body), 'utf8'));
  if (NO_VERSION_HEADER.has(cmd)) {
    return ciphertext;
  }
  return Buffer.concat([Buffer.from(VERSION, 'ascii'), Buffer.alloc(VERSION_HEADER_LENGTH - VERSION.length), ciphertext]);
}

function hasVersionHeader(data: Buffer): boolean {
  return data.length >= VERSION_HEADER_LENGTH && data.subarray(0, VERSION.length).toString('ascii') === VERSION;
}

export function decodePayload(localKey: string, payload: Buffer, fromDevice = true): Message {
  const message: Message = {};
  let data = payload;
  if (fromDevice && data.length >= 4 && (data.readUInt32BE(0) & 0xffffff00) === 0) {
    message.retcode = data.readUInt32BE(0);
    data = data.subarray(4);
  }
  if (hasVersionHeader(data)) {
    data = data.subarray(VERSION_HEADER_LENGTH);
  }
  if (!data.length) {
    return message;
  }
  let text: string;
  if (data.length % 16 === 0) {
    try {
      text = decrypt(localKey, data).toString('utf8');
    } catch {
      text = data.toString('utf8');
    }
  } else {
    text = data.toString('utf8');
  }
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === 'object') {
      message.data = parsed;
      return message;
    }
  } catch {
    message.text = text;
    return message;
  }
  message.text = text;
  return message;
}

export function dpsOf(message: Message): Dps | undefined {
  const dps = message.data?.dps;
  return dps && typeof dps === 'object' ? dps as Dps : undefined;
}
