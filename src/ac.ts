import type {API, PlatformAccessory, Service} from 'homebridge';
import {AC_FANS, AC_MODES, AC_TOGGLES, AcFan, AcMode, AcToggle, clampTemp, offCode, stateCode, toggleCode} from './coolix';
import type {TuyaHub} from './device';
import {TEMPERATURE_MAX, TEMPERATURE_MIN} from './mapping';

export const AC_DEBOUNCE_MS = 400;
export const MODE_RESET_MS = 1000;
export const DEFAULT_TEMP = 24;

export interface AcOptions {
  name: string;
  heat: boolean;
  minTemp: number;
  maxTemp: number;
  extraModes: boolean;
  toggles: AcToggle[];
  names: AcSwitchNames;
}

export type AcSwitch = AcToggle | 'fanOnly' | 'dry';
export type AcSwitchNames = Record<AcSwitch, string>;

export interface AcContext {
  active: boolean;
  mode: AcMode;
  coolTemp: number;
  heatTemp: number;
  fan: AcFan;
}

const SPEEDS: Record<AcFan, number> = {low: 25, med: 50, high: 75, auto: 100};
const FAN_BY_STEP: AcFan[] = ['auto', 'low', 'med', 'high', 'auto'];

const EXTRA_MODES: {subtype: string; key: AcSwitch; mode: AcMode}[] = [
  {subtype: 'fan-only', key: 'fanOnly', mode: 'fan'},
  {subtype: 'dry', key: 'dry', mode: 'dry'},
];

export const DEFAULT_SWITCH_NAMES: AcSwitchNames = {
  swing: 'Swing',
  display: 'Display',
  sleep: 'Sleep',
  turbo: 'Turbo',
  fanOnly: 'Fan Only',
  dry: 'Dry',
};

interface Pending {
  timer: NodeJS.Timeout;
  promise: Promise<void>;
  resolve: () => void;
  reject: (error: Error) => void;
}

export class TuyaIRAcAccessory {
  private readonly service: Service;
  private readonly state: AcContext;
  private readonly timers = new Set<NodeJS.Timeout>();
  private pending?: Pending;

  constructor(
    private readonly api: API,
    private readonly accessory: PlatformAccessory,
    private readonly hub: TuyaHub,
    private readonly options: AcOptions,
  ) {
    const {Service, Characteristic} = api.hap;
    this.state = this.restore();

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Tuya')
      .setCharacteristic(Characteristic.Model, 'Coolix IR air conditioner')
      .setCharacteristic(Characteristic.SerialNumber, `${hub.config.id}-ac`);

    this.service = accessory.getService(Service.HeaterCooler)
      ?? accessory.addService(Service.HeaterCooler, options.name);
    this.service.setCharacteristic(Characteristic.Name, options.name);

    this.service.getCharacteristic(Characteristic.Active)
      .onGet(() => this.activeValue())
      .onSet(async value => {
        this.state.active = Number(value) === Characteristic.Active.ACTIVE;
        await this.changed(true);
      });

    this.service.getCharacteristic(Characteristic.CurrentHeaterCoolerState)
      .onGet(() => this.currentStateValue());

    const {TargetHeaterCoolerState} = Characteristic;
    const validValues = [TargetHeaterCoolerState.AUTO, TargetHeaterCoolerState.COOL];
    if (options.heat) {
      validValues.splice(1, 0, TargetHeaterCoolerState.HEAT);
    }
    this.service.getCharacteristic(TargetHeaterCoolerState)
      .setProps({validValues})
      .onGet(() => this.targetStateValue())
      .onSet(async value => {
        const target = Number(value);
        this.state.mode = target === TargetHeaterCoolerState.AUTO ? 'auto'
          : target === TargetHeaterCoolerState.HEAT && options.heat ? 'heat' : 'cool';
        await this.changed();
      });

    this.service.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({minValue: TEMPERATURE_MIN, maxValue: TEMPERATURE_MAX})
      .onGet(() => this.currentTemperature());

    const temperatureProps = {minValue: options.minTemp, maxValue: options.maxTemp, minStep: 1};
    this.service.getCharacteristic(Characteristic.CoolingThresholdTemperature)
      .setProps(temperatureProps)
      .onGet(() => this.state.coolTemp)
      .onSet(async value => {
        this.state.coolTemp = this.temp(Number(value));
        await this.changed();
      });

    if (options.heat) {
      this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature)
        .setProps(temperatureProps)
        .onGet(() => this.state.heatTemp)
        .onSet(async value => {
          this.state.heatTemp = this.temp(Number(value));
          await this.changed();
        });
    } else if (this.service.testCharacteristic(Characteristic.HeatingThresholdTemperature)) {
      this.service.removeCharacteristic(this.service.getCharacteristic(Characteristic.HeatingThresholdTemperature));
    }

