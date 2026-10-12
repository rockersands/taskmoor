import type { Meta, StoryObj } from '@storybook/react-vite';

/** The design tokens as rendered: colours, spacing and type. Original palette, no borrowed assets. */
const COLORS = [
  'bg',
  'surface',
  'border',
  'text',
  'text-muted',
  'accent',
  'accent-soft',
  'focus',
] as const;
const SPACES = [1, 2, 3, 4, 6, 8] as const;

function Tokens() {
  return (
    <main style={{ padding: 24, display: 'grid', gap: 24 }}>
      <section aria-labelledby="colors">
        <h1 id="colors" className="page-title">
          Colours
        </h1>
        <ul style={{ display: 'flex', flexWrap: 'wrap', gap: 12, listStyle: 'none', padding: 0 }}>
          {COLORS.map((name) => (
            <li key={name} style={{ width: 120 }}>
              <div
                style={{
                  height: 48,
                  borderRadius: 'var(--radius-1)',
                  border: '1px solid var(--color-border)',
                  background: `var(--color-${name})`,
                }}
              />
              <code style={{ fontSize: 'var(--font-size-100)' }}>--color-{name}</code>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="spacing">
        <h2 id="spacing">Spacing</h2>
        <ul style={{ display: 'grid', gap: 8, listStyle: 'none', padding: 0 }}>
          {SPACES.map((n) => (
            <li key={n} style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <div
                style={{
                  width: `var(--space-${n})`,
                  height: 16,
                  background: 'var(--color-accent)',
                }}
              />
              <code>--space-{n}</code>
            </li>
          ))}
        </ul>
      </section>
      <section aria-labelledby="type">
        <h2 id="type">Type</h2>
        <p style={{ fontSize: 'var(--font-size-600)' }}>Page title, 24px</p>
        <p style={{ fontSize: 'var(--font-size-300)' }}>Body, 16px</p>
        <p style={{ fontSize: 'var(--font-size-200)', color: 'var(--color-text-muted)' }}>
          Secondary, 14px muted
        </p>
        <p style={{ fontSize: 'var(--font-size-100)' }}>Caption, 13px</p>
      </section>
    </main>
  );
}

const meta = { title: 'Design/Tokens', component: Tokens } satisfies Meta<typeof Tokens>;
export default meta;

export const Light: StoryObj<typeof meta> = {};

export const Dark: StoryObj<typeof meta> = {
  globals: { backgrounds: { value: 'dark' } },
  parameters: { colorScheme: 'dark' },
};
