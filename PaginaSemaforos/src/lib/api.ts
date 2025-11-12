// src/lib/api.ts

/** Base URL tomada de .env (VITE_API_BASE_URL) o, si no existe, del origen actual del navegador */
const rawBase = (import.meta as any)?.env?.VITE_API_BASE_URL?.toString().trim();

/** Quita slashes finales para evitar // en los fetch */
const stripTrailingSlashes = (s: string) => s.replace(/\/+$/, "");

const STORAGE_KEY = "esp32.apiBaseOverride";

/** Normaliza base: env > window.origin > "" (SSR-safe) */
const fallbackBase = rawBase && rawBase.length > 0
  ? stripTrailingSlashes(rawBase)
  : typeof window !== "undefined" && window.location?.origin
    ? stripTrailingSlashes(window.location.origin)
    : "";

const sanitizeOverride = (value: string | null | undefined): string => {
  if (!value) return "";
  let trimmed = value.trim();
  if (!trimmed) return "";
  if (!/^https?:\/\//i.test(trimmed)) {
    if (/^[\w.-]+(?::\d+)?(?:\/.*)?$/.test(trimmed)) {
      trimmed = `http://${trimmed}`;
    }
  }
  return stripTrailingSlashes(trimmed);
};

let overrideBase = "";
if (typeof window !== "undefined") {
  try {
    overrideBase = sanitizeOverride(window.localStorage?.getItem(STORAGE_KEY));
  } catch (error) {
    console.debug("No se pudo leer override de API_BASE", error);
    overrideBase = "";
  }
}

const effectiveBase = (): string => (overrideBase && overrideBase.length > 0) ? overrideBase : fallbackBase;

export function getApiBaseOverride(): string {
  return overrideBase;
}

export function getApiBaseUrl(): string {
  return effectiveBase();
}

export function setApiBaseUrl(value: string): { effective: string; override: string } {
  overrideBase = sanitizeOverride(value);
  if (typeof window !== "undefined" && window.localStorage) {
    try {
      if (overrideBase && overrideBase.length > 0) {
        window.localStorage.setItem(STORAGE_KEY, overrideBase);
      } else {
        window.localStorage.removeItem(STORAGE_KEY);
      }
    } catch (error) {
      console.warn("No se pudo persistir override de API_BASE", error);
    }
  }
  return { effective: effectiveBase(), override: overrideBase };
}

export function resetApiBaseUrl() {
  return setApiBaseUrl("");
}

/** Une base + path (si path es absoluto http/https, lo respeta) */
function buildUrl(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = getApiBaseUrl();
  return `${base}${p}`;
}

export interface ApiRequestOptions extends RequestInit {
  /**
   * Cuando true (default), si el servidor responde 502 se trata como error de red.
   * Útil para detectar cuando el proxy local no logra comunicarse con el ESP32.
   */
  failOnBadGateway?: boolean;

  /**
   * Tiempo máximo de espera del fetch en milisegundos (default 10s).
   */
  timeoutMs?: number;

  /**
   * Cuerpo JSON a enviar. Si se usa, se serializa y se añade
   * automáticamente Content-Type: application/json.
   * Ignorado si defines 'body' manualmente.
   */
  json?: unknown;
}

/**
 * Hace una petición al ESP32 (pasando por el proxy si aplica) y devuelve:
 *  - `response`: la Response cruda del fetch
 *  - `data`: null o el JSON parseado si Content-Type es application/json
 */
export async function requestEsp32<T = unknown>(
  path: string,
  { failOnBadGateway = true, timeoutMs = 10_000, headers, json, ...init }: ApiRequestOptions = {}
): Promise<{ data: T | null; response: Response }> {
  const url = buildUrl(path);

  // Si el usuario pasó un body explícito, respetarlo; si no, construir desde json (si se dio).
  let body = init.body;
  const mergedHeaders: HeadersInit = {
    Accept: "application/json",
    ...headers,
  };

  if (body == null && json !== undefined) {
    body = JSON.stringify(json);
    // Asegurar el Content-Type JSON sólo si no fue definido por el caller
    if (!(mergedHeaders as Record<string, string>)["Content-Type"]) {
      (mergedHeaders as Record<string, string>)["Content-Type"] = "application/json";
    }
  }

  // AbortController para timeout
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetch(url, {
      // Modo por defecto: 'cors' funciona bien con Vite/Proxy
      mode: init.mode ?? "cors",
      ...init,
      headers: mergedHeaders,
      body,
      signal: controller.signal,
    });
  } catch (err) {
    clearTimeout(id);
    // Errores de red / abort se propagan tal cual
    throw err;
  } finally {
    clearTimeout(id);
  }

  // Tratar 502 como caída de backend (opcional)
  if (failOnBadGateway && response.status === 502) {
    const text = await safeReadText(response);
    const error = new Error(text || "Bad Gateway");
    throw Object.assign(error, { response });
  }

  // Intentar parsear JSON si corresponde
  let data: T | null = null;
  const contentType = response.headers.get("content-type") || "";
  if (/\bapplication\/json\b/i.test(contentType)) {
    try {
      data = (await response.json()) as T;
    } catch (error) {
      console.warn("No se pudo parsear JSON de", url, error);
    }
  }

  return { data, response };
}

/** Convierte un error desconocido en string legible para toasts/alertas */
export function describeApiError(error: unknown): string {
  // Abort por timeout
  if (error instanceof DOMException && error.name === "AbortError") {
    return "Tiempo de espera agotado. Verifica conexión con el proxy/ESP32.";
  }

  if (error instanceof Error) {
    const anyErr = error as any;
    if (anyErr?.response && typeof anyErr.response.status === "number") {
      const status: number = anyErr.response.status;
      if (status === 502) {
        return "Sin respuesta del ESP32 (Bad Gateway). Revisa que el proxy y el microcontrolador estén activos.";
      }
      if (status === 404) {
        return "Endpoint no encontrado (404). Verifica la ruta /api/* y el firmware.";
      }
      if (status === 500) {
        return "Error interno del servidor (500). Revisa logs del proxy/ESP32.";
      }
      return `Error HTTP ${status}`;
    }
    return error.message || "Error desconocido";
  }
  try {
    return JSON.stringify(error);
  } catch {
    return "Error desconocido";
  }
}

/** Lectura segura de texto (sin romper si el body ya fue consumido) */
async function safeReadText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}

// Helpers opcionales de conveniencia
export async function getJson<T = unknown>(path: string, opts?: Omit<ApiRequestOptions, "method">) {
  return requestEsp32<T>(path, { ...opts, method: "GET" });
}

export async function postJson<T = unknown>(path: string, json?: unknown, opts?: Omit<ApiRequestOptions, "method" | "json">) {
  return requestEsp32<T>(path, { ...opts, method: "POST", json });
}
