import {EventEmitter} from 'events';
import net from 'net';
import {
  CMD, Dps, Frame, FrameParser, Message,
  controlBody, decodePayload, dpsOf, encodeFrame, encodePayload, queryBody,
} from './protocol';

export const DEFAULT_PORT = 6668;

export interface ClientOptions {
  host: string;
  id: string;
  localKey: string;
  port?: number;
  timeoutMs?: number;
  heartbeatMs?: number;
  minBackoffMs?: number;
  maxBackoffMs?: number;
}

interface Waiter {
  cmd: number;
  resolve: (message: Message) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

export declare interface TuyaClient {
  on(event: 'connect', listener: () => void): this;
  on(event: 'disconnect', listener: (error?: Error) => void): this;
  on(event: 'dps', listener: (dps: Dps, cmd: number) => void): this;
  once(event: 'connect', listener: () => void): this;
}

export class TuyaClient extends EventEmitter {
  readonly host: string;
  readonly port: number;
  readonly id: string;
  private readonly localKey: string;
  private readonly timeoutMs: number;
  private readonly heartbeatMs: number;
  private readonly minBackoffMs: number;
  private readonly maxBackoffMs: number;

  private socket?: net.Socket;
  private isConnected = false;
  private running = false;
  private seq = 0;
  private backoffMs: number;
  private reconnectTimer?: NodeJS.Timeout;
  private heartbeatTimer?: NodeJS.Timeout;
  private lastReceived = 0;
  private waiter?: Waiter;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(options: ClientOptions) {
    super();
    this.host = options.host;
    this.port = options.port ?? DEFAULT_PORT;
    this.id = options.id;
    this.localKey = options.localKey;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.heartbeatMs = options.heartbeatMs ?? 10000;
    this.minBackoffMs = options.minBackoffMs ?? 2000;
    this.maxBackoffMs = options.maxBackoffMs ?? 60000;
    this.backoffMs = this.minBackoffMs;
  }

  get connected(): boolean {
    return this.isConnected;
  }

  get nextBackoffMs(): number {
    return this.backoffMs;
  }

  start(): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.connect();
  }

  stop(): void {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.socket?.destroy();
  }

  query(): Promise<Dps> {
    return this.request(CMD.DP_QUERY, queryBody(this.id)).then(message => {
      const dps = dpsOf(message);
      if (!dps) {
        throw new Error(`unexpected query response${message.text ? `: ${message.text.slice(0, 80)}` : ''}`);
      }
      return dps;
    });
  }

  set(dps: Dps): Promise<void> {
    return this.request(CMD.CONTROL, controlBody(this.id, dps)).then(() => undefined);
  }

  private request(cmd: number, body: Record<string, unknown>): Promise<Message> {
    const run = () => this.exchange(cmd, body);
    const result = this.queue.then(run, run);
    this.queue = result.catch(() => undefined);
    return result;
  }

  private exchange(cmd: number, body: Record<string, unknown>): Promise<Message> {
    return new Promise((resolve, reject) => {
      if (!this.socket || !this.isConnected) {
        return reject(new Error('not connected'));
      }
      const timer = setTimeout(() => {
        this.waiter = undefined;
        reject(new Error(`timeout after ${this.timeoutMs} ms`));
      }, this.timeoutMs);
      this.waiter = {cmd, resolve, reject, timer};
      this.write(cmd, body);
    });
  }

  private write(cmd: number, body: Record<string, unknown> | null): void {
    this.seq = (this.seq + 1) >>> 0;
    this.socket?.write(encodeFrame(this.seq, cmd, encodePayload(cmd, this.localKey, body)));
  }

  private connect(): void {
    const socket = net.connect(this.port, this.host);
    const parser = new FrameParser();
    this.socket = socket;
    socket.setNoDelay(true);
    socket.setTimeout(this.timeoutMs, () => socket.destroy(new Error(`connect timeout after ${this.timeoutMs} ms`)));
    socket.on('connect', () => {
      socket.setTimeout(0);
      this.isConnected = true;
      this.lastReceived = Date.now();
      this.heartbeatTimer = setInterval(() => this.heartbeat(), this.heartbeatMs);
      this.emit('connect');
    });
    socket.on('data', chunk => {
      this.lastReceived = Date.now();
      for (const frame of parser.push(chunk)) {
        this.backoffMs = this.minBackoffMs;
        this.handle(frame);
      }
    });
    let failure: Error | undefined;
    socket.on('error', error => {
      failure = error;
    });
    socket.on('close', () => this.closed(socket, failure));
  }

  private closed(socket: net.Socket, error?: Error): void {
    if (socket !== this.socket) {
      return;
    }
    const wasConnected = this.isConnected;
    this.socket = undefined;
    this.isConnected = false;
    clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = undefined;
    const waiter = this.waiter;
    if (waiter) {
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      waiter.reject(error ?? new Error('connection closed'));
    }
    if (wasConnected) {
      this.emit('disconnect', error);
    }
    if (!this.running) {
      return;
    }
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, this.maxBackoffMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.running) {
        this.connect();
      }
    }, delay);
  }

  private heartbeat(): void {
    if (Date.now() - this.lastReceived > this.heartbeatMs * 3) {
      this.socket?.destroy(new Error('heartbeat timeout'));
      return;
    }
    this.write(CMD.HEART_BEAT, {});
  }

  private handle(frame: Frame): void {
    if (frame.cmd === CMD.HEART_BEAT) {
      return;
    }
    let message: Message;
    try {
      message = decodePayload(this.localKey, frame.payload);
    } catch {
      message = {};
    }
    const waiter = this.waiter;
    if (waiter && (frame.cmd === waiter.cmd || (waiter.cmd === CMD.CONTROL && frame.cmd === CMD.STATUS))) {
      this.waiter = undefined;
      clearTimeout(waiter.timer);
      if (message.retcode) {
        waiter.reject(new Error(`device rejected cmd ${frame.cmd} (retcode ${message.retcode})`));
      } else {
        waiter.resolve(message);
      }
    }
    const dps = dpsOf(message);
    if (dps) {
      this.emit('dps', dps, frame.cmd);
    }
  }
}
