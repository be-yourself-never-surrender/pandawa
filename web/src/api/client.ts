const TOKEN_KEY = "pandawa_auth_token";

export function getStoredToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string | null): void {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export async function apiFetch<T = unknown>(
  path: string,
  options: RequestInit = {}
): Promise<T> {
  const token = getStoredToken();
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const resp = await fetch(path, { ...options, headers });
  const text = await resp.text();
  let json: unknown = {};
  try {
    json = text ? JSON.parse(text) : {};
  } catch {
    json = { error: text };
  }
  if (!resp.ok) {
    if (resp.status === 401) {
      setStoredToken(null);
      window.dispatchEvent(new Event("pandawa:unauthorized"));
    }
    const errObj = json as { error?: string };
    throw new Error(errObj.error || `HTTP ${resp.status}`);
  }
  return json as T;
}

export function createRealtimeSocket(onMessage: (ev: Record<string, unknown>) => void): WebSocket | null {
  const token = getStoredToken();
  if (!token) return null;
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const ws = new WebSocket(`${proto}//${window.location.host}/ws?token=${encodeURIComponent(token)}`);
  ws.onmessage = (e) => {
    try {
      const parsed = JSON.parse(e.data) as Record<string, unknown>;
      onMessage(parsed);
    } catch {
      // ignore malformed
    }
  };
  return ws;
}
