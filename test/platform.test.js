const {test} = require('node:test');
const assert = require('node:assert');
const {TuyaIRHubPlatform} = require('../dist/platform');
const {CMD} = require('../dist/protocol');
const {KEY, ID, fakeHub, requestsOf, log, recordingLog, waitFor, fakeApi, FakeAccessory, hap} = require('./helpers');

const {Service, Characteristic} = hap;
const uuid = id => hap.uuid.generate(`tuya-ir-hub:${id}`);
const CODE = 'AAECAwQFBgc=';

function launch(api, hubs, {cached = [], logger = log} = {}) {
  const platform = new TuyaIRHubPlatform(logger, {platform: 'TuyaIRHub', hubs}, api);
  cached.forEach(a => platform.configureAccessory(a));
  api.emit('didFinishLaunching');
  return platform;
}

const hubConfig = (port, extra = {}) =>
  ({name: 'Sala', id: ID, ip: '127.0.0.1', port, localKey: KEY, ...extra});

const read = characteristic => characteristic.handleGetRequest();
const near = (a, b) => Math.abs(a - b) < 1e-9;
const failed = error => (error?.hapStatus ?? error) === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;

test('a hub becomes one accessory with temperature, humidity and a switch per button', async () => {
  const hub = await fakeHub();
  const api = fakeApi();
  launch(api, [hubConfig(hub.port, {temperatureOffset: -0.5, buttons: [
    {name: 'TV Power', code: CODE}, {name: 'Aire 24°', code: CODE},
  ]})]);
  assert.strictEqual(api.calls.registered.length, 1);
  const accessory = api.calls.registered[0];
  assert.strictEqual(accessory.UUID, uuid(ID));
  const temperature = accessory.getService(Service.TemperatureSensor).getCharacteristic(Characteristic.CurrentTemperature);
  const humidity = accessory.getService(Service.HumiditySensor).getCharacteristic(Characteristic.CurrentRelativeHumidity);
  await waitFor(() => near(temperature.value, 29.1));
  assert.ok(near(await read(temperature), 29.1));
  assert.strictEqual(await read(humidity), 63);
  const switches = accessory.services.filter(s => s.UUID === Service.Switch.UUID).map(s => s.subtype);
  assert.deepStrictEqual(switches, ['tv-power', 'aire-24']);
  const aire = accessory.getServiceById(Service.Switch, 'aire-24');
  assert.strictEqual(aire.getCharacteristic(Characteristic.Name).value, 'Aire 24');

  hub.push({101: 305, 102: 70});
  await waitFor(() => near(temperature.value, 30));
  assert.strictEqual(humidity.value, 70);
  assert.strictEqual(hub.state.maxOpen, 1);
  api.emit('shutdown');
  hub.close();
});

test('a button sends its learned code on DP 201 and turns itself off after a second', async () => {
  const hub = await fakeHub();
  const api = fakeApi();
  launch(api, [hubConfig(hub.port, {buttons: [{name: 'TV Power', code: CODE}]})]);
  const accessory = api.calls.registered[0];
  await waitFor(() => requestsOf(hub, CMD.DP_QUERY).length === 1);
  const on = accessory.getServiceById(Service.Switch, 'tv-power').getCharacteristic(Characteristic.On);
  await on.handleSetRequest(true);
  on.value = true;
  const [control] = requestsOf(hub, CMD.CONTROL);
  assert.deepStrictEqual(JSON.parse(control.message.data.dps['201']),
    {control: 'send_ir', head: '', key1: '1' + CODE, type: 0, delay: 300});
  await waitFor(() => on.value === false, 1500);
  await on.handleSetRequest(false);
  assert.strictEqual(requestsOf(hub, CMD.CONTROL).length, 1);
  assert.strictEqual(await read(on), false);
  api.emit('shutdown');
  hub.close();
});

test('an unreachable hub answers reads and button presses with SERVICE_COMMUNICATION_FAILURE', async () => {
  const api = fakeApi();
  launch(api, [hubConfig(1, {buttons: [{name: 'TV', code: CODE}]})]);
  const accessory = api.calls.registered[0];
  const temperature = accessory.getService(Service.TemperatureSensor).getCharacteristic(Characteristic.CurrentTemperature);
  const humidity = accessory.getService(Service.HumiditySensor).getCharacteristic(Characteristic.CurrentRelativeHumidity);
  await assert.rejects(read(temperature), failed);
  await assert.rejects(read(humidity), failed);
  const on = accessory.getServiceById(Service.Switch, 'tv').getCharacteristic(Characteristic.On);
  await assert.rejects(on.handleSetRequest(true), failed);
  api.emit('shutdown');
});

test('cached accessories and switches no longer configured are removed', async () => {
  const hub = await fakeHub();
  const api = fakeApi();
  const cached = new FakeAccessory('Sala', uuid(ID));
  cached.addService(Service.Switch, 'Old', 'old');
  cached.addService(Service.Switch, 'TV', 'tv');
  const stale = new FakeAccessory('Gone', uuid('other-device'));
  launch(api, [hubConfig(hub.port, {buttons: [{name: 'TV', code: CODE}]})], {cached: [cached, stale]});
  assert.strictEqual(api.calls.registered.length, 0);
  assert.deepStrictEqual(api.calls.unregistered, [stale]);
  assert.deepStrictEqual(cached.services.filter(s => s.UUID === Service.Switch.UUID).map(s => s.subtype), ['tv']);
  api.emit('shutdown');
  hub.close();
});

test('invalid entries are rejected with a clear error and the local key is never logged', async () => {
  const api = fakeApi();
  const logger = recordingLog();
  launch(api, [
    {name: 'New', id: 'a', ip: '127.0.0.1', localKey: KEY, version: '3.4'},
    {name: 'NoKey', id: 'b', ip: '127.0.0.1'},
    {name: 'ShortKey', id: 'c', ip: '127.0.0.1', localKey: 'abc'},
    {name: 'Dup', id: ID, ip: '127.0.0.1', port: 1, localKey: KEY, version: 3.3, buttons: [
      {name: 'A', code: CODE}, {name: 'a', code: CODE}, {name: 'Bad', code: 'no!'}, {name: 'Empty'},
    ]},
    {name: 'Dup2', id: ID, ip: '127.0.0.1', port: 1, localKey: KEY},
  ], {logger});
  assert.strictEqual(api.calls.registered.length, 1);
  const switches = api.calls.registered[0].services.filter(s => s.UUID === Service.Switch.UUID);
  assert.deepStrictEqual(switches.map(s => s.subtype), ['a']);
  assert.ok(logger.lines.error.some(line => /3\.4 is not supported \(only 3\.3\)/.test(line)));
  assert.ok(logger.lines.error.some(line => /NoKey: name, id, ip and localKey are required/.test(line)));
  assert.ok(logger.lines.error.some(line => /ShortKey: localKey must be 16 characters/.test(line)));
  assert.ok(logger.lines.warn.some(line => /configured more than once/.test(line)));
  assert.ok(logger.lines.warn.some(line => /not base64/.test(line)));
  api.emit('shutdown');
  const all = Object.values(logger.lines).flat().join('\n');
  assert.ok(!all.includes(KEY));
});

test('poll interval defaults to 60 s with a 15 s minimum', () => {
  const {TuyaHub} = require('../dist/device');
  assert.strictEqual(new TuyaHub(hubConfig(1), log).pollSeconds, 60);
  assert.strictEqual(new TuyaHub(hubConfig(1, {pollInterval: 5}), log).pollSeconds, 15);
  assert.strictEqual(new TuyaHub(hubConfig(1, {pollInterval: 120}), log).pollSeconds, 120);
});
