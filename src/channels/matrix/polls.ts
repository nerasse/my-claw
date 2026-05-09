import type { MatrixClient } from "matrix-js-sdk";

type MatrixPollEvent = {
  event_id?: string;
  sender?: string;
  type?: string;
  origin_server_ts?: number;
  content?: Record<string, unknown>;
  unsigned?: {
    redacted_because?: unknown;
  };
};

type ParsedPollStart = {
  question: string;
  answers: Array<{ id: string; text: string }>;
  kind: string;
  maxSelections: number;
};

type PollResultsSummary = {
  question: string;
  kind: string;
  entries: Array<{
    id: string;
    text: string;
    votes: number;
  }>;
  totalVotes: number;
  closed: boolean;
};

const POLL_START_TYPES = new Set(["m.poll.start", "org.matrix.msc3381.poll.start"]);
const POLL_RESPONSE_TYPES = new Set(["m.poll.response", "org.matrix.msc3381.poll.response"]);
const POLL_END_TYPES = new Set(["m.poll.end", "org.matrix.msc3381.poll.end"]);

function trimString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function textContent(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  const record = value as Record<string, unknown>;
  return trimString(record["m.text"]) ?? trimString(record["org.matrix.msc1767.text"]) ?? trimString(record.body) ?? "";
}

function pollStartSubtype(content: Record<string, unknown>): Record<string, unknown> | undefined {
  const poll = content["m.poll.start"] ?? content["org.matrix.msc3381.poll.start"] ?? content["m.poll"];
  return poll && typeof poll === "object" ? (poll as Record<string, unknown>) : undefined;
}

function parsePollStart(content: Record<string, unknown>): ParsedPollStart | undefined {
  const poll = pollStartSubtype(content);
  if (!poll) return undefined;

  const question = textContent(poll.question);
  if (!question) return undefined;

  const answers = Array.isArray(poll.answers)
    ? poll.answers
        .map((answer) => {
          if (!answer || typeof answer !== "object") return undefined;
          const record = answer as Record<string, unknown>;
          const id = trimString(record.id);
          const text = textContent(record);
          if (!id || !text) return undefined;
          return { id, text };
        })
        .filter((answer): answer is { id: string; text: string } => Boolean(answer))
    : [];
  if (answers.length === 0) return undefined;

  const rawMaxSelections = poll.max_selections;
  const maxSelections =
    typeof rawMaxSelections === "number" && Number.isFinite(rawMaxSelections)
      ? Math.floor(rawMaxSelections)
      : 1;

  return {
    question,
    answers,
    kind: trimString(poll.kind) ?? "m.poll.disclosed",
    maxSelections: Math.min(Math.max(maxSelections, 1), answers.length),
  };
}

function resolvePollReferenceEventId(content: Record<string, unknown>): string | undefined {
  const relates = content["m.relates_to"];
  if (!relates || typeof relates !== "object") return undefined;
  return trimString((relates as Record<string, unknown>).event_id);
}

function parsePollResponseAnswerIds(content: Record<string, unknown>): string[] {
  const response = content["m.poll.response"] ?? content["org.matrix.msc3381.poll.response"];
  if (!response || typeof response !== "object") return [];
  const answers = (response as Record<string, unknown>).answers;
  if (!Array.isArray(answers)) return [];
  return answers
    .map((answer) => trimString(answer))
    .filter((answer): answer is string => Boolean(answer));
}

function isPollStartType(eventType?: string): boolean {
  return Boolean(eventType && POLL_START_TYPES.has(eventType));
}

function isPollResponseType(eventType?: string): boolean {
  return Boolean(eventType && POLL_RESPONSE_TYPES.has(eventType));
}

function isPollEndType(eventType?: string): boolean {
  return Boolean(eventType && POLL_END_TYPES.has(eventType));
}

export function isMatrixPollEventType(eventType?: string): boolean {
  return isPollStartType(eventType) || isPollResponseType(eventType) || isPollEndType(eventType);
}

export function resolveMatrixPollPrecheckText(
  eventType: string | undefined,
  content: Record<string, unknown>,
): string {
  if (!isPollStartType(eventType)) return "";
  const parsed = parsePollStart(content);
  return parsed ? formatPollAsText(parsed) : "";
}

function formatPollAsText(parsed: ParsedPollStart): string {
  return ["[Poll]", parsed.question, "", ...parsed.answers.map((answer, index) => `${index + 1}. ${answer.text}`)].join("\n");
}

function formatPollResultsAsText(summary: PollResultsSummary): string {
  const lines = [summary.closed ? "[Poll closed]" : "[Poll]", summary.question, ""];
  const revealResults = summary.kind === "m.poll.disclosed" || summary.closed;
  for (const [index, entry] of summary.entries.entries()) {
    if (!revealResults) {
      lines.push(`${index + 1}. ${entry.text}`);
      continue;
    }
    lines.push(`${index + 1}. ${entry.text} (${entry.votes} vote${entry.votes === 1 ? "" : "s"})`);
  }
  lines.push("");
  if (!revealResults) {
    lines.push("Responses are hidden until the poll closes.");
  } else {
    lines.push(`Total voters: ${summary.totalVotes}`);
  }
  return lines.join("\n");
}

