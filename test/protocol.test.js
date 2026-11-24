const {test} = require('node:test');
const assert = require('node:assert');
const protocol = require('../dist/protocol');
const {KEY, ID, deviceFrame} = require('./helpers');

test('crc32 is the standard (zlib) CRC-32', () => {
  assert.strictEqual(protocol.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.strictEqual(protocol.crc32(Buffer.alloc(0)), 0);
});

test('a frame is prefix, seq, cmd, length (payload + 8), payload, CRC over everything before it, suffix', () => {
  const payload = Buffer.from('abcdefgh');
  const frame = protocol.encodeFrame(7, 10, payload);
  assert.strictEqual(frame.length, 16 + payload.length + 8);
  assert.strictEqual(frame.readUInt32BE(0), 0x000055aa);
  assert.strictEqual(frame.readUInt32BE(4), 7);
  assert.strictEqual(frame.readUInt32BE(8), 10);
  assert.strictEqual(frame.readUInt32BE(12), payload.length + 8);
  assert.deepStrictEqual(frame.subarray(16, 24), payload);
  assert.strictEqual(frame.readUInt32BE(24), protocol.crc32(frame.subarray(0, 24)));
  assert.strictEqual(frame.readUInt32BE(28), 0x0000aa55);
});

test('AES-128-ECB with PKCS7 round-trips and pads a full block with another block', () => {
  const plain = Buffer.from('0123456789ABCDEF');
  const cipher = protocol.encrypt(KEY, plain);
  assert.strictEqual(cipher.length, 32);
  assert.deepStrictEqual(protocol.decrypt(KEY, cipher), plain);
  assert.throws(() => protocol.encrypt('short', plain), /16 characters/);
});

test('DP_QUERY (cmd 10) payload is the bare ciphertext, without the 3.3 header', () => {
  const body = protocol.queryBody(ID, '1700000000');
  assert.deepStrictEqual(body, {gwId: ID, devId: ID, uid: ID, t: '1700000000'});
  const payload = protocol.encodePayload(protocol.CMD.DP_QUERY, KEY, body);
  assert.notStrictEqual(payload.subarray(0, 3).toString(), '3.3');
  assert.strictEqual(payload.length % 16, 0);
  assert.deepStrictEqual(JSON.parse(protocol.decrypt(KEY, payload)), body);
});

test('CONTROL (cmd 7) payload is "3.3" + 12 zero bytes + ciphertext', () => {
  const body = protocol.controlBody(ID, {201: 'x'}, '1700000000');
  assert.deepStrictEqual(body, {devId: ID, uid: ID, t: '1700000000', dps: {201: 'x'}});
  const payload = protocol.encodePayload(protocol.CMD.CONTROL, KEY, body);
  assert.strictEqual(payload.subarray(0, 3).toString(), '3.3');
  assert.deepStrictEqual(payload.subarray(3, 15), Buffer.alloc(12));
  assert.deepStrictEqual(JSON.parse(protocol.decrypt(KEY, payload.subarray(15))), body);
  assert.deepStrictEqual(protocol.decodePayload(KEY, payload, false).data, body);
});

test('device payloads: return code, optional 3.3 header, empty acks and plaintext errors', () => {
  const parse = frame => protocol.decodePayload(KEY, new protocol.FrameParser().push(frame)[0].payload);
  const queryReply = parse(deviceFrame(1, 10, {dps: {101: 296, 102: 63}}));
  assert.deepStrictEqual(queryReply, {retcode: 0, data: {dps: {101: 296, 102: 63}}});
  const status = parse(deviceFrame(0, 8, {devId: ID, dps: {202: 'AAAA'}}, {header: true}));
  assert.deepStrictEqual(protocol.dpsOf(status), {202: 'AAAA'});
  const pushNoRetcode = parse(deviceFrame(0, 8, {dps: {101: 250}}, {retcode: null, header: true}));
  assert.deepStrictEqual(pushNoRetcode, {data: {dps: {101: 250}}});
  assert.deepStrictEqual(parse(deviceFrame(2, 7, null)), {retcode: 0});
  assert.deepStrictEqual(parse(deviceFrame(2, 7, null, {retcode: 1})), {retcode: 1});
  const text = protocol.encodeFrame(3, 10, Buffer.concat([Buffer.alloc(4), Buffer.from('json obj data unvalid')]));
  assert.deepStrictEqual(parse(text), {retcode: 0, text: 'json obj data unvalid'});
});

test('the frame parser handles split chunks, several frames per chunk, garbage and bad CRCs', () => {
  const a = deviceFrame(1, 10, {dps: {101: 1}});
  const b = deviceFrame(2, 8, {dps: {102: 2}}, {header: true});
  const corrupt = Buffer.from(deviceFrame(3, 8, {dps: {102: 3}}));
  corrupt[20] ^= 0xff;
  const stream = Buffer.concat([Buffer.from([1, 2, 3]), a, corrupt, b]);
  const parser = new protocol.FrameParser();
  const frames = [];
  for (let i = 0; i < stream.length; i += 7) {
    frames.push(...parser.push(stream.subarray(i, i + 7)));
  }
  assert.deepStrictEqual(frames.map(f => [f.seq, f.cmd]), [[1, 10], [2, 8]]);
  assert.deepStrictEqual(protocol.dpsOf(protocol.decodePayload(KEY, frames[1].payload)), {102: 2});
});
