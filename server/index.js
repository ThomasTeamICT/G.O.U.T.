import express from 'express';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sessionMiddleware, authRouter } from './auth.js';
import { proxyRouter } from './proxy.js';
import { routesRouter, sharedRouter } from './api/routes.js';
import { activitiesRouter } from './api/activities.js';
import { statsRouter } from './api/stats.js';
import { discoverRouter } from './api/discover.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: '25mb' }));
app.use(sessionMiddleware);

app.use('/api/auth', authRouter);
app.use('/api', proxyRouter);
app.use('/api/routes', routesRouter);
app.use('/api/shared', sharedRouter);
app.use('/api/activities', activitiesRouter);
app.use('/api/stats', statsRouter);
app.use('/api/discover', discoverRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Onbekend endpoint' }));

// Productie: gebouwde frontend serveren.
const dist = join(__dirname, '..', 'web', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist, { maxAge: '1h', index: 'index.html' }));
  app.get('*', (_req, res) => res.sendFile(join(dist, 'index.html')));
}

// Nette JSON-fout in plaats van een HTML-stacktrace.
app.use((err, _req, res, _next) => {
  console.error(err);
  res.status(err.status || 500).json({ error: 'Er ging iets mis op de server.' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`G.O.U.T. draait op http://localhost:${PORT}`);
});
