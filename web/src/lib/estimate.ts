// Duur- en moeilijkheidsschatting — zelfde formules als op de server.

import type { Difficulty, Sport } from '../types';

export function estimateDuration(sport: Sport, distanceM: number, ascentM: number): number {
  const km = distanceM / 1000;
  let hours: number;
  if (sport === 'wandelen') hours = km / 4.3 + ascentM / 600;
  else if (sport === 'mtb') hours = km / 11 + ascentM / 480;
  else hours = km / 17 + ascentM / 600;
  return Math.round(hours * 3600);
}

export function difficulty(sport: Sport, distanceM: number, ascentM: number): Difficulty {
  const km = distanceM / 1000;
  let effort: number;
  if (sport === 'wandelen') effort = km + ascentM / 50;
  else if (sport === 'mtb') effort = km / 2 + ascentM / 80;
  else effort = km / 3 + ascentM / 100;
  if (effort <= 10) return 'makkelijk';
  if (effort <= 22) return 'gemiddeld';
  return 'zwaar';
}
