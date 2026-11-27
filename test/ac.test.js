const {test} = require('node:test');
const assert = require('node:assert');
const {TuyaIRHubPlatform} = require('../dist/platform');
const {CMD} = require('../dist/protocol');
const coolix = require('../dist/coolix');
const {KEY, ID, fakeHub, requestsOf, log, recordingLog, waitFor, fakeApi, FakeAccessory, hap} = require('./helpers');

const {Service, Characteristic} = hap;
const acUuid = hap.uuid.generate(`tuya-ir-hub:${ID}-ac`);

function launch(api, ac, port, {cached = [], logger = log} = {}) {
  const hubs = [{name: 'Sala', id: ID, ip: '127.0.0.1', port, localKey: KEY, temperatureOffset: -0.5, ac}];
  const platform = new TuyaIRHubPlatform(logger, {platform: 'TuyaIRHub', hubs}, api);
  cached.forEach(a => platform.configureAccessory(a));
  api.emit('didFinishLaunching');
  return platform;
}

function pulsesToBytes(pulses) {
  const bits = [];
  for (let i = 3; bits.length < 48; i += 2) {
    bits.push(pulses[i] > 1000 ? 1 : 0);
  }
  return Array.from({length: 6}, (_, b) => bits.slice(b * 8, b * 8 + 8).reduce((acc, bit) => (acc << 1) | bit, 0));
}

