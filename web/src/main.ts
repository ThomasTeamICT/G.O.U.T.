// App-shell: authstatus, topbar, router.

import './style.css';
import { api, setUnauthorizedHandler } from './api';
import { el, icons, svgEl, toast } from './ui';
import { register, startRouter, setGuard, navigate, currentPath, rerender } from './router';
import type { User } from './types';

import { authView } from './views/auth';
import { planView } from './views/plan';
import { routesView } from './views/routes';
import { routeView } from './views/route';
import { discoverView } from './views/discover';
import { activitiesView } from './views/activities';
import { activityView } from './views/activity';
import { statsView } from './views/stats';
import { profileView } from './views/profile';
import { sharedView } from './views/shared';

export const session: { user: User | null } = { user: null };

export function setUser(u: User | null) {
  session.user = u;
  renderTopbar();
}

// Sessie verlopen (401 op een beveiligd endpoint, midden in het gebruik): de
// topbar leegmaken en naar de loginpagina. Zo blijft er geen wees-UI achter met
// een 'ingelogde' topbar. Geregistreerd i.p.v. geïmporteerd om een circulaire
// afhankelijkheid tussen api.ts en main.ts te vermijden.
setUnauthorizedHandler(() => {
  if (session.user) setUser(null);
  if (currentPath().replace(/\?.*$/, '') !== '/login') navigate('/login');
});

const app = document.getElementById('app')!;
const topbarHolder = el('div', {});
const viewHolder = el('div', { style: 'display:flex;flex-direction:column;flex:1;min-height:0;' });
app.append(topbarHolder, viewHolder);
app.style.cssText = 'display:flex;flex-direction:column;min-height:100vh;min-height:100dvh;';

// Navigatielink: icoon + volledig label (desktop = tekstpil) én kort label (mobiel = icoon boven kort label).
function navLink(href: string, icon: string, full: string, short: string): HTMLElement {
  return el('a', { href },
    svgEl(icon),
    el('span', { class: 'nav-full' }, full),
    el('span', { class: 'nav-short' }, short),
  );
}

function renderTopbar() {
  topbarHolder.innerHTML = '';
  if (!session.user) return;
  const u = session.user;

  let menuEl: HTMLElement | null = null;
  const closeMenu = () => { menuEl?.remove(); menuEl = null; document.removeEventListener('mousedown', outside); };
  const outside = (e: MouseEvent) => { if (menuEl && !menuEl.contains(e.target as Node)) closeMenu(); };

  const bar = el('div', { class: 'topbar' },
    el('a', { class: 'logo', href: '#/routes' }, el('b', {}, 'G.O.U.T.'), el('span', {}, 'gewoon op uw tempo')),
    el('nav', {},
      navLink('#/plan', icons.map, 'Plannen', 'Plan'),
      navLink('#/discover', icons.compass, 'Ontdek', 'Ontdek'),
      navLink('#/routes', icons.route, 'Mijn routes', 'Routes'),
      navLink('#/activities', icons.clock, 'Activiteiten', 'Activ.'),
      navLink('#/stats', icons.stats, 'Statistieken', 'Stats'),
    ),
    el('button', {
      class: 'btn btn-primary btn-sm', onclick: () => navigate('/routes?import=1'),
      html: undefined, title: 'GPX-bestand importeren',
    }, svgEl(icons.upload), el('span', { class: 'gpx-label' }, 'GPX importeren')),
    el('button', {
      class: 'avatar', style: `background:${u.avatarColor}`, title: u.name,
      onclick: (e: MouseEvent) => {
        e.stopPropagation();
        if (menuEl) { closeMenu(); return; }
        menuEl = el('div', { class: 'menu' },
          el('a', { href: '#/profile', onclick: closeMenu }, svgEl(icons.user), 'Profiel'),
          el('button', {
            onclick: async () => {
              closeMenu();
              await api.post('/api/auth/logout');
              setUser(null);
              navigate('/login');
            },
          }, svgEl(icons.logout), 'Uitloggen'),
        );
        bar.append(menuEl);
        document.addEventListener('mousedown', outside);
      },
    }, u.name.slice(0, 1).toUpperCase()),
  );
  topbarHolder.append(bar);
}

/* ---------- routes registreren ---------- */

register('/login', authView, { requiresAuth: false });
register('/s/:token', sharedView, { requiresAuth: false });
register('/plan', planView);
register('/routes', routesView);
register('/route/:id', routeView);
register('/discover', discoverView);
register('/activities', activitiesView);
register('/activity/:id', activityView);
register('/stats', statsView);
register('/profile', profileView);
register('/', (c) => { navigate(session.user ? '/routes' : '/login'); });

setGuard((path) => {
  const isPublic = path.startsWith('/login') || path.startsWith('/s/');
  if (!session.user && !isPublic) return '/login';
  if (session.user && path.startsWith('/login')) return '/routes';
  return null;
});

/* ---------- opstart ---------- */

(async () => {
  try {
    const { user } = await api.get<{ user: User | null }>('/api/auth/me');
    session.user = user;
  } catch {
    session.user = null;
  }
  renderTopbar();
  startRouter(viewHolder);
})();

// Globale afhandeling van onverwachte fouten in async handlers.
window.addEventListener('unhandledrejection', (e) => {
  const msg = e.reason?.message || 'Er ging iets mis.';
  if (e.reason?.status === 401) {
    setUser(null);
    navigate('/login');
    return;
  }
  toast(msg, 'error');
});

export { rerender };
