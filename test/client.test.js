const {test} = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const {TuyaClient} = require('../dist/client');
const {CMD} = require('../dist/protocol');
const {KEY, ID, fakeHub, requestsOf, waitFor} = require('./helpers');

const client = (port, options = {}) =>
  new TuyaClient({host: '127.0.0.1', port, id: ID, localKey: KEY, minBackoffMs: 20, maxBackoffMs: 80, ...options});

const connected = c => new Promise(resolve => c.once('connect', resolve));

test('query sends cmd 10 without the 3.3 header and returns the dps', async () => {
  const hub = await fakeHub();
  const c = client(hub.port);
  c.start();
  await connected(c);
  assert.deepStrictEqual(await c.query(), {101: 296, 102: 63});
  const [request] = requestsOf(hub, CMD.DP_QUERY);
  assert.notStrictEqual(request.raw.subarray(0, 3).toString(), '3.3');
  assert.deepStrictEqual(Object.keys(request.message.data).sort(), ['devId', 'gwId', 't', 'uid']);
  c.stop();
  hub.close();
});

test('set sends cmd 7 with the 3.3 header, and pushed STATUS frames arrive as dps events', async () => {
  const hub = await fakeHub();
  const c = client(hub.port);
  const events = [];
  c.on('dps', (dps, cmd) => events.push({dps, cmd}));
  c.start();
  await connected(c);
  await c.set({201: '{"control":"study"}'});
  const [request] = requestsOf(hub, CMD.CONTROL);
  assert.strictEqual(request.raw.subarray(0, 3).toString(), '3.3');
  assert.deepStrictEqual(request.message.data.dps, {201: '{"control":"study"}'});
  hub.push({202: 'AAAABBBB'});
  await waitFor(() => events.some(e => e.dps[202] === 'AAAABBBB'));
  assert.ok(events.every(e => e.cmd === CMD.STATUS));
  c.stop();
  hub.close();
});

test('concurrent requests share one connection and one in-flight request', async () => {
  const hub = await fakeHub();
  const c = client(hub.port);
  c.start();
  await connected(c);
  await Promise.all([c.query(), c.set({201: 'a'}), c.query(), c.set({201: 'b'})]);
  assert.deepStrictEqual(hub.state.requests.filter(r => r.cmd !== CMD.HEART_BEAT).map(r => r.cmd), [10, 7, 10, 7]);
  assert.strictEqual(hub.state.connections, 1);
  c.stop();
  hub.close();
});

test('heartbeats are sent on the open connection', async () => {
  const hub = await fakeHub();
  const c = client(hub.port, {heartbeatMs: 30});
  c.start();
  await waitFor(() => requestsOf(hub, CMD.HEART_BEAT).length >= 2);
  assert.strictEqual(hub.state.connections, 1);
  c.stop();
  hub.close();
});

test('a silent device is dropped after missed heartbeats, and requests time out', async () => {
  const hub = await fakeHub({silent: true});
  const c = client(hub.port, {heartbeatMs: 30, timeoutMs: 50});
  c.start();
  await connected(c);
  await assert.rejects(c.query(), /timeout/);
  await waitFor(() => hub.state.connections >= 2, 3000);
  c.stop();
  hub.close();
});

test('a dropped connection reconnects and never opens a second one', async () => {
  const hub = await fakeHub();
  const c = client(hub.port);
  let disconnects = 0;
  c.on('disconnect', () => disconnects++);
  c.start();
  await connected(c);
  await c.query();
  hub.drop();
  await waitFor(() => disconnects === 1);
  await assert.rejects(c.query(), /not connected/);
  await connected(c);
  assert.deepStrictEqual(await c.query(), {101: 296, 102: 63});
  assert.strictEqual(hub.state.connections, 2);
  assert.strictEqual(hub.state.maxOpen, 1);
  c.stop();
  hub.close();
});

test('reconnect backoff doubles up to the cap and resets once the device answers', async () => {
  const blocker = net.createServer();
  await new Promise(resolve => blocker.listen(0, '127.0.0.1', resolve));
  const port = blocker.address().port;
  await new Promise(resolve => blocker.close(resolve));
  const c = client(port, {minBackoffMs: 10, maxBackoffMs: 40});
  c.start();
  await waitFor(() => c.nextBackoffMs === 40);
  const defaults = new TuyaClient({host: '127.0.0.1', id: ID, localKey: KEY});
  assert.strictEqual(defaults.nextBackoffMs, 2000);
  assert.strictEqual(defaults.port, 6668);
  const hub = await fakeHub();
  c.stop();
  const d = client(hub.port, {minBackoffMs: 10, maxBackoffMs: 40});
  d.start();
  await connected(d);
  await d.query();
  assert.strictEqual(d.nextBackoffMs, 10);
  d.stop();
  hub.close();
});

test('a rejected command (non-zero return code) is an error, and the client keeps working', async () => {
  const hub = await fakeHub({controlRetcode: 1});
  const c = client(hub.port);
  c.start();
  await connected(c);
  await assert.rejects(c.set({201: 'x'}), /retcode 1/);
  assert.deepStrictEqual(await c.query(), {101: 296, 102: 63});
  c.stop();
  hub.close();
});
