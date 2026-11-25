import express, { type ErrorRequestHandler } from 'express';
import { HttpError } from './errors.js';
import { checkHealth } from './health.js';
import { apiRouter } from './routes/api.js';
import { authRouter } from './routes/auth.js';
import { billingApiRouter, billingGraderRouter, payboxWebhookRouter } from './routes/billing.js';
import { graderRouter } from './routes/grader.js';
import { webhookRouter } from './routes/webhooks.js';

export function createApp(): express.Express {
  const app = express();
  app.disable('x-powered-by');

  // No global body parser: the Pigeon webhook needs the raw body to verify
  // its signature, so each router chooses its own parser.

  app.get('/healthz', async (_req, res) => {
    const health = await checkHealth();
    res.status(health.ok ? 200 : 503).json(health);
  });

  // billing (bonus) first: its paths sit inside the prefixes below
  app.use('/webhooks/paybox', payboxWebhookRouter());
  app.use('/api/billing', billingApiRouter());
  app.use('/__grader/billing', billingGraderRouter());

  app.use('/webhooks', webhookRouter());
  app.use('/auth', authRouter());
  app.use('/api', apiRouter());
  app.use('/__grader', graderRouter());

  app.use((_req, res) => {
    res.status(404).json({ error: 'not found' });
  });

  const onError: ErrorRequestHandler = (err, _req, res, _next) => {
    if (err instanceof HttpError) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    // body-parser errors (malformed JSON, too large) carry a 4xx status
    const status = typeof err?.status === 'number' && err.status >= 400 && err.status < 500 ? err.status : 500;
    if (status === 500) console.error(err);
    res.status(status).json({ error: status === 500 ? 'internal error' : String(err.message) });
  };
  app.use(onError);

  return app;
}
