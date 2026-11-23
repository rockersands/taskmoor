/**
 * The editor toolbar's icons: strokes only, in the text colour, hidden from assistive
 * technology (every button has its own accessible name).
 */
const PATHS = {
  bold: 'M4.5 2.5h4.25a2.75 2.75 0 0 1 0 5.5H4.5zM4.5 8h5a2.75 2.75 0 0 1 0 5.5h-5z',
  italic: 'M7 2.5h6M3 13.5h6M10 2.5 6 13.5',
  more: 'M3 8h1M7.5 8h1M12 8h1',
  strike:
    'M2.5 8h11M11 4.75C10.5 3.4 9.3 2.75 8 2.75c-1.8 0-3 1-3 2.4M5 11.25c.5 1.3 1.7 2 3.2 2 1.9 0 3.3-1 3.3-2.6',
  code: 'M5.5 4.5 2 8l3.5 3.5M10.5 4.5 14 8l-3.5 3.5',
  link: 'M6.5 9.5l3-3M7.25 4.75l1.5-1.5a2.5 2.5 0 0 1 3.5 3.5l-1.5 1.5M8.75 11.25l-1.5 1.5a2.5 2.5 0 0 1-3.5-3.5l1.5-1.5',
  heading2: 'M2.5 3v10M8 3v10M2.5 8H8M10.5 9.5a1.5 1.5 0 1 1 3 0c0 1.2-3 2.3-3 3.5h3',
  heading3: 'M2.5 3v10M8 3v10M2.5 8H8M10.5 8.5h3l-1.6 1.8a1.6 1.6 0 1 1-1.4 2.5',
  bulletList: 'M6 4h8M6 8h8M6 12h8M2.5 3.6v.8M2.5 7.6v.8M2.5 11.6v.8',
  orderedList: 'M6.5 4h7.5M6.5 8h7.5M6.5 12h7.5M2 2.5h1v3M1.5 10.5a1 1 0 0 1 2 .3l-2 1.7h2',
  taskList: 'M1.5 2.5h4v4h-4zM2.5 4.5l1 1 1.5-2M8 4.5h6M1.5 9.5h4v4h-4zM8 11.5h6',
  blockquote: 'M2.5 4.5h3.5V8H2.5zM6 8c0 2-1.2 3.3-3 3.8M9.5 4.5H13V8H9.5zM13 8c0 2-1.2 3.3-3 3.8',
  codeBlock: 'M1.5 2.5h13v11h-13zM6.5 6 4.5 8l2 2M9.5 6l2 2-2 2',
  table: 'M1.5 2.5h13v11h-13zM1.5 6.5h13M1.5 10h13M6 6.5v7M10.5 6.5v7',
  mention:
    'M10.75 8a2.75 2.75 0 1 1-1-2.1M10.75 5.5v3.25a1.5 1.5 0 0 0 3 0V8a5.75 5.75 0 1 0-2.4 4.7',
  rule: 'M1.5 8h13M4 4.5h8M4 11.5h8',
  undo: 'M5 3 2 6l3 3M2 6h7.5a3.75 3.75 0 0 1 0 7.5H7',
  redo: 'M11 3l3 3-3 3M14 6H6.5a3.75 3.75 0 0 0 0 7.5H9',
  addRow: 'M1.5 2.5h13v6h-13zM1.5 5.5h13M8 10.5v4M6 12.5h4',
  addColumn: 'M1.5 2.5h7v11h-7zM5 2.5v11M12.5 6v4M10.5 8h4',
  // The row and column of the two above, with a cross where those have a plus.
  deleteRow: 'M1.5 2.5h13v6h-13zM1.5 5.5h13M6.5 11l3 3M9.5 11l-3 3',
  deleteColumn: 'M1.5 2.5h7v11h-7zM5 2.5v11M11 6.5l3 3M14 6.5l-3 3',
  deleteTable: 'M2.5 4h11M6 4V2.5h4V4M3.75 4l.75 9.5h7l.75-9.5',
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name }: { name: IconName }) {
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      className="rt-icon"
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
