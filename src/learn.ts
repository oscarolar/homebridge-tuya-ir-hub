#!/usr/bin/env node
import {DEFAULT_PORT, TuyaClient} from './client';
import {DP_IR_SEND, DP_IR_STUDY_CODE, isBase64, sendIr, studyExit, studyStart} from './ir';

const USAGE = `Usage: TUYA_LOCAL_KEY=<key> tuya-ir-learn --ip <ip> --id <device id> [--timeout 30]
       TUYA_LOCAL_KEY=<key> tuya-ir-learn --ip <ip> --id <device id> --send <base64 code>
       TUYA_LOCAL_KEY=<key> tuya-ir-learn --ip <ip> --id <device id> --status

Learn mode prints one JSON line per learned code: {"code":"<base64>"}.
Stop Homebridge (or this hub's child bridge) first: the hub accepts one connection at a time.`;

const CONNECT_TIMEOUT_MS = 10000;

export interface Options {
  ip: string;
  id: string;
  port: number;
  timeout: number;
  send?: string;
  status: boolean;
}

export function parseArgs(argv: string[]): Options | string {
  const values: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      return USAGE;
    }
    if (arg === '--status') {
      values.status = true;
      continue;
    }
    if (!['--ip', '--id', '--port', '--timeout', '--send'].includes(arg)) {
      return `Unknown argument ${arg}\n\n${USAGE}`;
    }
    const value = argv[++i];
    if (value === undefined || value.startsWith('--')) {
      return `${arg} needs a value\n\n${USAGE}`;
    }
    values[arg.slice(2)] = value;
  }
  if (!values.ip || !values.id) {
    return `--ip and --id are required\n\n${USAGE}`;
  }
  const timeout = Number(values.timeout ?? 30);
  const port = Number(values.port ?? DEFAULT_PORT);
  if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isInteger(port)) {
    return `invalid --timeout or --port\n\n${USAGE}`;
  }
  if (values.send !== undefined && !isBase64(String(values.send))) {
    return '--send needs a base64 learned code';
  }
  return {
    ip: String(values.ip),
    id: String(values.id),
    port,
    timeout,
    send: values.send === undefined ? undefined : String(values.send),
    status: values.status === true,
  };
}

function connect(client: TuyaClient): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`could not connect to ${client.host}:${client.port}`)), CONNECT_TIMEOUT_MS);
    client.once('connect', () => {
      clearTimeout(timer);
      resolve();
    });
    client.start();
  });
}

function learn(client: TuyaClient, timeoutSeconds: number): Promise<void> {
  return new Promise(resolve => {
    let finished = false;
    const finish = async () => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timer);
      process.removeListener('SIGINT', finish);
      await client.set({[DP_IR_SEND]: studyExit()}).catch(() => undefined);
      process.stderr.write('Study mode closed.\n');
      resolve();
    };
    const timer = setTimeout(finish, timeoutSeconds * 1000);
    process.on('SIGINT', finish);
    client.on('dps', dps => {
      const code = dps[DP_IR_STUDY_CODE];
      if (typeof code === 'string' && code) {
        process.stdout.write(JSON.stringify({code}) + '\n');
      }
    });
    client.set({[DP_IR_SEND]: studyExit()}).catch(() => undefined)
      .then(() => client.set({[DP_IR_SEND]: studyStart()}))
      .then(() => process.stderr.write(`Study mode on for ${timeoutSeconds} s: point the remote at the hub and press a button (Ctrl+C to stop).\n`))
      .catch(error => {
        process.stderr.write(`Could not enter study mode: ${(error as Error).message}\n`);
        process.exitCode = 1;
        finish();
      });
  });
}

export async function main(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  const options = parseArgs(argv);
  if (typeof options === 'string') {
    process.stderr.write(options + '\n');
    return options === USAGE ? 0 : 2;
  }
  const localKey = env.TUYA_LOCAL_KEY ?? '';
  if (localKey.length !== 16) {
    process.stderr.write('Set TUYA_LOCAL_KEY to the 16-character local key of the hub.\n');
    return 2;
  }
  const client = new TuyaClient({host: options.ip, port: options.port, id: options.id, localKey, maxBackoffMs: 5000});
  try {
    await connect(client);
    if (options.status) {
      process.stdout.write(JSON.stringify(await client.query()) + '\n');
    } else if (options.send) {
      await client.set({[DP_IR_SEND]: sendIr(options.send)});
      process.stdout.write(JSON.stringify({sent: true}) + '\n');
    } else {
      await learn(client, options.timeout);
    }
    return Number(process.exitCode ?? 0);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 1;
  } finally {
    client.stop();
  }
}

if (require.main === module) {
  main(process.argv.slice(2), process.env).then(code => process.exit(code));
}
