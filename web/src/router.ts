// Mini hash-router: '#/route/:id' → view-functie met params.
// Een view rendert in de container en geeft optioneel een cleanup-functie terug.

export type ViewFn = (
  container: HTMLElement,
  params: Record<string, string>,
  query: URLSearchParams
) => void | (() => void) | Promise<void | (() => void)>;

interface RouteDef { pattern: string[]; fn: ViewFn; requiresAuth: boolean }

const routes: RouteDef[] = [];
let cleanup: (() => void) | null = null;
let container: HTMLElement | null = null;
let beforeNavigate: ((path: string) => string | null) | null = null;

export function register(pattern: string, fn: ViewFn, opts: { requiresAuth?: boolean } = {}) {
  routes.push({ pattern: pattern.split('/').filter(Boolean), fn, requiresAuth: opts.requiresAuth !== false });
}

export function setGuard(fn: (path: string) => string | null) { beforeNavigate = fn; }

export function isAuthRequired(path: string): boolean {
  const m = match(path);
  return m ? m.def.requiresAuth : true;
}

function match(path: string) {
  const parts = path.split('?')[0].split('/').filter(Boolean);
  for (const def of routes) {
    if (def.pattern.length !== parts.length) continue;
    const params: Record<string, string> = {};
    let ok = true;
    for (let i = 0; i < parts.length; i++) {
      const p = def.pattern[i];
      if (p.startsWith(':')) params[p.slice(1)] = decodeURIComponent(parts[i]);
      else if (p !== parts[i]) { ok = false; break; }
    }
    if (ok) return { def, params };
  }
  return null;
}

export function currentPath(): string {
  return location.hash.replace(/^#/, '') || '/';
}

export function navigate(path: string) {
  if (currentPath() === path) render();
  else location.hash = path;
}

async function render() {
  if (!container) return;
  const path = currentPath();
  if (beforeNavigate) {
    const redirect = beforeNavigate(path);
    if (redirect && redirect !== path) { location.replace(`#${redirect}`); return; }
  }
  const m = match(path);
  if (cleanup) { try { cleanup(); } catch { /* negeren */ } cleanup = null; }
  container.innerHTML = '';
  container.className = '';
  if (!m) {
    container.innerHTML = '<main class="page"><h1>Pagina niet gevonden</h1><p><a href="#/routes">Terug naar je routes</a></p></main>';
    return;
  }
  const query = new URLSearchParams(path.split('?')[1] || '');
  const result = await m.def.fn(container, m.params, query);
  if (typeof result === 'function') cleanup = result;
  updateNav(path);
}

function updateNav(path: string) {
  document.querySelectorAll<HTMLAnchorElement>('.topbar nav a').forEach((a) => {
    const target = a.getAttribute('href')?.replace(/^#/, '') || '';
    const base = '/' + (path.split('?')[0].split('/').filter(Boolean)[0] || '');
    const targetBase = '/' + (target.split('/').filter(Boolean)[0] || '');
    const aliases: Record<string, string> = { '/route': '/routes', '/activity': '/activities' };
    a.classList.toggle('active', (aliases[base] || base) === targetBase);
  });
}

export function startRouter(el: HTMLElement) {
  container = el;
  window.addEventListener('hashchange', render);
  render();
}

export function rerender() { render(); }
