let refreshInFlight: Promise<boolean> | null = null;
let accessToken: string | null = null;

export function getAccessToken(): string | null {
  if (!accessToken && typeof window !== "undefined") accessToken = localStorage.getItem("trezu_access_token");
  if (typeof window !== "undefined") localStorage.removeItem("trezu_access_token");
  return accessToken;
}

export function setAccessToken(token: string | null): void {
  accessToken = token;
  if (typeof window !== "undefined") localStorage.removeItem("trezu_access_token");
}

export function clearAuthTokens(): void {
  accessToken = null;
  if (typeof window !== "undefined") {
    localStorage.removeItem("trezu_access_token");
    localStorage.removeItem("trezu_refresh_token");
  }
}

async function refreshAccessToken(): Promise<boolean> {
  if (refreshInFlight) return refreshInFlight;
  const legacyRefreshToken = localStorage.getItem("trezu_refresh_token");
  refreshInFlight = fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "same-origin",
    ...(legacyRefreshToken ? { body: JSON.stringify({ refreshToken: legacyRefreshToken }) } : {}),
  }).then(async (response) => {
    localStorage.removeItem("trezu_refresh_token");
    if (!response.ok) return false;
    const tokens = await response.json();
    if (typeof tokens.accessToken !== "string") return false;
    setAccessToken(tokens.accessToken);
    return true;
  }).catch(() => false).finally(() => { refreshInFlight = null; });
  return refreshInFlight;
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  const activeWorkspaceId = typeof window !== "undefined" ? localStorage.getItem("trezu_active_workspace_id") : null;
  if (activeWorkspaceId && !headers.has("X-Trezu-Workspace-Id")) headers.set("X-Trezu-Workspace-Id", activeWorkspaceId);
  const token = getAccessToken();
  if (token && !headers.has("Authorization")) headers.set("Authorization", `Bearer ${token}`);
  const requestInit: RequestInit = { ...init, headers, credentials: init.credentials ?? "same-origin" };
  let response = await fetch(input, requestInit);
  if (response.status === 401 && !new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url, window.location.origin).pathname.endsWith("/auth/refresh")) {
    if (await refreshAccessToken()) {
      const retryHeaders = new Headers(init.headers);
      if (activeWorkspaceId && !retryHeaders.has("X-Trezu-Workspace-Id")) retryHeaders.set("X-Trezu-Workspace-Id", activeWorkspaceId);
      const freshToken = getAccessToken();
      if (freshToken && !retryHeaders.has("Authorization")) retryHeaders.set("Authorization", `Bearer ${freshToken}`);
      response = await fetch(input, { ...init, headers: retryHeaders, credentials: init.credentials ?? "same-origin" });
    }
  }
  return response;
}
