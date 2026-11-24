const {test} = require('node:test');
const assert = require('node:assert');
const {TuyaHub} = require('../dist/device');
const {CMD} = require('../dist/protocol');
const {KEY, ID, fakeHub, requestsOf, log, waitFor} = require('./helpers');

const config = port => ({name: 'Sala', id: ID, ip: '127.0.0.1', port, localKey: KEY});

test('the hub queries on connect, keeps pushed values and goes offline only after the grace period', async () => {
  const hub = await fakeHub();
  const device = new TuyaHub(config(hub.port), log, {offlineGraceMs: 150, client: {minBackoffMs: 500}});
  const updates = [];
  device.onUpdate(climate => updates.push({...climate, online: device.isOnline}));
  assert.strictEqual(device.isOnline, false);
  device.start();
  await waitFor(() => device.climate.temperature === 29.6);
  assert.strictEqual(device.climate.humidity, 63);
  assert.strictEqual(device.isOnline, true);
  assert.strictEqual(requestsOf(hub, CMD.DP_QUERY).length, 1);

  hub.push({101: 310});
  await waitFor(() => device.climate.temperature === 31);
  hub.push({202: 'AAAA'});

  hub.drop();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.strictEqual(device.isOnline, true);
  await waitFor(() => !device.isOnline);
  await waitFor(() => device.isOnline, 2000);
  const transitions = updates.map(u => u.online).filter((online, i, all) => i === 0 || all[i - 1] !== online);
  assert.deepStrictEqual(transitions, [true, false, true]);
  device.stop();
  hub.close();
});
