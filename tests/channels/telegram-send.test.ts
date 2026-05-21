import { describe, test, expect } from "bun:test";
import { GrammyError, HttpError } from "grammy";
import {
  mediaTypeFromExt,
  threadParams,
  sleep,
  isParseError,
  isThreadNotFoundError,
  isMessageNotModifiedError,
  isRateLimitError,
  getRetryAfter,
  isPreConnectError,
  buildKeyboard,
  withRetry,
  PARSE_ERR_RE,
  THREAD_NOT_FOUND_RE,
  MESSAGE_NOT_MODIFIED_RE,
  PRE_CONNECT_ERROR_CODES,
} from "../../src/channels/telegram/send.ts";

function gramErr(
  code: number,
  description: string,
  params: Record<string, unknown> = {},
): GrammyError {
  return new GrammyError("test", {
    ok: false as const,
    error_code: code,
    description,
    parameters: params,
  }, "sendMessage", {});
}

function httpErr(code: string): HttpError {
  return new HttpError("test", { code });
}

// ---------------------------------------------------------------------------
// mediaTypeFromExt
// ---------------------------------------------------------------------------

describe("mediaTypeFromExt", () => {
  test(".jpg -> photo", () => {
    expect(mediaTypeFromExt(".jpg")).toBe("photo");
  });

  test(".JPG -> photo (case insensitive)", () => {
    expect(mediaTypeFromExt(".JPG")).toBe("photo");
  });

  test(".mp4 -> video", () => {
    expect(mediaTypeFromExt(".mp4")).toBe("video");
  });

  test(".ogg -> voice", () => {
    expect(mediaTypeFromExt(".ogg")).toBe("voice");
  });

  test(".mp3 -> audio", () => {
    expect(mediaTypeFromExt(".mp3")).toBe("audio");
  });

  test(".pdf -> document", () => {
    expect(mediaTypeFromExt(".pdf")).toBe("document");
  });

  test("jpg without dot -> photo", () => {
    expect(mediaTypeFromExt("jpg")).toBe("photo");
  });
});

// ---------------------------------------------------------------------------
// threadParams
// ---------------------------------------------------------------------------

describe("threadParams", () => {
  test("undefined -> empty object", () => {
    expect(threadParams(undefined)).toEqual({});
  });

  test("GENERAL_TOPIC_ID (1) -> empty object", () => {
    expect(threadParams(1)).toEqual({});
  });

  test("42 -> { message_thread_id: 42 }", () => {
    expect(threadParams(42)).toEqual({ message_thread_id: 42 });
  });
});

// ---------------------------------------------------------------------------
// sleep
// ---------------------------------------------------------------------------

describe("sleep", () => {
  test("resolves after delay", async () => {
    const start = performance.now();
    await sleep(10);
    const elapsed = performance.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(5);
  });
});

// ---------------------------------------------------------------------------
// isParseError
// ---------------------------------------------------------------------------

describe("isParseError", () => {
  test("true for GrammyError with matching description", () => {
    expect(isParseError(gramErr(400, "Bad Request: can't parse entities"))).toBe(true);
  });

  test("false for non-matching description", () => {
    expect(isParseError(gramErr(400, "Bad Request: chat not found"))).toBe(false);
  });

  test("false for non-GrammyError", () => {
    expect(isParseError(new Error("can't parse entities"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isThreadNotFoundError
// ---------------------------------------------------------------------------

describe("isThreadNotFoundError", () => {
  test("true for matching description", () => {
    expect(
      isThreadNotFoundError(gramErr(400, "Bad Request: message thread not found")),
    ).toBe(true);
  });

  test("false for non-matching description", () => {
    expect(isThreadNotFoundError(gramErr(400, "Bad Request: chat not found"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isMessageNotModifiedError
// ---------------------------------------------------------------------------

describe("isMessageNotModifiedError", () => {
  test("true for matching description", () => {
    expect(
      isMessageNotModifiedError(gramErr(400, "Bad Request: message is not modified")),
    ).toBe(true);
  });

  test("false for non-matching description", () => {
    expect(isMessageNotModifiedError(gramErr(400, "Bad Request: chat not found"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// isRateLimitError
// ---------------------------------------------------------------------------

describe("isRateLimitError", () => {
  test("true for 429", () => {
    expect(isRateLimitError(gramErr(429, "Too Many Requests"))).toBe(true);
  });

  test("false for 400", () => {
    expect(isRateLimitError(gramErr(400, "Bad Request"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getRetryAfter
// ---------------------------------------------------------------------------

describe("getRetryAfter", () => {
  test("returns retry_after from parameters", () => {
    const err = gramErr(429, "Too Many Requests", { retry_after: 10 });
    expect(getRetryAfter(err)).toBe(10);
  });

  test("returns 5 when retry_after is missing", () => {
    const err = gramErr(429, "Too Many Requests");
    expect(getRetryAfter(err)).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// isPreConnectError
// ---------------------------------------------------------------------------

describe("isPreConnectError", () => {
  test("true for ECONNREFUSED", () => {
    expect(isPreConnectError(httpErr("ECONNREFUSED"))).toBe(true);
  });

  test("true for ENOTFOUND", () => {
    expect(isPreConnectError(httpErr("ENOTFOUND"))).toBe(true);
  });

  test("true for EAI_AGAIN", () => {
    expect(isPreConnectError(httpErr("EAI_AGAIN"))).toBe(true);
  });

  test("false for unknown code", () => {
    expect(isPreConnectError(httpErr("ETIMEDOUT"))).toBe(false);
  });

  test("false for non-HttpError", () => {
    expect(isPreConnectError(new Error("ECONNREFUSED"))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// buildKeyboard
// ---------------------------------------------------------------------------

describe("buildKeyboard", () => {
  test("returns InlineKeyboard with buttons", () => {
    const kb = buildKeyboard([
      { label: "A", action: "a" },
      { label: "B", action: "b" },
    ]);
    expect(kb).toBeDefined();
    expect(kb.inline_keyboard).toBeDefined();
    expect(kb.inline_keyboard.length).toBeGreaterThan(0);

    const flat = kb.inline_keyboard.flat();
    expect(flat).toEqual([
      { text: "A", callback_data: "a" },
      { text: "B", callback_data: "b" },
    ]);
  });
});

// ---------------------------------------------------------------------------
// withRetry
// ---------------------------------------------------------------------------

describe("withRetry", () => {
  test("succeeds on first try", async () => {
    const result = await withRetry(() => Promise.resolve(42));
    expect(result).toBe(42);
  });

  test("retries on pre-connect error and succeeds", async () => {
    let calls = 0;
    const fn = async (): Promise<string> => {
      calls++;
      if (calls === 1) throw httpErr("ECONNREFUSED");
      return "ok";
    };

    const result = await withRetry(fn);
    expect(result).toBe("ok");
    expect(calls).toBe(2);
  });
});
