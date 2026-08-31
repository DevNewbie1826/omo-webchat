import { ApiError, apiVoid } from "../../lib/api";

export async function login(password: string): Promise<void> {
  await apiVoid("/api/login", { method: "POST", body: { password } });
}

export async function logout(): Promise<void> {
  await apiVoid("/api/logout", { method: "POST" });
}

export async function checkAuth(): Promise<boolean> {
  try {
    await apiVoid("/api/auth/check");
    return true;
  } catch {
    return false;
  }
}

/**
 * Definitive verdict for the websocket upgrade-failure probe: true only when
 * the server answers the auth check with 401. Network errors and other
 * statuses resolve false so a network drop never reads as an expired session.
 */
export async function sessionExpired(): Promise<boolean> {
  try {
    await apiVoid("/api/auth/check");
    return false;
  } catch (error) {
    return error instanceof ApiError && error.status === 401;
  }
}
