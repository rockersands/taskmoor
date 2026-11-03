import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n/I18nProvider';
import { IconSelect } from './IconSelect';
import { PriorityGlyph, PriorityIcon, TypeGlyph, TypeIcon } from './TicketIcons';

const shapeOf = (element: Element) => element.querySelector('svg')?.innerHTML ?? '';

describe('ticket type icons', () => {
  it('[CORE-005] names the type for assistive technology and in a tooltip', () => {
    render(<TypeIcon name="Bug" icon="bug" />);
    expect(screen.getByRole('img', { name: 'Bug' })).toHaveAttribute('title', 'Bug');
  });

  it('[CORE-005] draws a different shape per default type, and one for a custom type', () => {
    const { container } = render(
      <div>
        {['outcome', 'feature', 'bug', 'chore', 'to-do', 'idea', 'subticket', 'rocket'].map(
          (icon) => (
            <TypeIcon key={icon} name={`Named ${icon}`} icon={icon} />
          ),
        )}
      </div>,
    );
    const shapes = [...container.querySelectorAll('.ticket-icon')].map(shapeOf);
    expect(new Set(shapes).size).toBe(8);
  });

  it('[CORE-005] uses the icon an administrator set, then the name, then the plain shape', () => {
    const shape = (node: React.ReactNode) => {
      const { container, unmount } = render(node);
      const out = container.innerHTML;
      unmount();
      return out;
    };
    expect(shape(<TypeGlyph name="Defect" icon="bug" />)).toBe(shape(<TypeGlyph name="Bug" />));
    expect(shape(<TypeGlyph name="Bug" icon={null} />)).toBe(shape(<TypeGlyph name="Bug" />));
    expect(shape(<TypeGlyph name="Spike" />)).toBe(shape(<TypeGlyph name="Other" icon="other" />));
    expect(shape(<TypeGlyph name="constructor" />)).toBe(shape(<TypeGlyph name="Spike" />));
  });
});

describe('priority icons', () => {
  const inEnglish = (node: React.ReactNode) => <I18nProvider locale="en">{node}</I18nProvider>;

  it('[CORE-014] names the priority and draws six shapes from its level, not its name', () => {
    const { container } = render(
      inEnglish(
        <>
          {[1, 2, 3, 4, 5, 6].map((level) => (
            <PriorityIcon key={level} name={`Level ${level}`} level={level} />
          ))}
          <PriorityIcon name="Urgent" level={6} />
        </>,
      ),
    );
    const icons = [...container.querySelectorAll('.ticket-icon')];
    expect(new Set(icons.slice(0, 6).map(shapeOf)).size).toBe(6);
    // A name means nothing to the shape: "Urgent" at the bottom of the order looks like the bottom.
    expect(shapeOf(icons[6] as Element)).toBe(shapeOf(icons[5] as Element));
    expect(screen.getByRole('img', { name: 'Urgent' })).toHaveAttribute('title', 'Urgent');
  });

  it('[CORE-014] shows a seeded name in the reader’s language', () => {
    render(
      <I18nProvider locale="es">
        <PriorityIcon name="Very low" level={6} />
      </I18nProvider>,
    );
    expect(screen.getByRole('img', { name: 'Muy baja' })).toBeInTheDocument();
  });
});

describe('a choice with icons', () => {
  const options = ['High', 'Normal', 'Low'].map((label, i) => ({
    value: String(i + 1),
    label,
    icon: <PriorityGlyph level={i + 2} />,
  }));

  function Picker({ onChange }: { onChange: (value: string) => void }) {
    const [value, setValue] = useState('2');
    return (
      <>
        <label htmlFor="pick">Priority</label>
        <IconSelect
          id="pick"
          value={value}
          options={options}
          onChange={(next) => {
            setValue(next);
            onChange(next);
          }}
        />
        <button type="button">After</button>
      </>
    );
  }

  it('[CORE-014] shows icon and name together and takes a click', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: 'Priority' });
    expect(box).toHaveTextContent('Normal');
    expect(box.querySelectorAll('svg')).toHaveLength(2);
    await user.click(box);
    const list = screen.getByRole('listbox');
    expect(within(list).getByRole('option', { name: 'Normal' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const low = within(list).getByRole('option', { name: 'Low' });
    expect(low.querySelector('svg')).not.toBeNull();
    await user.click(low);
    expect(onChange).toHaveBeenCalledWith('3');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(box).toHaveFocus();
  });

  it('[CORE-014] works by keyboard: arrows, a letter, Enter, Escape and Tab', async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<Picker onChange={onChange} />);
    const box = screen.getByRole('combobox', { name: 'Priority' });
    box.focus();
    await user.keyboard('{ArrowDown}');
    expect(box).toHaveAttribute('aria-expanded', 'true');
    await user.keyboard('{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('3');
    await user.keyboard('{Enter}h{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(onChange).toHaveBeenCalledTimes(1);
    await user.keyboard(' h');
    await user.tab();
    expect(onChange).toHaveBeenLastCalledWith('1');
    expect(screen.getByRole('button', { name: 'After' })).toHaveFocus();
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('[CORE-014] says what to do while nothing is chosen, and a click elsewhere closes it', async () => {
    const user = userEvent.setup();
    render(
      <IconSelect
        aria-label="Priority"
        value=""
        placeholder="Choose"
        options={options}
        onChange={() => {}}
      />,
    );
    const box = screen.getByRole('combobox', { name: 'Priority' });
    expect(box).toHaveTextContent('Choose');
    await user.click(box);
    expect(screen.getByRole('listbox')).toBeVisible();
    await user.click(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});
