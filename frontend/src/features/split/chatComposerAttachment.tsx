import type { RefObject } from "react";
import { IconPlus, IconX } from "../../components/icons";
import type { PendingImage } from "./chatSessionTypes";

interface ChatComposerAttachmentPreviewProps {
  readonly pendingImage: PendingImage | null;
  readonly removeLabel: string;
  readonly onClear: () => void;
}

/** Pending-image chip rendered as a compact row above the capsule shell. */
export function ChatComposerAttachmentPreview({
  pendingImage,
  removeLabel,
  onClear,
}: ChatComposerAttachmentPreviewProps) {
  if (!pendingImage) return null;
  return (
    <div className="th-chat-attach-chip">
      <img
        className="th-chat-attach-thumb"
        src={`data:${pendingImage.mimeType};base64,${pendingImage.data}`}
        alt=""
      />
      <span className="th-chat-attach-name" title={pendingImage.name}>{pendingImage.name}</span>
      <button
        type="button"
        className="th-btn-icon th-chat-attach-remove"
        title={removeLabel}
        aria-label={removeLabel}
        onClick={onClear}
      >
        <IconX size={14} />
      </button>
    </div>
  );
}

interface ChatComposerAttachmentProps {
  readonly imageSupported: boolean;
  readonly disabled?: boolean;
  readonly attachLabel: string;
  readonly fileInputRef: RefObject<HTMLInputElement>;
  readonly onPick: (file: File | null) => void;
}

export function ChatComposerAttachment({
  imageSupported,
  disabled = false,
  attachLabel,
  fileInputRef,
  onPick,
}: ChatComposerAttachmentProps) {
  return (
    <>
      <span className="th-chat-attach-wrap" title={attachLabel}>
        <button
          type="button"
          className="th-btn-icon th-chat-attach-btn"
          aria-label={attachLabel}
          disabled={!imageSupported || disabled}
          onClick={() => fileInputRef.current?.click()}
        >
          <IconPlus size={18} />
        </button>
      </span>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        hidden
        disabled={disabled}
        onChange={(event) => onPick(event.target.files?.[0] ?? null)}
      />
    </>
  );
}
