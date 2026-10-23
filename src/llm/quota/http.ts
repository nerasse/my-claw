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
  | { ok: false; status?: number; message: string; retryAfterMs?: number };

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
