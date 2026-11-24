import type {Logging} from 'homebridge';
import {ClientOptions, TuyaClient} from './client';
import {DP_IR_SEND, sendIr} from './ir';
import {Climate, climateFromDps} from './mapping';
import type {Dps} from './protocol';

export const MIN_POLL_SECONDS = 15;
export const DEFAULT_POLL_SECONDS = 60;
const OFFLINE_GRACE_MS = 30000;

export interface ButtonConfig {
  name: string;
  code: string;
}

export interface AcConfig {
  name?: string;
  protocol?: string;
  heat?: boolean;
  minTemp?: number;
  maxTemp?: number;
  extraModes?: boolean;
  toggles?: string[];
}

export interface HubConfig {
  name: string;
  id: string;
  ip: string;
  localKey: string;
  version?: string | number;
  port?: number;
  pollInterval?: number;
  temperatureOffset?: number;
  buttons?: ButtonConfig[];
  ac?: AcConfig;
}

export interface HubOptions {
  offlineGraceMs?: number;
  client?: Partial<ClientOptions>;
}

export class DeviceNotRespondingError extends Error {}

export class TuyaHub {
  readonly client: TuyaClient;
  private readonly listeners: ((climate: Readonly<Climate>) => void)[] = [];
  private readonly current: Climate = {};
  private readonly offlineGraceMs: number;
  private online = false;
  private stopped = false;
  private pollTimer?: NodeJS.Timeout;
  private offlineTimer?: NodeJS.Timeout;

  constructor(
    readonly config: HubConfig,
    private readonly log: Logging,
    options: HubOptions = {},
  ) {
    this.offlineGraceMs = options.offlineGraceMs ?? OFFLINE_GRACE_MS;
    this.client = new TuyaClient({
      host: config.ip,
      port: config.port,
      id: config.id,
      localKey: config.localKey,
      ...options.client,
    });
    this.client.on('connect', () => this.connected());
    this.client.on('disconnect', error => this.disconnected(error));
    this.client.on('dps', dps => this.apply(dps));
  }

  get name(): string {
    return this.config.name;
  }

  get climate(): Readonly<Climate> {
    return this.current;
  }

  get isOnline(): boolean {
    return this.online;
  }

  get pollSeconds(): number {
    return Math.max(MIN_POLL_SECONDS, this.config.pollInterval ?? DEFAULT_POLL_SECONDS);
  }

  onUpdate(listener: (climate: Readonly<Climate>) => void): void {
    this.listeners.push(listener);
  }

  start(): void {
    if (this.stopped || this.pollTimer) {
      return;
    }
    this.client.start();
    this.pollTimer = setInterval(() => this.poll(), this.pollSeconds * 1000);
  }

  stop(): void {
    this.stopped = true;
    clearInterval(this.pollTimer);
    clearTimeout(this.offlineTimer);
    this.pollTimer = this.offlineTimer = undefined;
    this.client.stop();
  }

  async sendIr(code: string): Promise<void> {
    try {
      await this.client.set({[DP_IR_SEND]: sendIr(code)});
    } catch (error) {
      this.log.warn(`${this.name}: IR send failed: ${(error as Error).message}`);
      throw new DeviceNotRespondingError(`${this.name} is not responding`);
    }
  }

  private connected(): void {
    clearTimeout(this.offlineTimer);
    this.offlineTimer = undefined;
    if (!this.online) {
      this.online = true;
      this.log.info(`${this.name}: connected to ${this.config.ip}`);
      this.notify();
    }
    this.poll();
  }

  private disconnected(error?: Error): void {
    this.log.debug(`${this.name}: connection lost${error ? ` (${error.message})` : ''}`);
    if (this.stopped || this.offlineTimer || !this.online) {
      return;
    }
    this.offlineTimer = setTimeout(() => {
      this.offlineTimer = undefined;
      if (this.client.connected || this.stopped) {
        return;
      }
      this.online = false;
      this.log.warn(`${this.name}: not responding`);
      this.notify();
    }, this.offlineGraceMs);
  }

  private poll(): void {
    if (!this.client.connected) {
      return;
    }
    this.client.query().catch(error => this.log.debug(`${this.name}: query failed: ${(error as Error).message}`));
  }

  private apply(dps: Dps): void {
    const climate = climateFromDps(dps, this.config.temperatureOffset ?? 0);
    if (climate.temperature === undefined && climate.humidity === undefined) {
      return;
    }
    Object.assign(this.current, climate);
    this.notify();
  }

  private notify(): void {
    if (this.stopped) {
      return;
    }
    for (const listener of this.listeners) {
      try {
        listener(this.current);
      } catch (error) {
        this.log.error(`${this.name}: update failed: ${(error as Error).message}`);
      }
    }
  }
}
