// Mini-BRouter voor lokale ontwikkeling/tests zonder internet:
// interpoleert rechte lijnen tussen de gevraagde punten met een
// licht golvend hoogteprofiel, in hetzelfde GeoJSON-formaat als BRouter.
import http from 'node:http';

const PORT = Number(process.env.MOCK_BROUTER_PORT || 17777);

function segment(a, b, n) {
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const lon = a[0] + (b[0] - a[0]) * t;
    const lat = a[1] + (b[1] - a[1]) * t;
    const ele = 20 + 15 * Math.sin(lon * 900) + 10 * Math.cos(lat * 700);
    pts.push([lon, lat, Math.round(ele * 10) / 10]);
  }
  return pts;
}

http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x');

  // Custom-profielupload (zoals brouter.de/brouter/profile)
  if (req.method === 'POST' && url.pathname.endsWith('/profile')) {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(body.includes('assign') ? { profileid: 'custom_mock1' } : { error: 'ongeldig profiel' }));
    });
    return;
  }

  // Nep-Overpass (zet OVERPASS_URL=http://localhost:17777/overpass)
  if (url.pathname === '/overpass' && req.method === 'POST') {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ elements: [
        { type: 'way', id: 1, geometry: [
          { lat: 50.90, lon: 4.30 }, { lat: 50.92, lon: 4.25 }, { lat: 50.93, lon: 4.20 }] },
        { type: 'way', id: 2, geometry: [
          { lat: 50.93, lon: 4.20 }, { lat: 50.95, lon: 4.15 }, { lat: 50.96, lon: 4.10 }] },
      ] }));
    });
    return;
  }

  // Nep-Waymarked-Trails (zet WMT_BASE=http://localhost:17777/wmt/{site})
  if (url.pathname.includes('/wmt/')) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (url.pathname.includes('/list/search')) {
      res.end(JSON.stringify({ results: [
        { id: 901, name: 'GR 12 Amsterdam - Parijs', ref: 'GR12', group: 'NAT' },
        { id: 902, name: 'Via Turonensis (Parijs - Tours)', ref: null, group: 'INT' },
      ] }));
    } else if (url.pathname.includes('/geometry/geojson')) {
      res.end(JSON.stringify({ type: 'MultiLineString', coordinates: [
        [[4.30, 50.90], [4.25, 50.92], [4.20, 50.93]],
        [[4.20, 50.93], [4.15, 50.95], [4.10, 50.96]],
      ] }));
    } else if (url.pathname.match(/relation\/\d+$/)) {
      res.end(JSON.stringify({ name: 'Via Turonensis (Parijs - Tours)', ref: null }));
    } else {
      res.end('{}');
    }
    return;
  }

  const lonlats = (url.searchParams.get('lonlats') || '')
    .split('|').map((p) => p.split(',').map(Number));
  if (lonlats.length < 2 || lonlats.some((p) => p.some(Number.isNaN))) {
    res.writeHead(400); res.end('bad lonlats'); return;
  }
  let coords = [];
  for (let i = 1; i < lonlats.length; i++) {
    const seg = segment(lonlats[i - 1], lonlats[i], 24);
    coords = coords.concat(i === 1 ? seg : seg.slice(1));
  }
  let dist = 0;
  for (let i = 1; i < coords.length; i++) {
    const dx = (coords[i][0] - coords[i - 1][0]) * 71500;
    const dy = (coords[i][1] - coords[i - 1][1]) * 111320;
    dist += Math.hypot(dx, dy);
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    type: 'FeatureCollection',
    features: [{
      type: 'Feature',
      properties: {
        'track-length': String(Math.round(dist)),
        'filtered ascend': '42',
        'plain-ascend': '40',
      },
      geometry: { type: 'LineString', coordinates: coords },
    }],
  }));
}).listen(PORT, () => console.log(`mock-brouter op http://localhost:${PORT}`));
