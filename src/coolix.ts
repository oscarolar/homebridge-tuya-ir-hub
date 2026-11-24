export type AcMode = 'cool' | 'heat' | 'auto' | 'dry' | 'fan';
export type AcFan = 'auto' | 'low' | 'med' | 'high';

export interface AcState {
  mode: AcMode;
  temp: number;
  fan: AcFan;
}

export const AC_MODES: readonly AcMode[] = ['cool', 'heat', 'auto', 'dry', 'fan'];
export const AC_FANS: readonly AcFan[] = ['auto', 'low', 'med', 'high'];

export const TEMP_MIN = 17;
export const TEMP_MAX = 30;

export const HEADER_MARK = 4400;
export const HEADER_SPACE = 4400;
export const BIT_MARK = 550;
export const ONE_SPACE = 1650;
export const ZERO_SPACE = 550;
export const FRAME_GAP = 5280;
export const TRAILING_GAP = 30000;

export type AcToggle = 'swing' | 'display' | 'sleep' | 'turbo';

export const COMMANDS = {
  off: 0xB27BE0,
  swing: 0xB26BE0,
  sleep: 0xB2E003,
  turbo: 0xB5F5A2,
  display: 0xB5F5A5,
} as const;

export const AC_TOGGLES: readonly AcToggle[] = ['swing', 'display', 'sleep', 'turbo'];

export function commandBytes(value: number): number[] {
  const bytes = [(value >> 16) & 0xFF, (value >> 8) & 0xFF, value & 0xFF];
  return bytes.flatMap(byte => [byte, ~byte & 0xFF]);
}

export const OFF: readonly number[] = commandBytes(COMMANDS.off);

const TEMP_CODES = [0x0, 0x1, 0x3, 0x2, 0x6, 0x7, 0x5, 0x4, 0xC, 0xD, 0x9, 0x8, 0xA, 0xB];
const FAN_ONLY_TEMP = 0xE;
const MODE_BITS: Record<AcMode, number> = {cool: 0, dry: 1, auto: 2, heat: 3, fan: 1};
const FAN_BITS: Record<AcFan, number> = {auto: 0b101, low: 0b100, med: 0b010, high: 0b001};
const FAN_AUTO0 = 0b000;

export function clampTemp(temp: number): number {
  const value = Number.isFinite(temp) ? Math.round(temp) : TEMP_MIN;
  return Math.min(TEMP_MAX, Math.max(TEMP_MIN, value));
}

export function encodeState({mode, temp, fan}: AcState): number[] {
  const fanBits = mode === 'auto' || mode === 'dry' ? FAN_AUTO0 : FAN_BITS[fan];
  const tempCode = mode === 'fan' ? FAN_ONLY_TEMP : TEMP_CODES[clampTemp(temp) - TEMP_MIN];
  const b1 = (fanBits << 5) | 0x1F;
  const b2 = (tempCode << 4) | (MODE_BITS[mode] << 2);
  return commandBytes((0xB2 << 16) | (b1 << 8) | b2);
}

function framePulses(bytes: readonly number[]): number[] {
  const pulses = [HEADER_MARK, HEADER_SPACE];
  for (const byte of bytes) {
    for (let bit = 7; bit >= 0; bit--) {
      pulses.push(BIT_MARK, (byte >> bit) & 1 ? ONE_SPACE : ZERO_SPACE);
    }
  }
  return pulses;
}

export function bytesToPulses(bytes: readonly number[]): number[] {
  const frame = framePulses(bytes);
  return [...frame, BIT_MARK, FRAME_GAP, ...frame, BIT_MARK, TRAILING_GAP];
}

export function pulsesToBase64(pulses: readonly number[]): string {
  const buffer = Buffer.alloc(pulses.length * 2);
  pulses.forEach((pulse, i) => buffer.writeUInt16LE(Math.min(0xFFFF, Math.max(0, Math.round(pulse))), i * 2));
  return buffer.toString('base64');
}

export function stateCode(state: AcState): string {
  return pulsesToBase64(bytesToPulses(encodeState(state)));
}

export function offCode(): string {
  return pulsesToBase64(bytesToPulses(OFF));
}

export function toggleCode(toggle: AcToggle): string {
  return pulsesToBase64(bytesToPulses(commandBytes(COMMANDS[toggle])));
}

export function hex(bytes: readonly number[]): string {
  return bytes.map(b => b.toString(16).toUpperCase().padStart(2, '0')).join(' ');
}
