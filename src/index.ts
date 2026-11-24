import {API} from 'homebridge';
import {PLATFORM_NAME, TuyaIRHubPlatform} from './platform';

export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, TuyaIRHubPlatform);
};
