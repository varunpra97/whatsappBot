import fs from 'node:fs';
import { CONFIG_PATH, getConfig } from './config.js';
import { loadState } from './state.js';
import { startBot } from './bot.js';
import { startWeb } from './web.js';

if (!fs.existsSync(CONFIG_PATH)) {
  console.warn(`[config] ${CONFIG_PATH} not found; using defaults. Copy config.example.json to config.json to customise.`);
}
getConfig();
loadState();
startWeb();
startBot().catch((err) => {
  console.error('[bot] failed to start:', err);
  process.exit(1);
});

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => process.exit(0));
