import { createServer } from 'node:http';
import { config } from './config.js';
import { createPool, migrate } from './db.js';
import { createApp } from './app.js';

const pool = createPool(config.db);
await migrate(pool);
const server = createServer(createApp({ pool, sessionDays: config.sessionDays }));
server.listen(config.port, config.host, () => {
  console.log(`Loan Recovery server on http://${config.host}:${config.port} (db ${config.db.database}@${config.db.host})`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    server.close(() => pool.end().finally(() => process.exit(0)));
    setTimeout(() => process.exit(1), 10000).unref();
  });
}
