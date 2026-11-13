/**
 * The one way to add something on an Administration list page (D11, AD-18, AD-19): a filled
 * "New …" button among the page's actions that opens the form above the list, as Ticket templates
 * and Webhooks do. The list comes first; the form shows only when asked for.
 */
export function NewButton({
  label,
  open,
  onToggle,
  'data-tutorial': tutorial,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  /** The tutorial step that points here, if one does. */
  'data-tutorial'?: string;
}) {
  return (
    <button
      type="button"
      className="button-primary"
      aria-expanded={open}
      onClick={onToggle}
      {...(tutorial ? { 'data-tutorial': tutorial } : {})}
    >
      {label}
    </button>
  );
}
