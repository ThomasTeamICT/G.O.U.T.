import express from 'express';
import { gzipSync, gzip as gzipCb } from 'node:zlib';
import { promisify } from 'node:util';
import { join, dirname } from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { sessionMiddleware, authRouter } from './auth.js';
import { proxyRouter } from './proxy.js';
import { routesRouter, sharedRouter } from './api/routes.js';
import { activitiesRouter } from './api/activities.js';
import { statsRouter } from './api/stats.js';
import { discoverRouter } from './api/discover.js';
import { highlightsRouter } from './api/highlights.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.set('trust proxy', 1);

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: '25mb' }));

// Gzip voor JSON-antwoorden (tracks van lange routes zijn honderden kB's):
// scheelt ~80% over trage verbindingen. zlib zit ingebouwd — geen dependency.
const gzipAsync = promisify(gzipCb);
app.use((req, res, next) => {
  const accepteert = String(req.headers['accept-encoding'] || '').includes('gzip');
  if (!accepteert) return next();
  const origJson = res.json.bind(res);
  res.json = (body) => {
    const buf = Buffer.from(JSON.stringify(body));
    if (buf.length < 1024) return origJson(body);
    const zetHeaders = () => {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Vary', 'Accept-Encoding');
    };
    // Grote payloads (lange tracks) async comprimeren zodat gzip de event loop
    // niet blokkeert (gemeten tot ~800 ms bij 6 MB). Kleintjes blijven sync voor
    // de laagste latentie. Fouten netjes naar de error-handler via next(err).
    if (buf.length >= 256 * 1024) {
      gzipAsync(buf).then((gz) => {
        if (res.headersSent) return;
        zetHeaders();
        res.send(gz);
      }).catch(next);
      return res;
    }
    zetHeaders();
    return res.send(gzipSync(buf));
  };
  next();
});
app.use(sessionMiddleware);

app.use('/api/auth', authRouter);
app.use('/api', proxyRouter);
app.use('/api/routes', routesRouter);
app.use('/api/shared', sharedRouter);
app.use('/api/activities', activitiesRouter);
app.use('/api/stats', statsRouter);
app.use('/api/discover', discoverRouter);
app.use('/api/highlights', highlightsRouter);

app.use('/api', (_req, res) => res.status(404).json({ error: 'Onbekend endpoint' }));

// Productie: gebouwde frontend serveren.
const dist = join(__dirname, '..', 'web', 'dist');
if (existsSync(dist)) {
  app.use(express.static(dist, {
    index: 'index.html',
    setHeaders(res, pad) {
      if (/[\\/]assets[\\/]/.test(pad)) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      } else {
        res.setHeader('Cache-Control', 'no-cache'); // index.html: altijd even checken
      }
    },
  }));
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
