// Eén plek waar DB-rijen (snake_case) naar API-vormen (camelCase) gaan,
// zodat routes-, ontdek- en deel-endpoints exact dezelfde JSON teruggeven.

import { db } from './db.js';
import { preview as computePreview } from './geo.js';

// Smalle kolomlijsten voor lijst-/ontdek-endpoints: exact de velden die de
// summary-serializers lezen, ZONDER de zware track- en gpx-blobs (die per rij
// materialiseren was gemeten ~87x trager). Preview + scalairen volstaan.
export const ROUTE_SUMMARY_COLUMNS =
  'r.id, r.user_id, r.name, r.sport, r.distance_m, r.ascent_m, r.descent_m, ' +
  'r.duration_s, r.difficulty, r.region, r.visibility, r.share_token, r.source, ' +
  'r.curated, r.start_lat, r.start_lon, r.bbox, r.preview, r.created_at, r.updated_at';
export const ACTIVITY_SUMMARY_COLUMNS =
  'id, name, sport, distance_m, ascent_m, descent_m, moving_s, elapsed_s, ' +
  'started_at, region, route_id, preview, created_at';

function likedByViewer(routeId, viewerId) {
  return viewerId
    ? !!db.prepare('SELECT 1 AS x FROM route_likes WHERE route_id = ? AND user_id = ?').get(routeId, viewerId)
    : false;
}

function likesFor(routeId, viewerId) {
  const likes = db.prepare('SELECT COUNT(*) AS c FROM route_likes WHERE route_id = ?').get(routeId).c;
  return { likes, liked: likedByViewer(routeId, viewerId) };
}

function previewOf(row) {
  if (row.preview) { try { return JSON.parse(row.preview); } catch { /* herbereken */ } }
  try { return computePreview(JSON.parse(row.track)); } catch { return []; }
}

// Previews worden bij create/update/import altijd bewaard. De lijst-endpoints
// halen de track-blob niet meer op, dus voor eventuele legacy-rijen (of tests)
// zonder preview haalt deze helper de track eenmalig apart op, berekent de
// preview en bewaart die (self-healing backfill); daarna gebruikt de serializer
// gewoon row.preview. Vaste prepared statements per tabel (geen dynamische SQL).
const PREVIEW_SQL = {
  routes: { sel: 'SELECT track FROM routes WHERE id = ?', upd: 'UPDATE routes SET preview = ? WHERE id = ?' },
  activities: { sel: 'SELECT track FROM activities WHERE id = ?', upd: 'UPDATE activities SET preview = ? WHERE id = ?' },
};

export function ensurePreviews(table, rows) {
  const q = PREVIEW_SQL[table];
  if (!q) return;
  let sel, upd;
  for (const row of rows) {
    if (row.preview) continue;
    if (!sel) { sel = db.prepare(q.sel); upd = db.prepare(q.upd); }
    const t = sel.get(row.id);
    if (!t || t.track == null) continue;
    let pv;
    try { pv = JSON.stringify(computePreview(JSON.parse(t.track))); } catch { continue; }
    upd.run(pv, row.id);
    row.preview = pv;
  }
}

export function routeSummary(row, viewerId = null, likeCount = undefined) {
  const { likes, liked } = likeCount === undefined
    ? likesFor(row.id, viewerId)
    : { likes: likeCount, liked: likedByViewer(row.id, viewerId) };
  return {
    id: row.id,
    name: row.name,
    sport: row.sport,
    distanceM: row.distance_m,
    ascentM: row.ascent_m,
    descentM: row.descent_m,
    durationS: row.duration_s,
    difficulty: row.difficulty,
    region: row.region,
    visibility: row.visibility,
    shareToken: viewerId != null && viewerId === row.user_id ? row.share_token : null,
    likes,
    liked,
    isOwner: viewerId != null && viewerId === row.user_id,
    ownerName: row.owner_name ?? undefined,
    source: row.source,
    curated: !!row.curated,
    startLat: row.start_lat,
    startLon: row.start_lon,
    bbox: row.bbox ? JSON.parse(row.bbox) : null,
    preview: previewOf(row),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function routeFull(row, viewerId = null) {
  return {
    ...routeSummary(row, viewerId),
    description: row.description,
    waypoints: row.waypoints ? JSON.parse(row.waypoints) : null,
    track: JSON.parse(row.track),
  };
}

export function activitySummary(row) {
  return {
    id: row.id,
    name: row.name,
    sport: row.sport,
    distanceM: row.distance_m,
    ascentM: row.ascent_m,
    descentM: row.descent_m,
    movingS: row.moving_s,
    elapsedS: row.elapsed_s,
    startedAt: row.started_at,
    region: row.region,
    routeId: row.route_id,
    preview: previewOf(row),
    createdAt: row.created_at,
  };
}

export function activityFull(row) {
  return {
    ...activitySummary(row),
    track: JSON.parse(row.track),
  };
}

export function highlightSummary(row, viewerId = null) {
  const votes = db.prepare('SELECT COUNT(*) AS c FROM highlight_votes WHERE highlight_id = ?').get(row.id).c;
  const voted = viewerId
    ? !!db.prepare('SELECT 1 AS x FROM highlight_votes WHERE highlight_id = ? AND user_id = ?').get(row.id, viewerId)
    : false;
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    sport: row.sport,
    category: row.category ?? null,
    track: JSON.parse(row.track),
    startLat: row.start_lat,
    startLon: row.start_lon,
    bbox: row.bbox ? JSON.parse(row.bbox) : null,
    region: row.region,
    votes,
    voted,
    isOwner: viewerId != null && viewerId === row.user_id,
    ownerName: row.owner_name ?? undefined,
    createdAt: row.created_at,
  };
}
