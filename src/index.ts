import { serve } from '@hono/node-server';

import { loadConfig, loadDotEnv, ConfigError } from './config.js';
import { createApp, STARTER_VERSION } from './server.js';

loadDotEnv();

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  if (err instanceof ConfigError) {
    console.error(`[config] ${err.message}`);
    console.error('[config] Run `npm run verify` for a full environment check.');
    process.exit(1);
  }
  throw err;
}

const app = createApp(cfg);
serve({ fetch: app.fetch, port: cfg.port }, (info) => {
  console.log(
    `zennopay-partner-starter v${STARTER_VERSION} listening on :${info.port} ` +
      `(Zennopay API: ${cfg.baseUrl})`,
  );
  if (cfg.webhookSecret === null) {
    console.warn('[config] ZENNOPAY_WEBHOOK_SECRET not set — POST /zennopay/webhook returns 501.');
  }
});