    this.service.getCharacteristic(Characteristic.RotationSpeed)
      .setProps({minValue: 0, maxValue: 100, minStep: 25})
      .onGet(() => SPEEDS[this.state.fan])
      .onSet(async value => {
        const step = Math.round(Number(value) / 25);
        if (!Number.isFinite(step) || step <= 0) {
          setImmediate(() => this.refresh());
          return;
        }
        this.state.fan = FAN_BY_STEP[Math.min(4, step)];
        await this.changed();
      });

    this.setupExtraModes();
    this.setupToggles();
    this.refresh();
    hub.onUpdate(() => this.updateTemperature());
  }

  get context(): Readonly<AcContext> {
    return this.state;
  }

  stop(): void {
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve();
      this.pending = undefined;
    }
  }

  private setupExtraModes(): void {
    const {Service, Characteristic} = this.api.hap;
    for (const extra of EXTRA_MODES) {
      const existing = this.accessory.getServiceById(Service.Switch, extra.subtype);
      if (!this.options.extraModes) {
        if (existing) {
          this.accessory.removeService(existing);
        }
        continue;
      }
      const name = this.options.names[extra.key];
      const service = existing ?? this.accessory.addService(Service.Switch, name, extra.subtype);
      service.setCharacteristic(Characteristic.Name, name);
      const on = service.getCharacteristic(Characteristic.On);
      on.updateValue(false);
      on.onGet(() => false)
        .onSet(async value => {
          if (!value) {
            return;
          }
          this.resetLater(service);
          this.state.mode = extra.mode;
          this.state.active = true;
          this.refresh();
          await this.changed(true);
        });
    }
  }

  private setupToggles(): void {
    const {Service, Characteristic} = this.api.hap;
    for (const toggle of AC_TOGGLES) {
      const subtype = `toggle-${toggle}`;
      const existing = this.accessory.getServiceById(Service.Switch, subtype);
      if (!this.options.toggles.includes(toggle)) {
        if (existing) {
          this.accessory.removeService(existing);
        }
        continue;
      }
      const name = this.options.names[toggle];
      const service = existing ?? this.accessory.addService(Service.Switch, name, subtype);
      service.setCharacteristic(Characteristic.Name, name);
      const on = service.getCharacteristic(Characteristic.On);
      on.updateValue(false);
      on.onGet(() => false)
        .onSet(async value => {
          if (!value) {
            return;
          }
          this.resetLater(service);
          try {
            await this.hub.sendIr(toggleCode(toggle));
          } catch {
            throw this.notResponding();
          }
        });
    }
  }

  private restore(): AcContext {
    const saved = (this.accessory.context.ac ?? {}) as Partial<AcContext>;
    const mode = AC_MODES.includes(saved.mode as AcMode) ? saved.mode as AcMode : 'cool';
    const state: AcContext = {
      active: saved.active === true,
      mode: mode === 'heat' && !this.options.heat ? 'cool' : mode,
      coolTemp: this.temp(saved.coolTemp ?? DEFAULT_TEMP),
      heatTemp: this.temp(saved.heatTemp ?? DEFAULT_TEMP),
      fan: AC_FANS.includes(saved.fan as AcFan) ? saved.fan as AcFan : 'auto',
    };
    this.accessory.context.ac = state;
    return state;
  }

  private temp(value: number): number {
    const {minTemp, maxTemp} = this.options;
    return Math.min(maxTemp, Math.max(minTemp, clampTemp(Number.isFinite(value) ? value : DEFAULT_TEMP)));
  }

  private changed(force = false): Promise<void> {
    this.persist();
    this.refresh();
    if (!force && !this.state.active && !this.pending) {
      return Promise.resolve();
    }
    return this.schedule();
  }

  private persist(): void {
    this.accessory.context.ac = this.state;
    this.api.updatePlatformAccessories([this.accessory]);
  }

  private schedule(): Promise<void> {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.timer = setTimeout(() => this.flush(), AC_DEBOUNCE_MS);
      return this.pending.promise;
    }
    let resolve!: () => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<void>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    this.pending = {timer: setTimeout(() => this.flush(), AC_DEBOUNCE_MS), promise, resolve, reject};
    return promise;
  }

  private async flush(): Promise<void> {
    const pending = this.pending;
    this.pending = undefined;
    if (!pending) {
      return;
    }
    const {active, mode, fan} = this.state;
    const code = active ? stateCode({mode, temp: this.targetTemp(), fan}) : offCode();
    try {
      await this.hub.sendIr(code);
      pending.resolve();
    } catch {
      pending.reject(this.notResponding());
    }
  }

  private targetTemp(): number {
    return this.state.mode === 'heat' ? this.state.heatTemp : this.state.coolTemp;
  }

  private activeValue(): number {
    const {Active} = this.api.hap.Characteristic;
    return this.state.active ? Active.ACTIVE : Active.INACTIVE;
  }

  private currentStateValue(): number {
    const {CurrentHeaterCoolerState} = this.api.hap.Characteristic;
    if (!this.state.active) {
      return CurrentHeaterCoolerState.INACTIVE;
    }
    switch (this.state.mode) {
      case 'cool':
        return CurrentHeaterCoolerState.COOLING;
      case 'heat':
        return CurrentHeaterCoolerState.HEATING;
      default:
        return CurrentHeaterCoolerState.IDLE;
    }
  }

  private targetStateValue(): number {
    const {TargetHeaterCoolerState} = this.api.hap.Characteristic;
    switch (this.state.mode) {
      case 'auto':
        return TargetHeaterCoolerState.AUTO;
      case 'heat':
        return TargetHeaterCoolerState.HEAT;
      default:
        return TargetHeaterCoolerState.COOL;
    }
  }

  private currentTemperature(): number {
    const {temperature} = this.hub.climate;
    if (!this.hub.isOnline || temperature === undefined) {
      throw this.notResponding();
    }
    return temperature;
  }

  private refresh(): void {
    const {Characteristic} = this.api.hap;
    this.service.updateCharacteristic(Characteristic.Active, this.activeValue());
    this.service.updateCharacteristic(Characteristic.CurrentHeaterCoolerState, this.currentStateValue());
    this.service.updateCharacteristic(Characteristic.TargetHeaterCoolerState, this.targetStateValue());
    this.service.updateCharacteristic(Characteristic.CoolingThresholdTemperature, this.state.coolTemp);
    if (this.options.heat) {
      this.service.updateCharacteristic(Characteristic.HeatingThresholdTemperature, this.state.heatTemp);
    }
    this.service.updateCharacteristic(Characteristic.RotationSpeed, SPEEDS[this.state.fan]);
  }

  private updateTemperature(): void {
    const {Characteristic} = this.api.hap;
    const {temperature} = this.hub.climate;
    if (!this.hub.isOnline) {
      this.service.updateCharacteristic(Characteristic.CurrentTemperature, this.notResponding());
    } else if (temperature !== undefined) {
      this.service.updateCharacteristic(Characteristic.CurrentTemperature, temperature);
    }
  }

  private resetLater(service: Service): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      service.updateCharacteristic(this.api.hap.Characteristic.On, false);
    }, MODE_RESET_MS);
    this.timers.add(timer);
  }

  private notResponding() {
    const {HapStatusError, HAPStatus} = this.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}
