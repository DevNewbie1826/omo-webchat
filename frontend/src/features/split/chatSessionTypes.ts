import type { ChatImage, CommandEntry, JsonValue } from "../../lib/chatWs";

export interface PendingImage extends ChatImage {
  readonly name: string;
}

export interface ChatDraft {
  readonly text: string;
  readonly image: PendingImage | null;
  /** Palette identity used for typed RPC routing; never sent to the provider. */
  readonly command?: CommandEntry;
}

export interface RecoveredChatDraft extends ChatDraft {
  readonly version: number;
  /** Ownership of automatic recovery; absent on standalone legacy drafts. */
  readonly requestId?: string;
  /** Explicit recovery may replace input; automatic recovery may not. */
  readonly explicit?: boolean;
}

export interface FailedDraft extends ChatDraft {
  readonly requestId: string;
}

export interface ToolEntry {
  readonly toolName: string;
  readonly phase: "start" | "update" | "end";
  readonly text: string;
  readonly isError: boolean;
  readonly details?: JsonValue | undefined;
  readonly args?: JsonValue | undefined;
}

/** One webchat-owned queued send from the server's queue snapshot (head-first). */
export interface QueueSlotItem {
  readonly id: string;
  readonly text: string;
  readonly hasImage: boolean;
  readonly createdAt: number;
  readonly requestId?: string;
}

/** One engine-queued message mirrored from the engine's public RPC state. */
export interface QueueEngineItem {
  readonly text: string;
  readonly mode: "followUp" | "steer";
}

export interface QueueEngineSummary {
  readonly pendingMessageCount: number;
  readonly ordered: readonly QueueEngineItem[];
}

/** Local request placeholder for a queued submission until the matching queue frame lands. */
export interface QueuePlaceholder {
  readonly requestId: string;
  readonly text: string;
  readonly hasImage: boolean;
}

/** A steer summary awaiting its request outcome or the current run terminal. */
export interface SteerPendingItem {
  readonly requestId: string;
  readonly text: string;
}
