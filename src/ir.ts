export const DP_IR_SEND = '201';
export const DP_IR_STUDY_CODE = '202';

export const SEND_DELAY_MS = 300;

export function sendIr(code: string): string {
  return JSON.stringify({control: 'send_ir', head: '', key1: '1' + code, type: 0, delay: SEND_DELAY_MS});
}

export function studyStart(): string {
  return JSON.stringify({control: 'study'});
}

export function studyExit(): string {
  return JSON.stringify({control: 'study_exit'});
}

export function isBase64(code: string): boolean {
  return code.length > 0 && code.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(code);
}