function sentBytes(hub) {
  return requestsOf(hub, CMD.CONTROL).map(r => {
    const {key1} = JSON.parse(r.message.data.dps['201']);
    const buffer = Buffer.from(key1.slice(1), 'base64');
    const pulses = Array.from({length: buffer.length / 2}, (_, i) => buffer.readUInt16LE(i * 2));
    return coolix.hex(pulsesToBytes(pulses));
  });
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const acAccessory = api => api.calls.registered.find(a => a.UUID === acUuid);

async function started(ac, {cached} = {}) {
  const hub = await fakeHub();
  const api = fakeApi();
  launch(api, ac, hub.port, {cached});
  await waitFor(() => requestsOf(hub, CMD.DP_QUERY).length === 1);
  return {hub, api};
}

test('the AC is a separate HeaterCooler accessory, cool/auto only by default', async () => {
  const {hub, api} = await started({name: 'Aire'});
  assert.strictEqual(api.calls.registered.length, 2);
  const sensors = api.calls.registered.find(a => a.UUID === hap.uuid.generate(`tuya-ir-hub:${ID}`));
  assert.ok(!sensors.getService(Service.HeaterCooler));
  const service = acAccessory(api).getService(Service.HeaterCooler);
  assert.strictEqual(service.getCharacteristic(Characteristic.Name).value, 'Aire');
  const {TargetHeaterCoolerState} = Characteristic;
  assert.deepStrictEqual(service.getCharacteristic(TargetHeaterCoolerState).props.validValues,
    [TargetHeaterCoolerState.AUTO, TargetHeaterCoolerState.COOL]);
  assert.ok(!service.testCharacteristic(Characteristic.HeatingThresholdTemperature));
  const cooling = service.getCharacteristic(Characteristic.CoolingThresholdTemperature).props;
  assert.deepStrictEqual([cooling.minValue, cooling.maxValue, cooling.minStep], [17, 30, 1]);
  const temperature = service.getCharacteristic(Characteristic.CurrentTemperature);
  await waitFor(() => Math.abs(temperature.value - 29.1) < 1e-9);
  assert.strictEqual(await service.getCharacteristic(Characteristic.Active).handleGetRequest(), 0);
  assert.strictEqual(await service.getCharacteristic(Characteristic.CurrentHeaterCoolerState).handleGetRequest(),
    Characteristic.CurrentHeaterCoolerState.INACTIVE);
  assert.strictEqual(service.getCharacteristic(Characteristic.RotationSpeed).value, 100);
  api.emit('shutdown');
  hub.close();
});

test('heat: true adds HEAT and the heating threshold', async () => {
  const {hub, api} = await started({name: 'Aire', heat: true, minTemp: 18, maxTemp: 28});
  const service = acAccessory(api).getService(Service.HeaterCooler);
  const {TargetHeaterCoolerState} = Characteristic;
  assert.deepStrictEqual(service.getCharacteristic(TargetHeaterCoolerState).props.validValues,
    [TargetHeaterCoolerState.AUTO, TargetHeaterCoolerState.HEAT, TargetHeaterCoolerState.COOL]);
  const heating = service.getCharacteristic(Characteristic.HeatingThresholdTemperature).props;
  assert.deepStrictEqual([heating.minValue, heating.maxValue], [18, 28]);
  api.emit('shutdown');
  hub.close();
});

test('writes in one burst are coalesced into exactly one state frame', async () => {
  const {hub, api} = await started({name: 'Aire'});
  const service = acAccessory(api).getService(Service.HeaterCooler);
  const writes = [
    service.getCharacteristic(Characteristic.Active).handleSetRequest(1),
    service.getCharacteristic(Characteristic.TargetHeaterCoolerState).handleSetRequest(Characteristic.TargetHeaterCoolerState.COOL),
    service.getCharacteristic(Characteristic.CoolingThresholdTemperature).handleSetRequest(26),
    service.getCharacteristic(Characteristic.RotationSpeed).handleSetRequest(75),
  ];
  await sleep(200);
  assert.strictEqual(requestsOf(hub, CMD.CONTROL).length, 0);
  await Promise.all(writes);
  await waitFor(() => sentBytes(hub).length >= 1);
  assert.deepStrictEqual(sentBytes(hub), [coolix.hex(coolix.encodeState({mode: 'cool', temp: 26, fan: 'high'}))]);
  assert.strictEqual(service.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value,
    Characteristic.CurrentHeaterCoolerState.COOLING);
  await service.getCharacteristic(Characteristic.CoolingThresholdTemperature).handleSetRequest(24);
  await waitFor(() => sentBytes(hub).length >= 2);
  assert.deepStrictEqual(sentBytes(hub).slice(1), ['B2 4D 3F C0 40 BF']);
  api.emit('shutdown');
  hub.close();
});

test('Active=0 sends OFF, and changes while off are kept without sending', async () => {
  const {hub, api} = await started({name: 'Aire'});
  const service = acAccessory(api).getService(Service.HeaterCooler);
  await service.getCharacteristic(Characteristic.Active).handleSetRequest(0);
  await waitFor(() => sentBytes(hub).length >= 1);
  assert.deepStrictEqual(sentBytes(hub), ['B2 4D 7B 84 E0 1F']);
  await service.getCharacteristic(Characteristic.CoolingThresholdTemperature).handleSetRequest(22);
  await service.getCharacteristic(Characteristic.TargetHeaterCoolerState).handleSetRequest(Characteristic.TargetHeaterCoolerState.AUTO);
  await sleep(450);
  assert.strictEqual(sentBytes(hub).length, 1);
  await service.getCharacteristic(Characteristic.Active).handleSetRequest(1);
  await waitFor(() => sentBytes(hub).length >= 2);
  assert.deepStrictEqual(sentBytes(hub).slice(1), [coolix.hex(coolix.encodeState({mode: 'auto', temp: 22, fan: 'auto'}))]);
  assert.strictEqual(service.getCharacteristic(Characteristic.CurrentHeaterCoolerState).value,
    Characteristic.CurrentHeaterCoolerState.IDLE);
  api.emit('shutdown');
  hub.close();
});

test('rotation speed maps 25/50/75/100 to low/med/high/auto and ignores 0', async () => {
  const {hub, api} = await started({name: 'Aire'});
  const accessory = acAccessory(api);
  const speed = accessory.getService(Service.HeaterCooler).getCharacteristic(Characteristic.RotationSpeed);
  await speed.handleSetRequest(50);
  assert.strictEqual(accessory.context.ac.fan, 'med');
  await speed.handleSetRequest(0);
  await sleep(10);
  assert.strictEqual(accessory.context.ac.fan, 'med');
  assert.strictEqual(speed.value, 50);
  await speed.handleSetRequest(100);
  assert.strictEqual(accessory.context.ac.fan, 'auto');
  assert.strictEqual(requestsOf(hub, CMD.CONTROL).length, 0);
  api.emit('shutdown');
  hub.close();
});

test('the assumed state is persisted in the context and restored after a restart', async () => {
  const {hub, api} = await started({name: 'Aire'});
  const accessory = acAccessory(api);
  const service = accessory.getService(Service.HeaterCooler);
  await Promise.all([
    service.getCharacteristic(Characteristic.Active).handleSetRequest(1),
    service.getCharacteristic(Characteristic.CoolingThresholdTemperature).handleSetRequest(27),
    service.getCharacteristic(Characteristic.RotationSpeed).handleSetRequest(25),
  ]);
  assert.deepStrictEqual(accessory.context.ac, {active: true, mode: 'cool', coolTemp: 27, heatTemp: 24, fan: 'low'});
  assert.ok(api.calls.updated.includes(accessory));
  api.emit('shutdown');
  hub.close();

  const cached = new FakeAccessory('Aire', acUuid);
  cached.context = JSON.parse(JSON.stringify(accessory.context));
  const restarted = await started({name: 'Aire'}, {cached: [cached]});
  assert.ok(!acAccessory(restarted.api));
  const restored = cached.getService(Service.HeaterCooler);
  assert.strictEqual(restored.getCharacteristic(Characteristic.Active).value, 1);
  assert.strictEqual(restored.getCharacteristic(Characteristic.CoolingThresholdTemperature).value, 27);
  assert.strictEqual(restored.getCharacteristic(Characteristic.RotationSpeed).value, 25);
  await restored.getCharacteristic(Characteristic.Active).handleSetRequest(1);
  assert.deepStrictEqual(sentBytes(restarted.hub), [coolix.hex(coolix.encodeState({mode: 'cool', temp: 27, fan: 'low'}))]);
  restarted.api.emit('shutdown');
  restarted.hub.close();
});

test('a restored state outside the configured range or modes is sanitized', async () => {
  const cached = new FakeAccessory('Aire', acUuid);
  cached.context.ac = {active: true, mode: 'heat', coolTemp: 12, heatTemp: 40, fan: 'turbo'};
  const {hub, api} = await started({name: 'Aire', maxTemp: 26}, {cached: [cached]});
  assert.deepStrictEqual(cached.context.ac, {active: true, mode: 'cool', coolTemp: 17, heatTemp: 26, fan: 'auto'});
  api.emit('shutdown');
  hub.close();
});

test('switch names can be customized and empty names keep the default', async () => {
  const names = {swing: 'Oscilar', display: '', sleep: ' Modo noche ', fanOnly: 'Solo ventilador', dry: 'Deshumidificar'};
  const {hub, api} = await started({name: 'Aire', toggles: ['swing', 'display', 'sleep', 'turbo'], extraModes: true, names});
  const switches = acAccessory(api).services.filter(s => s.UUID === Service.Switch.UUID);
  assert.deepStrictEqual(switches.map(s => s.getCharacteristic(Characteristic.Name).value),
    ['Solo ventilador', 'Deshumidificar', 'Oscilar', 'Display', 'Modo noche', 'Turbo']);
  api.emit('shutdown');
  hub.close();
});

test('toggles and extra modes are momentary switches on the AC accessory', async () => {
  const {hub, api} = await started({name: 'Aire', toggles: ['swing', 'display', 'sleep', 'turbo', 'swing'], extraModes: true});
  const accessory = acAccessory(api);
  const switches = accessory.services.filter(s => s.UUID === Service.Switch.UUID);
  assert.deepStrictEqual(switches.map(s => s.getCharacteristic(Characteristic.Name).value),
    ['Fan Only', 'Dry', 'Swing', 'Display', 'Sleep', 'Turbo']);
  for (const toggle of ['swing', 'display', 'sleep', 'turbo']) {
    await accessory.getServiceById(Service.Switch, `toggle-${toggle}`).getCharacteristic(Characteristic.On).handleSetRequest(true);
  }
  await waitFor(() => sentBytes(hub).length >= 4);
  assert.deepStrictEqual(sentBytes(hub),
    ['B2 4D 6B 94 E0 1F', 'B5 4A F5 0A A5 5A', 'B2 4D E0 1F 03 FC', 'B5 4A F5 0A A2 5D']);
  const fanOnly = accessory.getServiceById(Service.Switch, 'fan-only').getCharacteristic(Characteristic.On);
  await fanOnly.handleSetRequest(true);
  fanOnly.value = true;
  await waitFor(() => sentBytes(hub).length >= 5);
  assert.deepStrictEqual(sentBytes(hub).slice(4), ['B2 4D BF 40 E4 1B']);
  assert.strictEqual(accessory.context.ac.mode, 'fan');
  assert.strictEqual(accessory.getService(Service.HeaterCooler).getCharacteristic(Characteristic.Active).value, 1);
  await waitFor(() => fanOnly.value === false, 1500);
  await accessory.getServiceById(Service.Switch, 'dry').getCharacteristic(Characteristic.On).handleSetRequest(true);
  await waitFor(() => sentBytes(hub).length >= 6);
  assert.deepStrictEqual(sentBytes(hub).slice(5), [coolix.hex(coolix.encodeState({mode: 'dry', temp: 24, fan: 'auto'}))]);
  api.emit('shutdown');
  hub.close();
});

test('an ac block without a name (as the config UI saves defaults) creates no AC', async () => {
  const {hub, api} = await started({protocol: 'coolix', heat: false, minTemp: 17, maxTemp: 30});
  assert.strictEqual(api.calls.registered.length, 1);
  assert.ok(!acAccessory(api));
  api.emit('shutdown');
  hub.close();
});

test('removing the ac block unregisters the AC accessory; unknown protocol and toggles are rejected', async () => {
  const hub = await fakeHub();
  const api = fakeApi();
  const logger = recordingLog();
  const cached = new FakeAccessory('Aire', acUuid);
  cached.addService(Service.Switch, 'Old', 'toggle-swing');
  launch(api, {name: 'Aire', protocol: 'nec'}, hub.port, {cached: [cached], logger});
  assert.deepStrictEqual(api.calls.unregistered, [cached]);
  assert.ok(logger.lines.error.some(line => /AC protocol nec is not supported \(only coolix\)/.test(line)));
  api.emit('shutdown');

  const api2 = fakeApi();
  const cached2 = new FakeAccessory('Aire', acUuid);
  cached2.addService(Service.Switch, 'Old', 'toggle-swing');
  launch(api2, {name: 'Aire', toggles: ['bogus', 'turbo']}, hub.port, {cached: [cached2], logger});
  assert.deepStrictEqual(cached2.services.filter(s => s.UUID === Service.Switch.UUID).map(s => s.subtype), ['toggle-turbo']);
  assert.ok(logger.lines.warn.some(line => /unknown AC toggle bogus/.test(line)));
  api2.emit('shutdown');
  hub.close();
});

test('an unreachable hub fails the AC write with SERVICE_COMMUNICATION_FAILURE', async () => {
  const api = fakeApi();
  launch(api, {name: 'Aire'}, 1);
  const service = acAccessory(api).getService(Service.HeaterCooler);
  const failed = error => (error?.hapStatus ?? error) === hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE;
  await assert.rejects(service.getCharacteristic(Characteristic.Active).handleSetRequest(1), failed);
  await assert.rejects(service.getCharacteristic(Characteristic.CurrentTemperature).handleGetRequest(), failed);
  api.emit('shutdown');
});
