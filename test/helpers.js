const net = require('node:net');
const hap = require('@homebridge/hap-nodejs');
const protocol = require('../dist/protocol');

const KEY = '0123456789abcdef';
const ID = 'ebdeadbeef0123456789ab';

function deviceFrame(seq, cmd, body, {retcode = 0, header = false, key = KEY} = {}) {
  const parts = [];
  if (retcode !== null) {
    const code = Buffer.alloc(4);
    code.writeUInt32BE(retcode);
    parts.push(code);
  }
  if (body !== null) {
    if (header) {
      parts.push(Buffer.from('3.3'), Buffer.alloc(12));
    }
    parts.push(protocol.encrypt(key, Buffer.from(JSON.stringify(body))));
  }
  return protocol.encodeFrame(seq, cmd, Buffer.concat(parts));
}

function fakeHub({dps = {101: 296, 102: 63}, onControl, silent = false, controlRetcode = 0} = {}) {
  const state = {requests: [], connections: 0, open: 0, maxOpen: 0, dps: {...dps}};
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    state.connections++;
    state.open++;
    state.maxOpen = Math.max(state.maxOpen, state.open);
    socket.on('close', () => {
      sockets.delete(socket);
      state.open--;
    });
    socket.on('error', () => undefined);
    const parser = new protocol.FrameParser();
    socket.on('data', chunk => {
      for (const frame of parser.push(chunk)) {
        const message = protocol.decodePayload(KEY, frame.payload, false);
        const raw = frame.payload;
        state.requests.push({cmd: frame.cmd, seq: frame.seq, message, raw});
        if (silent) {
          continue;
        }
        if (frame.cmd === protocol.CMD.DP_QUERY) {
          socket.write(deviceFrame(frame.seq, frame.cmd, {devId: ID, dps: state.dps}));
        } else if (frame.cmd === protocol.CMD.HEART_BEAT) {
          socket.write(deviceFrame(frame.seq, frame.cmd, null));
        } else if (frame.cmd === protocol.CMD.CONTROL) {
          socket.write(deviceFrame(frame.seq, frame.cmd, null, {retcode: controlRetcode}));
          if (controlRetcode) {
            continue;
          }
          const reply = onControl ? onControl(message.data.dps) : message.data.dps;
          if (reply) {
            socket.write(deviceFrame(0, protocol.CMD.STATUS, {devId: ID, dps: reply, t: 1}, {header: true}));
          }
        }
      }
    });
  });
  const push = dps => sockets.forEach(socket =>
    socket.write(deviceFrame(0, protocol.CMD.STATUS, {devId: ID, dps, t: 1}, {header: true})));
  const drop = () => sockets.forEach(socket => socket.destroy());
  return new Promise(resolve => server.listen(0, '127.0.0.1', () =>
    resolve({state, port: server.address().port, push, drop, close: () => {
      drop();
      server.close();
    }})));
}

const requestsOf = (hub, cmd) => hub.state.requests.filter(r => r.cmd === cmd);

const log = {debug() {}, info() {}, warn() {}, error() {}};

function recordingLog() {
  const lines = {debug: [], info: [], warn: [], error: []};
  const record = level => message => lines[level].push(message);
  return {lines, debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error')};
}

async function waitFor(condition, timeoutMs = 2000) {
  const end = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > end) {
      throw new Error('timed out waiting for condition');
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

class FakeAccessory {
  constructor(displayName, UUID) {
    this.displayName = displayName;
    this.UUID = UUID;
    this.context = {};
    this.services = [new hap.Service.AccessoryInformation()];
  }

  getService(type) {
    return this.services.find(s => s.UUID === type.UUID);
  }

  getServiceById(type, subtype) {
    return this.services.find(s => s.UUID === type.UUID && s.subtype === subtype);
  }

  addService(type, name, subtype) {
    const service = new type(name, subtype);
    this.services.push(service);
    return service;
  }

  removeService(service) {
    this.services = this.services.filter(s => s !== service);
  }
}

function fakeApi() {
  const calls = {registered: [], unregistered: [], updated: []};
  const listeners = {};
  const api = {
    hap,
    calls,
    platformAccessory: FakeAccessory,
    on(event, listener) {
      (listeners[event] ??= []).push(listener);
      return api;
    },
    emit(event) {
      (listeners[event] ?? []).forEach(listener => listener());
    },
    registerPlatformAccessories: (plugin, platform, accessories) => calls.registered.push(...accessories),
    unregisterPlatformAccessories: (plugin, platform, accessories) => calls.unregistered.push(...accessories),
    updatePlatformAccessories: accessories => calls.updated.push(...accessories),
  };
  return api;
}

module.exports = {KEY, ID, deviceFrame, fakeHub, requestsOf, log, recordingLog, waitFor, FakeAccessory, fakeApi, hap};
