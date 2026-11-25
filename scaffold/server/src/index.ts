import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { initialise } from './health.js';
import { OutboxWorker } from './outbox/worker.js';

const app = createApp();

// A plain http server, so WebSockets can be attached to it later.
const server = createServer(app);
server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);
});

// /healthz answers 503 until indexes exist; the outbox starts after that.
// On start it also picks up replies left pending by a crash (ours or another
// instance's), because leases simply expire.
void initialise().then(() => {
  const worker = new OutboxWorker();
  worker.start();
  console.log(`outbox worker ${worker.id} started`);
});
