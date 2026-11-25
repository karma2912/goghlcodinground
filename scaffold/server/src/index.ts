import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { initialise } from './health.js';
import { OutboxWorker } from './outbox/worker.js';
import { attachRealtime } from './realtime/server.js';

const app = createApp();

// A plain http server; /ws upgrades are attached to it below.
const server = createServer(app);
server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);
});

// /healthz answers 503 until indexes exist and the realtime hub listens.
// The outbox starts after that; on start it also picks up replies left
// pending by a crash (ours or another instance's), because leases expire.
void initialise({
  beforeReady: async () => {
    await attachRealtime(server);
  },
}).then(() => {
  const worker = new OutboxWorker();
  worker.start();
  console.log(`outbox worker ${worker.id} started`);
});
