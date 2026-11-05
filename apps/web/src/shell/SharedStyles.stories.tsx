import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';

/**
 * The pieces every page shares (ADR-114, T-144), together, so one look at both skins shows what a
 * change to them moves: pills, fields, a glass table, badges, notices and a dialog's surface.
 */
function SharedStyles() {
  return (
    <main className="page">
      <section className="glass-card" style={{ padding: 16, display: 'grid', gap: 12 }}>
        <h2 className="section-title">Actions</h2>
        <div className="form-actions">
          <button type="button" className="button-primary">
            Save
          </button>
          <button type="button" className="button-secondary">
            Cancel
          </button>
          <a className="button-secondary" href="#/home">
            A link, centred
          </a>
          <button type="button" className="button-secondary" aria-pressed="true">
            On
          </button>
          <button type="button" className="button-secondary" disabled>
            Not now
          </button>
          <button type="button" className="button-quiet">
            Quiet
          </button>
          <button type="button" className="button-danger">
            Delete
          </button>
        </div>
      </section>

      <section className="glass-card" style={{ padding: 16, display: 'grid', gap: 12 }}>
        <h2 className="section-title">Fields, outside a form</h2>
        <div className="form-actions">
          <input aria-label="A line" defaultValue="A line" />
          <select aria-label="A choice">
            <option>A choice</option>
          </select>
          <textarea aria-label="A paragraph" defaultValue="A paragraph" />
        </div>
      </section>

      <form className="form" aria-label="A form" style={{ maxWidth: 'none' }}>
        <fieldset>
          <legend>A group of fields on the canvas</legend>
          <label className="form-field">
            <span className="form-label">Name</span>
            <input defaultValue="Platform API" />
          </label>
        </fieldset>
      </form>

      <section className="glass-card" style={{ padding: 16 }}>
        <form className="form" aria-label="A form in a card" style={{ maxWidth: 'none' }}>
          <fieldset>
            <legend>The same group inside glass: a well</legend>
            <label className="form-field">
              <span className="form-label">Name</span>
              <input defaultValue="Platform API" />
            </label>
          </fieldset>
        </form>
      </section>

      <section className="glass-card glass-scroller" aria-label="A table">
        <table className="data-table">
          <caption>Tickets</caption>
          <thead>
            <tr>
              <th scope="col">Key</th>
              <th scope="col">Summary</th>
              <th scope="col">State</th>
              <th scope="col" className="data-table-number">
                Points
              </th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">API-1</th>
              <td>Sign in with a passkey</td>
              <td>
                <span className="badge badge-success">Closed</span>
              </td>
              <td className="data-table-number">3</td>
            </tr>
            <tr>
              <th scope="row">API-2</th>
              <td>Show the limit when a board is full</td>
              <td>
                <span className="badge">Open</span>
              </td>
              <td className="data-table-number">13</td>
            </tr>
          </tbody>
        </table>
      </section>

      <section className="glass-card" style={{ padding: 16, display: 'grid', gap: 12 }}>
        <h2 className="section-title">Badges</h2>
        <div className="form-actions">
          <span className="badge">Plain</span>
          <span className="badge badge-accent">New</span>
          <span className="badge badge-info">Beta</span>
          <span className="badge badge-success">Active</span>
          <span className="badge badge-warning">Expiring</span>
          <span className="badge badge-danger">Revoked</span>
        </div>
      </section>

      <section className="glass-card" style={{ padding: 16, display: 'grid', gap: 12 }}>
        <h2 className="section-title">Notices</h2>
        <p className="page-note">A quiet note.</p>
        <p className="form-error">An error from a form.</p>
        <p className="board-problem">An error on a board.</p>
        <p className="page-note" role="alert">
          A page that could not load.
        </p>
      </section>

      <section className="ticket-dialog" aria-label="A dialog's surface">
        <h2 className="section-title">A dialog's surface</h2>
        <p className="page-note">Floating glass, with the strongest blur.</p>
      </section>
    </main>
  );
}

const meta = {
  title: 'Shell/SharedStyles',
  component: SharedStyles,
} satisfies Meta<typeof SharedStyles>;

export default meta;
type Story = StoryObj<typeof meta>;

/** All of it, in the shape the rules promise. Axe runs on this in both skins. */
export const Everything: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const style = (element: Element) => getComputedStyle(element);

    // A link drawn as a button centres its words, as the button does.
    const link = canvas.getByRole('link', { name: 'A link, centred' });
    expect(style(link).alignItems).toBe('center');
    expect(style(link).justifyContent).toBe('center');
    expect(style(link).textDecorationLine).toBe('none');
    const cancel = canvas.getByRole('button', { name: 'Cancel' });
    expect(style(cancel).backgroundColor).toBe(
      style(canvas.getByRole('button', { name: 'Quiet' })).backgroundColor,
    );

    // A field outside any form has the same shape as one inside.
    const inside = within(canvas.getByRole('form', { name: 'A form' })).getByRole('textbox');
    const outside = canvas.getByRole('textbox', { name: 'A line' });
    expect(style(outside).borderRadius).toBe(style(inside).borderRadius);
    expect(style(outside).minHeight).toBe(style(inside).minHeight);
    const select = canvas.getByRole('combobox', { name: 'A choice' });
    expect(style(select).borderRadius).toBe(style(inside).borderRadius);

    // A group of fields inside glass is a well, with no blur of its own to cut the glass off.
    const slab = canvas.getByRole('group', { name: 'A group of fields on the canvas' });
    const well = canvas.getByRole('group', { name: 'The same group inside glass: a well' });
    expect(style(slab).backdropFilter).not.toBe('none');
    expect(style(well).backdropFilter).toBe('none');

    // The rim of a card that scrolls gives it no scroll bars of its own.
    const table = canvas.getByRole('region', { name: 'A table' });
    expect(table.scrollHeight).toBeLessThanOrEqual(table.clientHeight);
    expect(table.scrollWidth).toBeLessThanOrEqual(table.clientWidth);

    // Two names for an error, one look.
    expect(style(canvas.getByText('An error on a board.')).backgroundColor).toBe(
      style(canvas.getByText('An error from a form.')).backgroundColor,
    );
    expect(style(canvas.getByText('A page that could not load.')).backgroundColor).toBe(
      style(canvas.getByText('An error from a form.')).backgroundColor,
    );

    // A dialog is floating glass.
    const dialog = canvas.getByRole('region', { name: "A dialog's surface" });
    expect(style(dialog).backdropFilter).toContain('blur');
  },
};
