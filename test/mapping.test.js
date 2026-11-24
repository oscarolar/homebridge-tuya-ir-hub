const {test} = require('node:test');
const assert = require('node:assert');
const mapping = require('../dist/mapping');
const ir = require('../dist/ir');

test('DP 101 is tenths of a degree, with the configured offset', () => {
  assert.deepStrictEqual(mapping.climateFromDps({101: 296, 102: 63}), {temperature: 29.6, humidity: 63});
  assert.strictEqual(mapping.temperatureFromDevice(296, -1.5), 28.1);
  assert.strictEqual(mapping.temperatureFromDevice(-200), -20);
  assert.strictEqual(mapping.temperatureFromDevice(800, 50), 100);
  assert.strictEqual(mapping.temperatureFromDevice(1, 0.2), 0.3);
});

test('DP 102 is relative humidity in percent, clamped', () => {
  assert.strictEqual(mapping.humidityFromDevice(63), 63);
  assert.strictEqual(mapping.humidityFromDevice(120), 100);
  assert.strictEqual(mapping.humidityFromDevice(-1), 0);
});

test('missing or non-numeric DPs leave the value unknown', () => {
  assert.deepStrictEqual(mapping.climateFromDps({202: 'AAAA'}), {});
  assert.deepStrictEqual(mapping.climateFromDps({101: '296', 102: 40}), {humidity: 40});
});

test('IR JSON for DP 201: send_ir with "1" + code, study and study_exit', () => {
  assert.deepStrictEqual(JSON.parse(ir.sendIr('AbC+/9==')),
    {control: 'send_ir', head: '', key1: '1AbC+/9==', type: 0, delay: 300});
  assert.strictEqual(ir.studyStart(), '{"control":"study"}');
  assert.strictEqual(ir.studyExit(), '{"control":"study_exit"}');
  assert.strictEqual(ir.DP_IR_SEND, '201');
  assert.strictEqual(ir.DP_IR_STUDY_CODE, '202');
});

test('base64 validation and button slugs', () => {
  assert.strictEqual(ir.isBase64('AbC+/9=='), true);
  assert.strictEqual(ir.isBase64('not base64!'), false);
  assert.strictEqual(ir.isBase64(''), false);
  assert.strictEqual(mapping.slug('TV Encender / Apagar'), 'tv-encender-apagar');
  assert.strictEqual(mapping.slug('Ventilación Ñandú'), 'ventilacion-nandu');
  assert.strictEqual(mapping.serviceName('Aire 24°'), 'Aire 24');
  assert.strictEqual(mapping.serviceName('Ventilación (alta)'), 'Ventilación alta');
  assert.strictEqual(mapping.serviceName('***'), 'Button');
});
