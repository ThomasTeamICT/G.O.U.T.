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

// 'trust proxy' is configureerbaar via TRUST_PROXY en staat standaard UIT.
// Vroeger stond dit hard op 1: dan vertrouwt Express X-Forwarded-For, waardoor
// een aanvaller met een vervalste header de IP-rate-limiter omzeilt. Zet
// TRUST_PROXY=1 (of een hop-aantal / subnet / 'true') enkel als je écht achter
// een vertrouwde reverse proxy draait.
function parseTrustProxy(v) {
  if (v === undefined || v === '' || v === 'false' || v === '0') return false;
  if (v === 'true') return true;
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 ? n : v; // getal = hop-aantal; anders keyword/subnet
}
app.set('trust proxy', parseTrustProxy(process.env.TRUST_PROXY));

app.disable('x-powered-by');
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  next();
});
app.use(express.json({ limit: '25mb' }));

// --- gzip voor ALLE tekstuele antwoorden (JSON, GPX, /api/routing, én de
// gebouwde frontend + static assets) ---
// Vroeger werd enkel res.json gecomprimeerd; de app-bundel, GPX-downloads en de
// routing-proxy gingen ongecomprimeerd over de lijn (een GPX van 4,5 MB waar
// ~676 kB volstaat). We bufferen daarom res.write/res.end één laag hoger en
// comprimeren op basis van het Content-Type. zlib zit ingebouwd — geen dependency.
const gzipAsync = promisify(gzipCb);
const MIN_GZIP = 1024;                 // kleiner dan 1 kB loont niet
const ASYNC_THRESHOLD = 256 * 1024;    // grote payloads async: event loop niet blokkeren
// Tekstuele/al-niet-gecomprimeerde types; binaire types (png, woff2, ...) slaan we over.
const COMPRESSIBLE = /^(?:text\/|application\/(?:json|xml|javascript|.+\+json|.+\+xml)|image\/svg\+xml)/i;

function compressionMiddleware(req, res, next) {
  const accepteert = String(req.headers['accept-encoding'] || '').includes('gzip');
  if (!accepteert || req.method === 'HEAD') return next();

  const chunks = [];
  let buffering = true;
  const _write = res.write;
  const _end = res.end;

  res.write = function (chunk, enc, cb) {
    if (!buffering) return _write.call(this, chunk, enc, cb);
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
    if (typeof enc === 'function') enc();
    else if (typeof cb === 'function') cb();
    return true;
  };

  res.end = function (chunk, enc, cb) {
    if (!buffering) return _end.call(this, chunk, enc, cb);
    if (typeof chunk === 'function') { cb = chunk; chunk = undefined; enc = undefined; }
    else if (typeof enc === 'function') { cb = enc; enc = undefined; }
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, typeof enc === 'string' ? enc : 'utf8'));
    buffering = false;

    const body = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
    const type = String(res.getHeader('Content-Type') || '');
    const code = res.statusCode;
    const mayGzip =
      !res.getHeader('Content-Encoding') &&
      !res.getHeader('Content-Range') &&    // range-antwoorden nooit herverpakken
      code !== 204 && code !== 304 && code !== 206 &&
      body.length >= MIN_GZIP &&
      COMPRESSIBLE.test(type);

    const restore = () => { res.write = _write; res.end = _end; };

    if (!mayGzip) {
      restore();
      return _end.call(res, body, cb);
    }

    const flush = (gz) => {
      res.setHeader('Content-Encoding', 'gzip');
      res.setHeader('Vary', 'Accept-Encoding');
      res.setHeader('Content-Length', gz.length);
      res.removeHeader('ETag'); // ETag sloeg op de ongecomprimeerde vorm
      restore();
      _end.call(res, gz, cb);
    };

    if (body.length >= ASYNC_THRESHOLD) {
      gzipAsync(body).then(flush).catch(() => {
        // Comprimeren mislukt: stuur ongecomprimeerd door i.p.v. de verbinding te breken.
        try { restore(); _end.call(res, body, cb); } catch { /* al gesloten */ }
      });
      return res;
    }
    flush(gzipSync(body));
    return res;
  };

  next();
}
app.use(compressionMiddleware);
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

// Nette JSON-fout in plaats van een HTML-stacktrace. Zijn de headers al verstuurd
// (bv. een fout die opdook nadat een antwoord al begon), delegeer dan naar de
// standaard-handler i.p.v. res.json nog eens te proberen (dubbele-send-crash).
app.use((err, _req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: 'Er ging iets mis op de server.' });
});

const PORT = Number(process.env.PORT || 3000);
app.listen(PORT, () => {
  console.log(`G.O.U.T. draait op http://localhost:${PORT}`);
});
