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

export interface ToolEntry {
  readonly toolName: string;
  readonly phase: "start" | "update" | "end";
  readonly text: string;
  readonly isError: boolean;
  readonly details?: JsonValue | undefined;
  readonly args?: JsonValue | undefined;
}
