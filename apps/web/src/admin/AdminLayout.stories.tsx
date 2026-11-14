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

/**
 * A long page at a desktop width (D18, AD-11): the side list starts in line with the breadcrumb
 * and stays beside the page while it scrolls, stopping in line with the app's sidebar (the top
 * bar's height and two of the shell's gaps). The glass card's `position: relative` once won the
 * cascade, so the list scrolled away and sat lower than the breadcrumb by its `top`.
 */
export const StaysBesideALongPage: Story = {
  // Below the top bar, as the app's frame puts every page.
  decorators: [
    (Story) => (
      <div style={{ paddingTop: 'calc(var(--topbar-height) + 2 * var(--shell-gap))' }}>
        <Story />
      </div>
    ),
  ],
  args: {
    hash: '#/admin/imports',
    children: (
      <section className="page">
        <h1 className="page-title">Importaciones</h1>
        <div style={{ height: 3000 }} />
      </section>
    ),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const side = canvas.getByRole('complementary');
    const crumbs = canvas.getByRole('navigation', { name: 'Dónde está esta página' });
    await expect(getComputedStyle(side).position).toBe('sticky');
    await expect(
      Math.round(side.getBoundingClientRect().top - crumbs.getBoundingClientRect().top),
    ).toBe(0);
    const root = getComputedStyle(document.documentElement);
    const stop =
      Number.parseFloat(root.getPropertyValue('--topbar-height')) +
      2 * Number.parseFloat(root.getPropertyValue('--shell-gap'));
    window.scrollTo(0, 1500);
    await new Promise((done) => requestAnimationFrame(() => done(null)));
    try {
      await expect(Math.round(side.getBoundingClientRect().top)).toBe(Math.round(stop));
    } finally {
      window.scrollTo(0, 0);
    }
  },
};
