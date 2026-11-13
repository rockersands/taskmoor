import { useId, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { Popover } from '../shell/Popover';
import type { BoardPeople } from './client';

/** One choice of the person filter: `me`, `none`, or a person's id, as the server reads it. */
const CHOICE = /^(me|none|\d{1,9})$/;
/** Longer lists than this get a box to find a name in. */
const FIND_FROM = 8;

/** The person filter in a route (`#/boards/7?people=me,12`); anything else in it is dropped. */
export function peopleFromRoute(route: string): string[] {
  const query = route.split('?')[1] ?? '';
  const given = new URLSearchParams(query).get('people') ?? '';
  return [...new Set(given.split(',').filter((c) => CHOICE.test(c)))].slice(0, 50);
}

/** The route with this person filter in it, keeping what else it says. */
export function routeWithPeople(route: string, people: readonly string[]): string {
  const [path = '', query = ''] = route.split('?');
  const rest = query.split('&').filter((part) => part !== '' && !part.startsWith('people='));
  if (people.length > 0) rest.push(`people=${people.join(',')}`);
  return rest.length > 0 ? `${path}?${rest.join('&')}` : path;
}

export interface BoardPeopleFilterProps {
  people: BoardPeople;
  /** The choices on, as in the address. */
  chosen: readonly string[];
  onChange: (chosen: string[]) => void;
}

/**
 * Filtering a board by person (AGL-005 (3)): "Me" and "Unassigned" at hand, the people assigned to
 * the board's tickets in a popover, and those chosen shown so that a shared link says what it
 * filters by. Choosing several shows any of them. Every step is a button, a check box or a text
 * box, so it works from the keyboard and on a phone.
 */
export function BoardPeopleFilter({ people, chosen, onChange }: BoardPeopleFilterProps) {
  const t = useT();
  const id = useId();
  const [find, setFind] = useState('');
  const viewer = people.viewerId === null ? null : String(people.viewerId);
  const others = people.assignees.filter((p) => String(p.id) !== viewer);
  const isMe = chosen.includes('me') || (viewer !== null && chosen.includes(viewer));
  const named = chosen.filter((c) => c !== 'me' && c !== 'none' && c !== viewer);
  const nameOf = new Map(others.map((p) => [String(p.id), p.name]));
  const toggle = (choice: string, on: boolean) =>
    onChange(on ? [...chosen, choice] : chosen.filter((c) => c !== choice));
  const needle = find.trim().toLowerCase();
  const listed = others.filter((p) => p.name.toLowerCase().includes(needle));
  return (
    <fieldset className="filter-chips">
      <legend className="visually-hidden">{t('boards.people')}</legend>
      <button
        type="button"
        className="filter-chip"
        aria-pressed={isMe}
        onClick={() =>
          onChange(isMe ? chosen.filter((c) => c !== 'me' && c !== viewer) : [...chosen, 'me'])
        }
      >
        {t('boards.people.me')}
      </button>
      <button
        type="button"
        className="filter-chip"
        aria-pressed={chosen.includes('none')}
        onClick={() => toggle('none', !chosen.includes('none'))}
      >
        {t('boards.card.unassigned')}
      </button>
      {named.map((choice) => (
        <button
          key={choice}
          type="button"
          className="filter-chip"
          aria-pressed="true"
          onClick={() => toggle(choice, false)}
        >
          {nameOf.get(choice) ?? t('boards.people.notHere')}
        </button>
      ))}
      <Popover
        label={t('boards.people.menu', { count: named.length })}
        title={t('boards.people.title')}
        on={named.length > 0}
      >
        {others.length === 0 ? (
          <p className="page-note">{t('boards.people.nobody')}</p>
        ) : (
          <>
            {others.length > FIND_FROM && (
              <div className="form-field">
                <label htmlFor={`${id}-find`} className="form-label">
                  {t('boards.people.find')}
                </label>
                <input
                  id={`${id}-find`}
                  type="search"
                  value={find}
                  onChange={(event) => setFind(event.target.value)}
                />
              </div>
            )}
            <ul className="popover-list thin-scroll">
              {listed.map((person) => (
                <li key={person.id}>
                  <label className="check-row">
                    <input
                      type="checkbox"
                      checked={chosen.includes(String(person.id))}
                      onChange={(event) => toggle(String(person.id), event.target.checked)}
                    />
                    <span>{person.name}</span>
                  </label>
                </li>
              ))}
            </ul>
            {listed.length === 0 && <p className="page-note">{t('boards.people.noMatch')}</p>}
            {people.more && (
              <p className="page-note">
                {t('boards.people.more', { count: people.assignees.length })}
              </p>
            )}
          </>
        )}
      </Popover>
      {chosen.length > 0 && (
        <button
          type="button"
          className="button-quiet board-people-clear"
          onClick={() => onChange([])}
        >
          {t('boards.people.clear')}
        </button>
      )}
    </fieldset>
  );
}
