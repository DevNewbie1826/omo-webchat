import { useState } from "react";

interface HookCardProps {
  readonly hookType: string;
  readonly text: string;
}

export function HookCard({ hookType, text }: HookCardProps) {
  const [open, setOpen] = useState(false);
  const preview = text.length > 80 ? `${text.slice(0, 80)}…` : text;

  return (
    <div className="th-tool th-hook" data-hook-type={hookType}>
      <button
        type="button"
        className="th-tool-head"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="th-tool-name">{hookType}</span>
        {!open && preview.length > 0 && <span className="th-tool-preview">{preview}</span>}
      </button>
      {open && text.length > 0 && <pre className="th-tool-body">{text}</pre>}
    </div>
  );
}
