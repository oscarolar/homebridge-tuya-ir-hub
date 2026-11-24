import type {API, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig} from 'homebridge';
import {TuyaIRHubAccessory} from './accessory';
import {ButtonConfig, HubConfig, TuyaHub} from './device';
import {isBase64} from './ir';
import {slug} from './mapping';
import {VERSION} from './protocol';

export const PLUGIN_NAME = 'homebridge-tuya-ir-hub';
export const PLATFORM_NAME = 'TuyaIRHub';

export class TuyaIRHubPlatform implements DynamicPlatformPlugin {
  private readonly cached = new Map<string, PlatformAccessory>();
  private readonly hubs: TuyaHub[] = [];
  private readonly views: TuyaIRHubAccessory[] = [];
  private shuttingDown = false;

  constructor(
    readonly log: Logging,
    readonly config: PlatformConfig,
    readonly api: API,
  ) {
    api.on('didFinishLaunching', () => {
      try {
        this.setup();
      } catch (error) {
        this.log.error(`Setup failed: ${(error as Error).message}`);
      }
    });
    api.on('shutdown', () => {
      this.shuttingDown = true;
      this.views.forEach(view => view.stop());
      this.hubs.forEach(hub => hub.stop());
    });
  }

  configureAccessory(accessory: PlatformAccessory): void {
    this.cached.set(accessory.UUID, accessory);
  }

  private setup(): void {
    const wanted = new Set<string>();
    for (const hub of (this.config.hubs ?? []) as HubConfig[]) {
      if (!this.valid(hub)) {
        continue;
      }
      const uuid = this.api.hap.uuid.generate(`tuya-ir-hub:${hub.id}`);
      if (wanted.has(uuid)) {
        this.log.warn(`${hub.name}: device ${hub.id} is configured more than once, ignoring this entry`);
        continue;
      }
      wanted.add(uuid);
      let accessory = this.cached.get(uuid);
      if (!accessory) {
        accessory = new this.api.platformAccessory(hub.name, uuid);
        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
        this.log.info(`Added ${hub.name} (${hub.ip})`);
      }
      const device = new TuyaHub(hub, this.log);
      this.hubs.push(device);
      this.views.push(new TuyaIRHubAccessory(this.api, accessory, device, this.buttons(hub)));
      if (!this.shuttingDown) {
        device.start();
      }
    }

    const stale = [...this.cached.values()].filter(a => !wanted.has(a.UUID));
    if (stale.length) {
      this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, stale);
      stale.forEach(a => this.log.info(`Removed ${a.displayName}`));
    }
  }

  private valid(hub: HubConfig): boolean {
    const label = hub?.name || hub?.id || 'hub';
    if (!hub?.name || !hub.id || !hub.ip || !hub.localKey) {
      this.log.error(`${label}: name, id, ip and localKey are required, ignoring this entry`);
      return false;
    }
    if (String(hub.localKey).length !== 16) {
      this.log.error(`${label}: localKey must be 16 characters, ignoring this entry`);
      return false;
    }
    const version = String(hub.version ?? VERSION);
    if (version !== VERSION) {
      this.log.error(`${label}: Tuya protocol ${version} is not supported (only ${VERSION}), ignoring this entry`);
      return false;
    }
    return true;
  }

  private buttons(hub: HubConfig): ButtonConfig[] {
    const seen = new Set<string>();
    const buttons: ButtonConfig[] = [];
    for (const button of hub.buttons ?? []) {
      const id = button?.name ? slug(button.name) : '';
      if (!id || !button.code) {
        this.log.warn(`${hub.name}: a button needs a name and a code, ignoring it`);
        continue;
      }
      if (!isBase64(button.code)) {
        this.log.warn(`${hub.name}: button ${button.name} has a code that is not base64, ignoring it`);
        continue;
      }
      if (seen.has(id)) {
        this.log.warn(`${hub.name}: button ${button.name} is configured more than once, ignoring it`);
        continue;
      }
      seen.add(id);
      buttons.push(button);
    }
    return buttons;
  }
}
