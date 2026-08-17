// Dunne fetch-wrapper: JSON in/uit, nette foutmeldingen.

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

// Centrale 401-afhandeling: een sessie die midden in het gebruik vervalt, mag
// niet op elke pagina wees-UI achterlaten (bv. 'Statistieken / Niet ingelogd'
// met een volledig ingelogde topbar). Bij een 401 op een beveiligd endpoint
// roepen we eerst deze callback (die in main.ts setUser(null)+navigate('/login')
// doet — via registratie i.p.v. import om de circulaire afhankelijkheid te
// vermijden) en gooien we daarna pas de ApiError.
let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) { onUnauthorized = fn; }

// Auth- en gedeelde endpoints mogen een 401 geven zonder sessie-redirect:
// - /api/auth/*  : login-fout of /api/auth/me bij opstart (nog niet ingelogd)
// - /api/shared/*: publieke deellink (geen auth) — voorkomt een redirect-lus.
function triggersRedirect(url: string): boolean {
  return !url.startsWith('/api/auth/') && !url.startsWith('/api/shared/');
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let data: any = null;
  const text = await res.text();
  try { data = text ? JSON.parse(text) : null; } catch { /* geen JSON */ }
  if (!res.ok) {
    if (res.status === 401 && triggersRedirect(url)) onUnauthorized?.();
    throw new ApiError(res.status, data?.error || `Serverfout (${res.status})`);
  }
  return data as T;
}

export const api = {
  get: <T>(url: string) => request<T>('GET', url),
  post: <T>(url: string, body?: unknown) => request<T>('POST', url, body),
  put: <T>(url: string, body?: unknown) => request<T>('PUT', url, body),
  del: <T>(url: string) => request<T>('DELETE', url),
};
