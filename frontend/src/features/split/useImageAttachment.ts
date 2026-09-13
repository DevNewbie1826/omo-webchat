import { useRef, useState } from "react";
import type { ClipboardEvent, DragEvent } from "react";
import type { PendingImage } from "./chatSessionTypes";

export function useImageAttachment(pendingImage: PendingImage | null, setPendingImage: (image: PendingImage | null) => void) {
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const clear = (): void => {
    setPendingImage(null);
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const pick = (file: File | null): void => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result ?? "");
      const comma = dataUrl.indexOf(",");
      setPendingImage({
        data: comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl,
        mimeType: file.type || "application/octet-stream",
        // Pasted clipboard files may arrive unnamed; keep the chip label readable.
        name: file.name || "clipboard.png",
      });
    };
    reader.readAsDataURL(file);
  };

  const onDragOver = (event: DragEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setIsDragOver(true);
  };

  const onDragLeave = (event: DragEvent<HTMLFormElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) return;
    setIsDragOver(false);
  };

  const onDrop = (event: DragEvent<HTMLFormElement>): void => {
    event.preventDefault();
    setIsDragOver(false);
    const image = Array.from(event.dataTransfer.files).find((file) => file.type.startsWith("image/"));
    if (image) pick(image);
  };

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const image = Array.from(event.clipboardData?.files ?? []).find((file) => file.type.startsWith("image/"));
    if (!image) return;
    // The clipboard holds an image, so the paste targets the attachment slot
    // instead of inserting a placeholder path into the text.
    event.preventDefault();
    pick(image);
  };

  return { pendingImage, setPendingImage, clear, pick, fileInputRef, isDragOver, dragHandlers: { onDragOver, onDragLeave, onDrop }, onPaste };
}
