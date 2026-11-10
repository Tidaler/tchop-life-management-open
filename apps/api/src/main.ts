import { Logger } from '@nestjs/common';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.API_PORT, config.API_HOST);
new Logger('Bootstrap').log(
  `API TidalEx Resto (mode ${config.API_MODE}) sur http://${config.API_HOST}:${config.API_PORT}/api`,
);
