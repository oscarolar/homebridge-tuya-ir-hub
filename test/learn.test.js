const {test} = require('node:test');
const assert = require('node:assert');
const {execFile} = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const {parseArgs} = require('../dist/learn');
const {CMD} = require('../dist/protocol');
const {KEY, ID, fakeHub, requestsOf} = require('./helpers');

const CLI = path.join(__dirname, '..', 'dist', 'learn.js');
const CODE = 'AAECAwQFBgc=';

function run(args, env = {TUYA_LOCAL_KEY: KEY}) {
  return new Promise(resolve => execFile(process.execPath, [CLI, ...args], {env: {...process.env, ...env}},
    (error, stdout, stderr) => resolve({code: error ? error.code : 0, stdout, stderr})));
}

const controls = hub => requestsOf(hub, CMD.CONTROL).map(r => JSON.parse(r.message.data.dps['201']));

test('arguments: required ip/id, defaults, and the local key never comes from argv', () => {
  assert.deepStrictEqual(parseArgs(['--ip', '10.0.0.2', '--id', ID]),
    {ip: '10.0.0.2', id: ID, port: 6668, timeout: 30, send: undefined, status: false});
  assert.match(parseArgs(['--ip', '10.0.0.2']), /required/);
  assert.match(parseArgs(['--ip', '10.0.0.2', '--id', ID, '--key', KEY]), /Unknown argument --key/);
  assert.match(parseArgs(['--ip', '10.0.0.2', '--id', ID, '--send', 'no!']), /base64/);
  assert.strictEqual(parseArgs(['--ip', '1', '--id', ID, '--status']).status, true);
});

test('the CLI binary starts with a shebang', () => {
  assert.ok(fs.readFileSync(CLI, 'utf8').startsWith('#!/usr/bin/env node\n'));
});

test('without TUYA_LOCAL_KEY the CLI refuses to run', async () => {
  const result = await run(['--ip', '127.0.0.1', '--id', ID, '--status'], {TUYA_LOCAL_KEY: ''});
  assert.strictEqual(result.code, 2);
  assert.match(result.stderr, /TUYA_LOCAL_KEY/);
});

test('--status prints the current dps once', async () => {
  const hub = await fakeHub();
  const result = await run(['--ip', '127.0.0.1', '--port', String(hub.port), '--id', ID, '--status']);
  assert.strictEqual(result.code, 0, result.stderr);
  assert.deepStrictEqual(JSON.parse(result.stdout), {101: 296, 102: 63});
  hub.close();
});

test('--send fires one learned code', async () => {
  const hub = await fakeHub();
  const result = await run(['--ip', '127.0.0.1', '--port', String(hub.port), '--id', ID, '--send', CODE]);
  assert.strictEqual(result.code, 0, result.stderr);
  assert.deepStrictEqual(controls(hub), [{control: 'send_ir', head: '', key1: '1' + CODE, type: 0, delay: 300}]);
  hub.close();
});

test('learn mode prints each code reported on DP 202 and exits study mode on timeout', async () => {
  const hub = await fakeHub({onControl: dps => JSON.parse(dps['201']).control === 'study' ? {202: CODE} : null});
  const result = await run(['--ip', '127.0.0.1', '--port', String(hub.port), '--id', ID, '--timeout', '0.5']);
  assert.strictEqual(result.code, 0, result.stderr);
  assert.deepStrictEqual(result.stdout.trim().split('\n').map(line => JSON.parse(line)), [{code: CODE}]);
  assert.deepStrictEqual(controls(hub).map(c => c.control), ['study_exit', 'study', 'study_exit']);
  assert.ok(!result.stdout.includes(KEY) && !result.stderr.includes(KEY));
  hub.close();
});
