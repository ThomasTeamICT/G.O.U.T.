// Eén plek waar DB-rijen (snake_case) naar API-vormen (camelCase) gaan,
// zodat routes-, ontdek- en deel-endpoints exact dezelfde JSON teruggeven.

import { db } from './db.js';
import { preview as computePreview } from './geo.js';

function likesFor(routeId, viewerId) {
  const likes = db.prepare('SELECT COUNT(*) AS c FROM route_likes WHERE route_id = ?').get(routeId).c;
  const liked = viewerId
    ? !!db.prepare('SELECT 1 AS x FROM route_likes WHERE route_id = ? AND user_id = ?').get(routeId, viewerId)
    : false;
  return { likes, liked };
}

function previewOf(row) {
  if (row.preview) { try { return JSON.parse(row.preview); } catch { /* herbereken */ } }
  try { return computePreview(JSON.parse(row.track)); } catch { return []; }
}

export function routeSummary(row, viewerId = null) {
  const { likes, liked } = likesFor(row.id, viewerId);
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
