import { Logger } from '@nestjs/common';
import { createApp } from './app.js';
import { loadConfig } from './config.js';

const config = loadConfig();
const app = await createApp(config);
await app.listen(config.API_PORT);
new Logger('Bootstrap').log(
  `API TCHOP LIFE (mode ${config.API_MODE}) sur http://localhost:${config.API_PORT}/api`,
);
