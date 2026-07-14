// Gedeelde types voor API-payloads.

export type Sport = 'wandelen' | 'fietsen' | 'mtb';
export type Difficulty = 'makkelijk' | 'gemiddeld' | 'zwaar';

export interface User {
  id: number;
  email: string;
  name: string;
  avatarColor: string;
}

// Track-punt: [lon, lat, ele?, epochSeconden?]
export type TrackPoint = [number, number, number?, number?];
// Waypoint van de planner: beeline = hemelsbreed segment NAAR dit punt.
export interface Waypoint { lon: number; lat: number; beeline?: boolean }

export interface RouteSummary {
  id: number;
  name: string;
  sport: Sport;
  distanceM: number;
  ascentM: number;
  descentM: number;
  durationS: number;
  difficulty: Difficulty;
  region: string | null;
  visibility: 'private' | 'public';
  shareToken: string | null;
  likes: number;
  liked: boolean;
  ownerName?: string;
  source: 'gepland' | 'geimporteerd';
  startLat: number | null;
  startLon: number | null;
  bbox: [number, number, number, number] | null;
  preview: [number, number][];
  createdAt: string;
  updatedAt: string;
}

export interface RouteFull extends RouteSummary {
  description: string;
  waypoints: Waypoint[] | null;
  track: TrackPoint[];
}

export interface ActivitySummary {
  id: number;
  name: string;
  sport: Sport;
  distanceM: number;
  ascentM: number;
  descentM: number;
  movingS: number;
  elapsedS: number;
  startedAt: string | null;
  region: string | null;
  routeId: number | null;
  preview: [number, number][];
  createdAt: string;
}

export interface ActivityFull extends ActivitySummary {
  track: TrackPoint[];
}

export interface StatsResponse {
  totals: { count: number; distanceM: number; ascentM: number; movingS: number };
  perSport: Record<Sport, { count: number; distanceM: number; ascentM: number; movingS: number }>;
  monthly: { month: string; wandelen: number; fietsen: number; mtb: number }[];
  records: { longest: ActivitySummary | null; mostClimb: ActivitySummary | null };
}
