import type {API, PlatformAccessory, Service} from 'homebridge';
import type {ButtonConfig, TuyaHub} from './device';
import {TEMPERATURE_MAX, TEMPERATURE_MIN, serviceName, slug} from './mapping';

export const BUTTON_RESET_MS = 1000;

export class TuyaIRHubAccessory {
  private readonly temperature: Service;
  private readonly humidity: Service;
  private readonly timers = new Set<NodeJS.Timeout>();

  constructor(
    private readonly api: API,
    accessory: PlatformAccessory,
    private readonly hub: TuyaHub,
    buttons: ButtonConfig[],
  ) {
    const {Service, Characteristic} = api.hap;
    const {config} = hub;

    accessory.getService(Service.AccessoryInformation)!
      .setCharacteristic(Characteristic.Manufacturer, 'Tuya')
      .setCharacteristic(Characteristic.Model, 'S09 IR hub')
      .setCharacteristic(Characteristic.SerialNumber, config.id);

    this.temperature = accessory.getService(Service.TemperatureSensor)
      ?? accessory.addService(Service.TemperatureSensor, `${config.name} Temperature`);
    this.temperature.getCharacteristic(Characteristic.CurrentTemperature)
      .setProps({minValue: TEMPERATURE_MIN, maxValue: TEMPERATURE_MAX})
      .onGet(() => this.read(hub.climate.temperature));

    this.humidity = accessory.getService(Service.HumiditySensor)
      ?? accessory.addService(Service.HumiditySensor, `${config.name} Humidity`);
    this.humidity.getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(() => this.read(hub.climate.humidity));

    const wanted = new Set<string>();
    for (const button of buttons) {
      const subtype = slug(button.name);
      wanted.add(subtype);
      const name = serviceName(button.name);
      const service = accessory.getServiceById(Service.Switch, subtype)
        ?? accessory.addService(Service.Switch, name, subtype);
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
            await hub.sendIr(button.code);
          } catch {
            throw this.notResponding();
          }
        });
    }
    accessory.services
      .filter(s => s.UUID === Service.Switch.UUID && !wanted.has(s.subtype ?? ''))
      .forEach(s => accessory.removeService(s));

    hub.onUpdate(() => this.update());
  }

  stop(): void {
    this.timers.forEach(timer => clearTimeout(timer));
    this.timers.clear();
  }

  private resetLater(service: Service): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      service.updateCharacteristic(this.api.hap.Characteristic.On, false);
    }, BUTTON_RESET_MS);
    this.timers.add(timer);
  }

  private read(value: number | undefined): number {
    if (!this.hub.isOnline || value === undefined) {
      throw this.notResponding();
    }
    return value;
  }

  private update(): void {
    const {Characteristic} = this.api.hap;
    const {temperature, humidity} = this.hub.climate;
    if (!this.hub.isOnline) {
      this.temperature.updateCharacteristic(Characteristic.CurrentTemperature, this.notResponding());
      this.humidity.updateCharacteristic(Characteristic.CurrentRelativeHumidity, this.notResponding());
      return;
    }
    if (temperature !== undefined) {
      this.temperature.updateCharacteristic(Characteristic.CurrentTemperature, temperature);
    }
    if (humidity !== undefined) {
      this.humidity.updateCharacteristic(Characteristic.CurrentRelativeHumidity, humidity);
    }
  }

  private notResponding() {
    const {HapStatusError, HAPStatus} = this.api.hap;
    return new HapStatusError(HAPStatus.SERVICE_COMMUNICATION_FAILURE);
  }
}
