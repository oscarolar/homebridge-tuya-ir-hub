const {test} = require('node:test');
const assert = require('node:assert');
const coolix = require('../dist/coolix');

const bytes = state => coolix.hex(coolix.encodeState(state));
const decode = code => {
  const buffer = Buffer.from(code, 'base64');
  return Array.from({length: buffer.length / 2}, (_, i) => buffer.readUInt16LE(i * 2));
};

test('cool 24 °C fan auto matches the code learned from the real remote', () => {
  assert.strictEqual(bytes({mode: 'cool', temp: 24, fan: 'auto'}), 'B2 4D BF 40 40 BF');
  assert.strictEqual(coolix.encodeState({mode: 'cool', temp: 26, fan: 'auto'})[4], 0xD0);
});

test('off is the fixed B2 4D 7B 84 E0 1F command', () => {
  assert.strictEqual(coolix.hex(coolix.OFF), 'B2 4D 7B 84 E0 1F');
});

test('modes, fan speeds and the forced auto0 fan in auto and dry', () => {
  assert.strictEqual(bytes({mode: 'heat', temp: 24, fan: 'low'}), 'B2 4D 9F 60 4C B3');
  assert.strictEqual(bytes({mode: 'cool', temp: 17, fan: 'med'}), 'B2 4D 5F A0 00 FF');
  assert.strictEqual(bytes({mode: 'cool', temp: 30, fan: 'high'}), 'B2 4D 3F C0 B0 4F');
  assert.strictEqual(bytes({mode: 'fan', temp: 24, fan: 'high'}), 'B2 4D 3F C0 E4 1B');
  assert.strictEqual(bytes({mode: 'dry', temp: 25, fan: 'high'}), 'B2 4D 1F E0 C4 3B');
  assert.strictEqual(bytes({mode: 'auto', temp: 22, fan: 'low'}), 'B2 4D 1F E0 78 87');
});

test('temperature is rounded and clamped to 17-30 °C', () => {
  assert.strictEqual(bytes({mode: 'cool', temp: 10, fan: 'auto'}), bytes({mode: 'cool', temp: 17, fan: 'auto'}));
  assert.strictEqual(bytes({mode: 'cool', temp: 35, fan: 'auto'}), bytes({mode: 'cool', temp: 30, fan: 'auto'}));
  assert.strictEqual(bytes({mode: 'cool', temp: 23.6, fan: 'auto'}), bytes({mode: 'cool', temp: 24, fan: 'auto'}));
  assert.strictEqual(coolix.clampTemp(NaN), 17);
});

test('fixed commands: swing, sleep, turbo and display', () => {
  assert.strictEqual(coolix.hex(coolix.commandBytes(coolix.COMMANDS.swing)), 'B2 4D 6B 94 E0 1F');
  assert.strictEqual(coolix.hex(coolix.commandBytes(coolix.COMMANDS.sleep)), 'B2 4D E0 1F 03 FC');
  assert.strictEqual(coolix.hex(coolix.commandBytes(coolix.COMMANDS.turbo)), 'B5 4A F5 0A A2 5D');
  assert.strictEqual(coolix.hex(coolix.commandBytes(coolix.COMMANDS.display)), 'B5 4A F5 0A A5 5A');
});

test('pulses: header, MSB-first bits, gap, repeated frame and trailing gap', () => {
  const pulses = coolix.bytesToPulses(coolix.encodeState({mode: 'cool', temp: 24, fan: 'auto'}));
  assert.strictEqual(pulses.length, 200);
  assert.deepStrictEqual(pulses.slice(0, 4), [4400, 4400, 550, 1650]);
  assert.deepStrictEqual(pulses.slice(4, 6), [550, 550]);
  assert.deepStrictEqual(pulses.slice(98, 102), [550, 5280, 4400, 4400]);
  assert.deepStrictEqual(pulses.slice(102, 198), pulses.slice(2, 98));
  assert.deepStrictEqual(pulses.slice(-2), [550, 30000]);
});

test('learned-code format: base64 of little-endian uint16 durations', () => {
  assert.strictEqual(coolix.pulsesToBase64([4400, 550]), Buffer.from([0x30, 0x11, 0x26, 0x02]).toString('base64'));
  const pulses = coolix.bytesToPulses(coolix.OFF);
  assert.deepStrictEqual(decode(coolix.offCode()), pulses);
  assert.deepStrictEqual(decode(coolix.stateCode({mode: 'cool', temp: 26, fan: 'auto'})),
    coolix.bytesToPulses(coolix.encodeState({mode: 'cool', temp: 26, fan: 'auto'})));
  assert.deepStrictEqual(decode(coolix.toggleCode('turbo')), coolix.bytesToPulses(coolix.commandBytes(0xB5F5A2)));
});
