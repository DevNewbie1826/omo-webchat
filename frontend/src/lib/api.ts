export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

async function parseError(res: Response): Promise<ApiError> {
  let message = `${res.status} ${res.statusText}`;
  let body: unknown;
  try {
    body = await res.json();
    if (
      typeof body === "object" &&
      body !== null &&
      "error" in body &&
      typeof body.error === "string" &&
      body.error.length > 0
    ) {
      message = body.error;
    }
  } catch {
    /* non-JSON error body — keep status line */
  }
  return new ApiError(res.status, message, body);
}

// Fired whenever any API call is answered with 401 (expired session). App.tsx
// registers the redirect-to-login callback at mount.
let onUnauthorized: (() => void) | undefined;

/** Register the callback invoked on any 401 REST response; undefined clears it. */
export function setUnauthorizedHandler(fn: (() => void) | undefined): void {
  onUnauthorized = fn;
}

/** Fire the registered handler directly (e.g. a confirmed-expired websocket probe). */
export function notifyUnauthorized(): void {
  onUnauthorized?.();
}

export interface RequestOptions {
  readonly method?: string;
  readonly body?: unknown;
  readonly signal?: AbortSignal;
}

function buildInit(options: RequestOptions): RequestInit {
  const init: RequestInit = { method: options.method ?? "GET", credentials: "same-origin" };
  if (options.body !== undefined) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(options.body);
  }
  if (options.signal) init.signal = options.signal;
  return init;
}

/** Turn a failed response into a thrown ApiError, dispatching 401 first. */
async function throwRequestError(res: Response): Promise<never> {
  if (res.status === 401) onUnauthorized?.();
  throw await parseError(res);
}

export async function apiResponse(path: string, options: RequestOptions = {}): Promise<Response> {
  const res = await fetch(path, buildInit(options));
  if (!res.ok) await throwRequestError(res);
  return res;
}

export async function apiJson<T>(path: string, options: RequestOptions = {}): Promise<T> {
  const res = await apiResponse(path, options);
  return JSON.parse(await res.text());
}

export async function apiVoid(path: string, options: RequestOptions = {}): Promise<void> {
  await apiResponse(path, options);
}

export async function apiDownload(path: string, filename: string): Promise<void> {
  const res = await apiResponse(path);
  const objectUrl = URL.createObjectURL(await res.blob());
  const link = document.createElement("a");
  link.href = objectUrl;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  try {
    link.click();
  } finally {
    link.remove();
    URL.revokeObjectURL(objectUrl);
  }
}

export async function apiRaw(
  path: string,
  options: RequestOptions & { readonly body: BodyInit },
): Promise<Response> {
  const init: RequestInit = {
    method: options.method ?? "POST",
    body: options.body,
    credentials: "same-origin",
  };
  if (options.signal) init.signal = options.signal;
  const res = await fetch(path, init);
  if (!res.ok) await throwRequestError(res);
  return res;
}

export function qs(params: Readonly<Record<string, string | undefined>>): string {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) usp.set(key, value);
  }
  const s = usp.toString();
  return s.length > 0 ? `?${s}` : "";
}
