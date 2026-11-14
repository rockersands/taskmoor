/**
 * The place of a button a row does not have, such as a first status's Up or the default
 * workflow's Delete: as wide as that button and drawn as nothing, so the buttons of every row in
 * a list stand in the same columns. It is not there for assistive technology or the keyboard.
 */
export function ActionSlot({ label, danger = false }: { label: string; danger?: boolean }) {
  return (
    <span
      className={`${danger ? 'button-danger-quiet' : 'button-secondary'} action-slot`}
      aria-hidden="true"
    >
      {label}
    </span>
  );
}
