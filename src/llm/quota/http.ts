/**
 * One bounded GET for every quota adapter.
 *
 * A quota read is a side dish: it must never hold a page for longer than a few seconds, and it
 * must never throw. A network fault, a timeout and a body that is not JSON all come back as a
 * failure the caller renders; none of them escapes as an exception.
 */
import { parseRetryAfterMs } from "../retry.ts";

export type JsonResponse =
  | { ok: true; data: unknown }
  | { ok: false; status?: number; message: string; retryAfterMs?: number; data?: unknown };

const TIMEOUT_MS = 10_000;

export async function getJson(
  url: string,
  headers: Record<string, string>,
  timeoutMs = TIMEOUT_MS,
): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "GET",
      headers: { accept: "application/json", ...headers },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    const retryAfterMs = parseRetryAfterMs(response);
    return {
      ok: false,
      status: response.status,
      message: `HTTP ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
    };
  }

  try {
    return { ok: true, data: (await response.json()) as unknown };
  } catch {
    return { ok: false, status: response.status, message: "response was not JSON" };
  }
}

/** A refused credential, not a broken endpoint. */
export function isAuthFailure(status: number | undefined): boolean {
  return status === 401 || status === 403;
}

/** One bounded POST, with the same rule as `getJson`: it answers, it never throws. */
export async function postJson(
  url: string,
  headers: Record<string, string>,
  body: unknown,
  timeoutMs = TIMEOUT_MS,
): Promise<JsonResponse> {
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }

  const raw = await response.text().catch(() => "");
  let data: unknown = raw;
  try {
    data = JSON.parse(raw) as unknown;
  } catch {
    // A body that is not JSON is still the provider's answer, and the message below carries it.
  }
  if (!response.ok) {
    const detail = typeof data === "string" ? data : JSON.stringify(data);
    const retryAfterMs = parseRetryAfterMs(response);
    return {
      ok: false,
      status: response.status,
      message: `HTTP ${response.status}${detail ? ` — ${detail.slice(0, 200)}` : ""}`,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      data,
    };
  }
  return { ok: true, data };
}
