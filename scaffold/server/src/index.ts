import { createServer } from 'node:http';
import { createApp } from './app.js';
import { config } from './config.js';
import { initialise } from './health.js';

const app = createApp();

// A plain http server, so WebSockets can be attached to it later.
const server = createServer(app);
server.listen(config.port, () => {
  console.log(`server on http://localhost:${config.port}`);
});

// /healthz answers 503 until this finishes.
void initialise();
