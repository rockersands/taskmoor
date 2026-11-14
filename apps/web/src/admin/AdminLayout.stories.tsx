import type { Meta, StoryObj } from '@storybook/react-vite';
import { expect, within } from 'storybook/test';
import { I18nProvider } from '../i18n/I18nProvider';
import { SessionProvider } from '../session/SessionProvider';
import { AdminLayout } from './AdminLayout';
import { ADMIN } from './fixtures';

const meta = {
  title: 'Admin/AdminLayout',
  component: AdminLayout,
  args: {
    hash: '#/admin',
    children: <h1 className="page-title">Administración</h1>,
  },
  decorators: [
    (Story) => (
      <I18nProvider locale="es">
        <SessionProvider session={ADMIN}>
          <main style={{ padding: 24 }}>
            <Story />
          </main>
        </SessionProvider>
      </I18nProvider>
    ),
  ],
} satisfies Meta<typeof AdminLayout>;

export default meta;
type Story = StoryObj<typeof meta>;

/** How many lines an element's text is drawn on. */
function linesOf(element: Element): number {
  const range = document.createRange();
  range.selectNodeContents(element);
  return new Set([...range.getClientRects()].map((line) => Math.round(line.top))).size;
}

/**
 * The side list in Spanish, where the group headings are longest: each stays on one line at the
 * list's width (AD-45), "Inicio de sesión y seguridad" and "Tracks y configuración" included.
 */
export const SpanishSideList: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const side = canvas.getByRole('complementary');
    const headings = within(side).getAllByRole('button');
    await expect(headings.map((h) => h.textContent)).toContain('Tracks y configuración');
    await expect(
      headings.flatMap((h) => (linesOf(h) === 1 ? [] : [`${h.textContent}: ${linesOf(h)} lines`])),
    ).toEqual([]);
  },
};
