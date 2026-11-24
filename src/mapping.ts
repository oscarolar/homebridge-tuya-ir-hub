import type {Dps} from './protocol';

export const DP_TEMPERATURE = '101';
export const DP_HUMIDITY = '102';

export const TEMPERATURE_SCALE = 10;
export const TEMPERATURE_MIN = -50;
export const TEMPERATURE_MAX = 100;

export interface Climate {
  temperature?: number;
  humidity?: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

export function temperatureFromDevice(raw: number, offset = 0): number {
  const celsius = raw / TEMPERATURE_SCALE + offset;
  return clamp(Math.round(celsius * 10) / 10, TEMPERATURE_MIN, TEMPERATURE_MAX);
}

export function humidityFromDevice(raw: number): number {
  return clamp(Math.round(raw), 0, 100);
}

export function climateFromDps(dps: Dps, offset = 0): Climate {
  const climate: Climate = {};
  const temperature = dps[DP_TEMPERATURE];
  const humidity = dps[DP_HUMIDITY];
  if (typeof temperature === 'number' && Number.isFinite(temperature)) {
    climate.temperature = temperatureFromDevice(temperature, offset);
  }
  if (typeof humidity === 'number' && Number.isFinite(humidity)) {
    climate.humidity = humidityFromDevice(humidity);
  }
  return climate;
}

export function slug(name: string): string {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

export function serviceName(name: string): string {
  return name.replace(/[^\p{L}\p{N} '.,-]+/gu, ' ').replace(/\s+/g, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '') || 'Button';
}
