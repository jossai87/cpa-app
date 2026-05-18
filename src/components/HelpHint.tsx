import { useState, useRef, useEffect } from 'react';

interface Props {
  /** Brief explanation of what this field captures and where to find it. */
  text: string;
  label?: string;
}

/**
 * Clickable help icon that shows a tooltip with context about a form field.
 *
 * Click to open, click outside or press Esc to close.
 * Keyboard accessible — focusable, opens on Enter/Space.
 */
export default function HelpHint({ text, label }: Props) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <span ref={wrapRef} className="relative inline-block ml-1.5 align-middle">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            setOpen((v) => !v);
          }
        }}
        aria-label={label ? `Help for ${label}` : 'Help'}
        aria-expanded={open}
        className="inline-flex items-center justify-center w-4 h-4 rounded-full bg-blue-100 text-blue-700 text-[10px] font-bold hover:bg-blue-200 focus:outline-none focus:ring-2 focus:ring-blue-400"
      >
        !
      </button>
      {open && (
        <div
          role="tooltip"
          className="absolute z-50 left-0 mt-2 w-72 rounded-md bg-slate-900 text-white text-xs leading-relaxed p-3 shadow-lg"
        >
          {text}
        </div>
      )}
    </span>
  );
}
