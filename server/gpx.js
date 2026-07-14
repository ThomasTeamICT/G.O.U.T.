// GPX 1.1 genereren uit een opgeslagen track. Track = [[lon, lat, ele?, t?], ...]

const esc = (s) =>
  String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');

export function buildGpx({ name, description = '', track, sport = '' }) {
  const pts = track
    .map((p) => {
      const ele = typeof p[2] === 'number' && !Number.isNaN(p[2])
        ? `<ele>${Math.round(p[2] * 10) / 10}</ele>` : '';
      const time = typeof p[3] === 'number'
        ? `<time>${new Date(p[3] * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z')}</time>` : '';
      return `      <trkpt lat="${p[1]}" lon="${p[0]}">${ele}${time}</trkpt>`;
    })
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<gpx version="1.1" creator="G.O.U.T. - gewoon op uw tempo"
     xmlns="http://www.topografix.com/GPX/1/1"
     xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
     xsi:schemaLocation="http://www.topografix.com/GPX/1/1 http://www.topografix.com/GPX/1/1/gpx.xsd">
  <metadata>
    <name>${esc(name)}</name>
    ${description ? `<desc>${esc(description)}</desc>` : ''}
  </metadata>
  <trk>
    <name>${esc(name)}</name>
    ${sport ? `<type>${esc(sport)}</type>` : ''}
    <trkseg>
${pts}
    </trkseg>
  </trk>
</gpx>
`;
}

// Veilige bestandsnaam voor Content-Disposition.
export function gpxFilename(name) {
  const base = String(name).normalize('NFKD').replace(/[^\w\s-]/g, '').trim()
    .replace(/\s+/g, '-').slice(0, 60) || 'route';
  return `${base}.gpx`;
}
