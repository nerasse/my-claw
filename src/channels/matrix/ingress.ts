import { EventType, MsgType, RelationType, type MatrixEvent, type Room } from "matrix-js-sdk";
import type { PreparedMatrixRoomHistory } from "./history.ts";
import { fetchMatrixPollSnapshot, isMatrixPollEventType, resolveMatrixPollPrecheckText } from "./polls.ts";
import type {
  MatrixChatType,
  MatrixEventContent,
  MatrixInboundContext,
  MatrixPreparedTimelineEvent,
  MatrixTimelineIngress,
} from "./types.ts";
import { messageBody, replyToEventId } from "./helpers.ts";

export async function prepareTimelineEvent(params: {
  room: Room;
  event: MatrixEvent;
  eventType: string;
  chatType: MatrixChatType;
  selfDisplayName?: string;
  resolveInboundThreadId: MatrixInboundContext["resolveInboundThreadId"];
}): Promise<MatrixPreparedTimelineEvent | undefined> {
  const originalContent = params.event.getContent() as MatrixEventContent;
  const isPollEvent = isMatrixPollEventType(params.eventType);
  if (params.eventType !== EventType.RoomMessage && !isPollEvent) return undefined;
  if (params.eventType === EventType.RoomMessage && params.event.isRelation(RelationType.Replace)) return undefined;

  const text = isPollEvent
    ? resolveMatrixPollPrecheckText(params.eventType, originalContent)
    : messageBody(originalContent);

  return {
    content: originalContent,
    text,
    rootThreadId: params.resolveInboundThreadId(params.chatType, params.event),
    replyId: replyToEventId(params.event),
    selfDisplayName: params.selfDisplayName,
    isPollEvent,
  };
}

export async function buildTimelineIngress(params: {
  context: MatrixInboundContext;
  room: Room;
  event: MatrixEvent;
  eventType: string;
  sender: string;
  chatType: MatrixChatType;
  historyLimit: number;
  fetchPollSnapshot: typeof fetchMatrixPollSnapshot;
  sdk: {
    fetchRelations?: unknown;
  };
}): Promise<MatrixTimelineIngress | undefined> {
  const roomConfig = params.context.resolveRoomConfig(params.room.roomId);
  if (!params.context.isRoomAllowed(params.room, params.chatType)) return undefined;
  if (!params.context.isAllowedByPolicy(params.sender, params.room, params.chatType)) return undefined;

  const prepared = await prepareTimelineEvent({
    room: params.room,
    event: params.event,
    eventType: params.eventType,
    chatType: params.chatType,
    selfDisplayName: params.context.selfDisplayNameForRoom(params.room),
    resolveInboundThreadId: params.context.resolveInboundThreadId,
  });
  if (!prepared) return undefined;

  const getPollSnapshotText = async (): Promise<string | undefined> => {
    if (!prepared.isPollEvent) return undefined;
    return await params.fetchPollSnapshot(params.sdk as never, params.room.roomId, {
      event_id: params.event.getId() ?? undefined,
      sender: params.sender,
      type: params.eventType,
      content: params.event.getContent() as MatrixEventContent,
    });
  };

  const shouldProcess = params.context.shouldProcessRoomMessage(
    params.room,
    prepared.text,
    prepared.content,
    prepared.selfDisplayName,
  );

  if (!shouldProcess) {
    if (params.chatType === "group" && params.historyLimit > 0) {
      const pendingText =
        params.context.resolvePendingRoomHistoryText(prepared.text, prepared.content) ||
        (await getPollSnapshotText()) ||
        "";
      if (pendingText) {
        params.context.roomHistory.recordPending(params.room.roomId, {
          messageId: params.event.getId() ?? "",
          senderId: params.sender,
          text: pendingText,
        });
      }
    }
    return { ...prepared, shouldProcess: false, preparedRoomHistory: undefined };
  }

  let content = prepared.content;
  let text = prepared.text;
  if (prepared.isPollEvent) {
    const pollSnapshotText = await getPollSnapshotText();
    if (!pollSnapshotText) return undefined;
    content = {
      ...prepared.content,
      msgtype: MsgType.Text,
      body: pollSnapshotText,
    };
    text = pollSnapshotText;
  }

  const preparedRoomHistory: PreparedMatrixRoomHistory | undefined =
    params.chatType === "group" && params.historyLimit > 0
      ? params.context.roomHistory.prepareTrigger(params.room.roomId, params.historyLimit, {
          messageId: params.event.getId() ?? "",
          senderId: params.sender,
          text: params.context.resolvePendingRoomHistoryText(text, content),
        })
      : undefined;

  return {
    ...prepared,
    content,
    text,
    preparedRoomHistory,
    shouldProcess: true,
  };
}