function buildPollResultsSummary(params: {
  pollEventId: string;
  parsed: ParsedPollStart;
  sender?: string;
  relationEvents: MatrixPollEvent[];
}): PollResultsSummary {
  let pollClosedAt = Number.POSITIVE_INFINITY;
  for (const event of params.relationEvents) {
    if (event.unsigned?.redacted_because) continue;
    if (!isPollEndType(event.type)) continue;
    if (event.sender !== params.sender) continue;
    const ts =
      typeof event.origin_server_ts === "number" && Number.isFinite(event.origin_server_ts)
        ? event.origin_server_ts
        : Number.POSITIVE_INFINITY;
    if (ts < pollClosedAt) {
      pollClosedAt = ts;
    }
  }

  const allowedAnswerIds = new Set(params.parsed.answers.map((answer) => answer.id));
  const latestVoteBySender = new Map<string, { ts: number; eventId: string; answerIds: string[] }>();
  const orderedEvents = [...params.relationEvents].sort((left, right) => {
    const leftTs =
      typeof left.origin_server_ts === "number" && Number.isFinite(left.origin_server_ts)
        ? left.origin_server_ts
        : Number.POSITIVE_INFINITY;
    const rightTs =
      typeof right.origin_server_ts === "number" && Number.isFinite(right.origin_server_ts)
        ? right.origin_server_ts
        : Number.POSITIVE_INFINITY;
    if (leftTs !== rightTs) return leftTs - rightTs;
    return (left.event_id ?? "").localeCompare(right.event_id ?? "");
  });

  for (const event of orderedEvents) {
    if (event.unsigned?.redacted_because) continue;
    if (!isPollResponseType(event.type)) continue;
    const senderId = trimString(event.sender);
    if (!senderId) continue;
    const eventTs =
      typeof event.origin_server_ts === "number" && Number.isFinite(event.origin_server_ts)
        ? event.origin_server_ts
        : Number.POSITIVE_INFINITY;
    if (eventTs > pollClosedAt) continue;

    const normalizedAnswers = Array.from(
      new Set(
        parsePollResponseAnswerIds(event.content ?? {})
          .filter((answerId) => allowedAnswerIds.has(answerId))
          .slice(0, params.parsed.maxSelections),
      ),
    );
    latestVoteBySender.set(senderId, {
      ts: eventTs,
      eventId: trimString(event.event_id) ?? "",
      answerIds: normalizedAnswers,
    });
  }

  const voteCounts = new Map(params.parsed.answers.map((answer): [string, number] => [answer.id, 0]));
  let totalVotes = 0;
  for (const latestVote of latestVoteBySender.values()) {
    if (latestVote.answerIds.length === 0) continue;
    totalVotes += 1;
    for (const answerId of latestVote.answerIds) {
      voteCounts.set(answerId, (voteCounts.get(answerId) ?? 0) + 1);
    }
  }

  return {
    question: params.parsed.question,
    kind: params.parsed.kind,
    entries: params.parsed.answers.map((answer) => ({
      id: answer.id,
      text: answer.text,
      votes: voteCounts.get(answer.id) ?? 0,
    })),
    totalVotes,
    closed: Number.isFinite(pollClosedAt),
  };
}

async function readAllPollRelations(
  client: MatrixClient,
  roomId: string,
  pollEventId: string,
): Promise<MatrixPollEvent[]> {
  const relationEvents: MatrixPollEvent[] = [];
  let nextBatch: string | undefined;
  do {
    const page = await client.fetchRelations(roomId, pollEventId, "m.reference", undefined, {
      from: nextBatch,
    });
    relationEvents.push(...(page.chunk as MatrixPollEvent[]));
    nextBatch = page.next_batch ?? undefined;
  } while (nextBatch);
  return relationEvents;
}

export async function fetchMatrixPollSnapshot(
  client: MatrixClient,
  roomId: string,
  event: MatrixPollEvent,
): Promise<string | undefined> {
  if (!isMatrixPollEventType(event.type)) return undefined;

  const pollEventId = isPollStartType(event.type)
    ? trimString(event.event_id)
    : resolvePollReferenceEventId(event.content ?? {});
  if (!pollEventId) return undefined;

  const rootEvent = isPollStartType(event.type)
    ? event
    : ((await client.fetchRoomEvent(roomId, pollEventId)) as MatrixPollEvent);
  if (!isPollStartType(rootEvent.type) || !rootEvent.content || typeof rootEvent.content !== "object") {
    return undefined;
  }

  const parsed = parsePollStart(rootEvent.content);
  if (!parsed) return undefined;

  const relationEvents = await readAllPollRelations(client, roomId, pollEventId).catch(() => []);
  if (relationEvents.length === 0) {
    return formatPollAsText(parsed);
  }

  return formatPollResultsAsText(
    buildPollResultsSummary({
      pollEventId,
      parsed,
      sender: trimString(rootEvent.sender),
      relationEvents,
    }),
  );
}
