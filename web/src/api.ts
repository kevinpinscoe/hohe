// HTTP calls to the HOHE server. Every request has a bounded timeout (Phase 2 finding 6), so a
// stalled request can never block later syncs, and every failure is classified so the caller
// can tell "server unreachable" from "login needed" from "the server refused this".

import type { Build, Result, SrvView } from './server';

export const REQUEST_TIMEOUT_MS = 15_000;
let timeoutMs = REQUEST_TIMEOUT_MS;

/** Change the request timeout (tests). */
export function setRequestTimeout(ms: number) {
  timeoutMs = ms;
}

export type ApiErrorKind = 'unreachable' | 'unauthorized' | 'refused' | 'server' | 'locked';

export class ApiError extends Error {
  constructor(
    readonly kind: ApiErrorKind,
    message: string,
    readonly status = 0,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await fetch(path, {
      ...init,
      credentials: 'same-origin',
      cache: 'no-store',
      signal: ctl.signal,
      headers: { 'X-HOHE-Client': '1', ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers },
    });
  } catch {
    clearTimeout(timer);
    throw new ApiError('unreachable', ctl.signal.aborted ? `no answer within ${timeoutMs / 1000} seconds` : 'could not reach the server');
  }
  // The timeout also covers reading the body, so a stalled answer cannot hang a sync.
  let body: unknown = null;
  try {
    body = await resp.json();
  } catch {
    if (ctl.signal.aborted) throw new ApiError('unreachable', `no complete answer within ${timeoutMs / 1000} seconds`);
    // A non-JSON answer: most likely a proxy or captive page, not HOHE.
    if (resp.ok) throw new ApiError('unreachable', 'the answer was not from HOHE', resp.status);
  } finally {
    clearTimeout(timer);
  }
  if (resp.ok) return body as T;
  const msg = (body as { error?: string } | null)?.error ?? `HTTP ${resp.status}`;
  if (resp.status === 401) throw new ApiError('unauthorized', msg, 401);
  if (resp.status === 429) throw new ApiError('locked', msg, 429);
  // A gateway error means the proxy is up and HOHE behind it is not.
  if (resp.status === 502 || resp.status === 503 || resp.status === 504) throw new ApiError('unreachable', msg, resp.status);
  if (resp.status >= 500) throw new ApiError('server', msg, resp.status);
  throw new ApiError('refused', msg, resp.status);
}

export const api = {
  session: () => call<{ loggedIn: boolean; build: Build }>('/api/session'),
  login: (password: string, device: string) =>
    call<{ loggedIn: boolean }>('/api/login', { method: 'POST', body: JSON.stringify({ password, device }) }),
  logout: () => call<{ loggedIn: boolean }>('/api/logout', { method: 'POST', body: '{}' }),
  state: () => call<{ state: SrvView; build: Build }>('/api/state'),
  sync: (deviceId: string, ops: unknown[]) =>
    call<{ results: Result[] | null; state: SrvView; build: Build }>('/api/sync', {
      method: 'POST',
      body: JSON.stringify({ deviceId, ops }),
    }),
  version: () => call<Build>('/version'),
};
