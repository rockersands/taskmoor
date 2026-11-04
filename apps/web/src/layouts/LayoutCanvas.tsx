import { type PointerEvent as ReactPointerEvent, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { type GripItem, GripMenu } from './GripMenu';
import {
  addSection,
  addTab,
  type Draft,
  type DraftSection,
  type DraftTab,
  findField,
  findSection,
  MAX_SECTIONS,
  MAX_TAB_NAME,
  MAX_TABS,
  moveSection,
  moveTab,
  placedKeys,
  placeField,
  removeField,
  removeSection,
  removeTab,
  renameTab,
  type SectionKind,
  stepField,
  stepSection,
  stepTab,
  updateSection,
} from './model';

export interface LayoutCanvasProps {
  draft: Draft;
  onChange: (next: Draft) => void;
  /** Every field a layout of this set may place, in palette order. */
  fieldKeys: string[];
  fieldName: (key: string) => string;
}

/** What is being dragged. */
type DragItem =
  | { kind: 'field'; key: string; placed: boolean; name: string }
  | { kind: 'section'; id: string; name: string }
  | { kind: 'tab'; id: string; name: string };

/** Where a drop would land. */
type Drop =
  | { kind: 'field-at'; sectionId: string; index: number }
  | { kind: 'palette' }
  | { kind: 'section-at'; tabId: string; index: number }
  | { kind: 'tab-at'; index: number };

/** How far a pointer moves before a press on a grip becomes a drag, in pixels. */
const DRAG_START = 6;
/** Near the top or bottom of the window, by this much, a drag scrolls the page. */
const SCROLL_EDGE = 48;
const SCROLL_STEP = 16;

/**
 * The layout of one form (UI-T15; ADR-114 section 8; CORE-008): the fields not placed, then the
 * tabs, each with its sections (main or side column) and their fields. Fields are dragged from
 * the list into a section, between sections and back; sections and tabs are dragged into place.
 * Pointer events carry the drags, so a mouse and a finger work alike, and every drag is also in
 * the grip's menu and on Alt and the arrow keys, each move announced.
 */
export function LayoutCanvas({ draft, onChange, fieldKeys, fieldName }: LayoutCanvasProps) {
  const t = useT();
  const id = useId();
  const [drag, setDrag] = useState<DragItem | null>(null);
  const [ghost, setGhost] = useState<{ x: number; y: number } | null>(null);
  const [over, setOver] = useState<Drop | null>(null);
  const [said, setSaid] = useState('');
  const saying = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  /** The grip, or other control, to focus once a change shows. */
  const pendingFocus = useRef<string | null>(null);
  const dragEnded = useRef({ handle: '', at: Number.NEGATIVE_INFINITY });
  const live = useRef(draft);
  live.current = draft;

  /**
   * Tells screen readers what changed. The status empties first and takes the words a moment
   * later, so the same words twice in a row are announced twice.
   */
  const say = (words: string) => {
    clearTimeout(saying.current);
    setSaid('');
    saying.current = setTimeout(() => setSaid(words), 60);
  };
  useEffect(() => () => clearTimeout(saying.current), []);

  // biome-ignore lint/correctness/useExhaustiveDependencies: runs after each change shows
  useEffect(() => {
    const handle = pendingFocus.current;
    if (!handle) return;
    pendingFocus.current = null;
    // Handles are made of field keys (`cf[12]`) and generated ids, never quotes.
    document.querySelector<HTMLElement>(`[data-handle="${handle}"]`)?.focus();
  }, [draft]);

  const tabLabel = (tab: DraftTab) => tab.name.trim() || t('layouts.untitledTab');
  const sectionName = (next: Draft, sectionId: string) => {
    const at = findSection(next, sectionId);
    if (!at) return '';
    return t('layouts.sectionName', {
      tab: tabLabel(at.tab),
      position: at.index + 1,
      kind: at.section.kind,
    });
  };

  const apply = (next: Draft, words: (next: Draft) => string, focus: string | null) => {
    pendingFocus.current = focus;
    onChange(next);
    say(words(next));
  };

  /** Where a field is now, in words. */
  const fieldPlace = (key: string) => (next: Draft) => {
    const at = findField(next, key);
    if (!at) return t('layouts.announce.fieldOff', { field: fieldName(key) });
    return t('layouts.announce.field', {
      field: fieldName(key),
      position: at.index + 1,
      count: at.section.fields.length,
      section: sectionName(next, at.section.id),
    });
  };

  const placeAt = (key: string, sectionId: string, index: number) =>
    apply(placeField(live.current, key, sectionId, index), fieldPlace(key), `field-${key}`);
  const takeOff = (key: string) =>
    apply(removeField(live.current, key), fieldPlace(key), `palette-${key}`);
  const stepFieldBy = (key: string, direction: -1 | 1) => {
    const next = stepField(live.current, key, direction);
    if (next) apply(next, fieldPlace(key), `field-${key}`);
  };

  const sectionPlace = (sectionId: string) => (next: Draft) =>
    t('layouts.announce.section', { section: sectionName(next, sectionId) });
  const moveSectionTo = (sectionId: string, tabId: string, index: number) =>
    apply(
      moveSection(live.current, sectionId, tabId, index),
      sectionPlace(sectionId),
      `section-${sectionId}`,
    );
  const stepSectionBy = (sectionId: string, direction: -1 | 1) => {
    const next = stepSection(live.current, sectionId, direction);
    if (next) apply(next, sectionPlace(sectionId), `section-${sectionId}`);
  };

  const tabPlace = (tabId: string) => (next: Draft) => {
    const index = next.tabs.findIndex((tab) => tab.id === tabId);
    const tab = next.tabs[index];
    return tab
      ? t('layouts.announce.tab', {
          name: tabLabel(tab),
          position: index + 1,
          count: next.tabs.length,
        })
      : '';
  };
  const moveTabTo = (tabId: string, index: number) =>
    apply(moveTab(live.current, tabId, index), tabPlace(tabId), `tab-${tabId}`);
  const stepTabBy = (tabId: string, direction: -1 | 1) => {
    const next = stepTab(live.current, tabId, direction);
    if (next) apply(next, tabPlace(tabId), `tab-${tabId}`);
  };

  /** What is under the pointer, as a place this drag may land. */
  function dropAt(x: number, y: number, item: DragItem): Drop | null {
    const element = document.elementFromPoint?.(x, y);
    if (!element) return null;
    const draftNow = live.current;
    if (item.kind === 'field') {
      const field = element.closest<HTMLElement>('[data-drop="field"]');
      if (field?.dataset.sectionId) {
        const box = field.getBoundingClientRect();
        const index = Number(field.dataset.index) + (y < box.top + box.height / 2 ? 0 : 1);
        return { kind: 'field-at', sectionId: field.dataset.sectionId, index };
      }
      const section = element.closest<HTMLElement>('[data-drop="section"]');
      if (section?.dataset.sectionId) {
        const at = findSection(draftNow, section.dataset.sectionId);
        return {
          kind: 'field-at',
          sectionId: section.dataset.sectionId,
          index: at?.section.fields.length ?? 0,
        };
      }
      return item.placed && element.closest('[data-drop="palette"]') ? { kind: 'palette' } : null;
    }
    if (item.kind === 'section') {
      const section = element.closest<HTMLElement>('[data-drop="section"]');
      const target = section?.dataset.sectionId
        ? findSection(draftNow, section.dataset.sectionId)
        : null;
      if (target) {
        if (target.section.id === item.id) return null;
        // It takes the target's place: counted without the dragged one, that lands after the
        // target when it came from before it in the same tab, and before it otherwise.
        return { kind: 'section-at', tabId: target.tab.id, index: target.index };
      }
      const tab = element.closest<HTMLElement>('[data-drop="tab"]');
      const holder = draftNow.tabs.find((x) => x.id === tab?.dataset.tabId);
      if (!holder) return null;
      return {
        kind: 'section-at',
        tabId: holder.id,
        index: holder.sections.filter((s) => s.id !== item.id).length,
      };
    }
    const tab = element.closest<HTMLElement>('[data-drop="tab"]');
    const index = draftNow.tabs.findIndex((x) => x.id === tab?.dataset.tabId);
    if (index < 0 || draftNow.tabs[index]?.id === item.id) return null;
    return { kind: 'tab-at', index };
  }

  function dropOn(item: DragItem, to: Drop) {
    if (item.kind === 'field') {
      if (to.kind === 'palette') takeOff(item.key);
      else if (to.kind === 'field-at') placeAt(item.key, to.sectionId, to.index);
    } else if (item.kind === 'section' && to.kind === 'section-at') {
      moveSectionTo(item.id, to.tabId, to.index);
    } else if (item.kind === 'tab' && to.kind === 'tab-at') {
      moveTabTo(item.id, to.index);
    }
  }

  const handleOf = (item: DragItem) =>
    item.kind === 'field'
      ? `${item.placed ? 'field' : 'palette'}-${item.key}`
      : `${item.kind}-${item.id}`;

  function beginDrag(event: ReactPointerEvent<HTMLButtonElement>, item: DragItem) {
    if (event.pointerType === 'mouse' && event.button !== 0) return;
    const start = { x: event.clientX, y: event.clientY };
    const pointerId = event.pointerId;
    let moving = false;
    const onMove = (e: PointerEvent) => {
      if (e.pointerId !== pointerId) return;
      if (!moving) {
        if (Math.hypot(e.clientX - start.x, e.clientY - start.y) < DRAG_START) return;
        moving = true;
        setDrag(item);
      }
      e.preventDefault();
      // A long layout on a phone: holding near an edge brings the rest into reach.
      if (e.clientY < SCROLL_EDGE) window.scrollBy(0, -SCROLL_STEP);
      else if (e.clientY > window.innerHeight - SCROLL_EDGE) window.scrollBy(0, SCROLL_STEP);
      setGhost({ x: e.clientX, y: e.clientY });
      setOver(dropAt(e.clientX, e.clientY, item));
    };
    const finish = (e: PointerEvent, landed: boolean) => {
      if (e.pointerId !== pointerId) return;
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      if (!moving) return;
      dragEnded.current = { handle: handleOf(item), at: performance.now() };
      const to = landed ? dropAt(e.clientX, e.clientY, item) : null;
      setDrag(null);
      setGhost(null);
      setOver(null);
      if (to) dropOn(item, to);
    };
    const onUp = (e: PointerEvent) => finish(e, true);
    const onCancel = (e: PointerEvent) => finish(e, false);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
  }

  const justDragged = (handle: string) =>
    dragEnded.current.handle === handle && performance.now() - dragEnded.current.at < 300;

  const sections = draft.tabs.flatMap((tab) => tab.sections);
  const placed = new Set(placedKeys(draft));
  const unplaced = fieldKeys.filter((key) => !placed.has(key));

  const placedFieldItems = (key: string, section: DraftSection): GripItem[] => {
    const items: GripItem[] = [];
    if (stepField(draft, key, -1)) {
      items.push({
        key: 'earlier',
        label: t('layouts.moveEarlier'),
        onSelect: () => stepFieldBy(key, -1),
      });
    }
    if (stepField(draft, key, 1)) {
      items.push({
        key: 'later',
        label: t('layouts.moveLater'),
        onSelect: () => stepFieldBy(key, 1),
      });
    }
    for (const other of sections) {
      if (other.id === section.id) continue;
      items.push({
        key: `to-${other.id}`,
        label: t('layouts.moveTo', { section: sectionName(draft, other.id) }),
        onSelect: () => placeAt(key, other.id, other.fields.length),
      });
    }
    items.push({ key: 'off', label: t('layouts.takeOff'), onSelect: () => takeOff(key) });
    return items;
  };

  const paletteItems = (key: string): GripItem[] =>
    sections.map((section) => ({
      key: `to-${section.id}`,
      label: t('layouts.putIn', { section: sectionName(draft, section.id) }),
      onSelect: () => placeAt(key, section.id, section.fields.length),
    }));

  const sectionItems = (tab: DraftTab, section: DraftSection, index: number): GripItem[] => {
    const items: GripItem[] = [];
    if (index > 0) {
      items.push({
        key: 'earlier',
        label: t('layouts.moveEarlier'),
        onSelect: () => stepSectionBy(section.id, -1),
      });
    }
    if (index < tab.sections.length - 1) {
      items.push({
        key: 'later',
        label: t('layouts.moveLater'),
        onSelect: () => stepSectionBy(section.id, 1),
      });
    }
    for (const other of draft.tabs) {
      if (other.id === tab.id || other.sections.length >= MAX_SECTIONS) continue;
      items.push({
        key: `to-${other.id}`,
        label: t('layouts.moveToTab', { name: tabLabel(other) }),
        onSelect: () => moveSectionTo(section.id, other.id, other.sections.length),
      });
    }
    return items;
  };

  const tabItems = (index: number, tab: DraftTab): GripItem[] => {
    const items: GripItem[] = [];
    if (index > 0) {
      items.push({
        key: 'earlier',
        label: t('layouts.moveEarlier'),
        onSelect: () => stepTabBy(tab.id, -1),
      });
    }
    if (index < draft.tabs.length - 1) {
      items.push({
        key: 'later',
        label: t('layouts.moveLater'),
        onSelect: () => stepTabBy(tab.id, 1),
      });
    }
    return items;
  };

  const isOverField = (sectionId: string, index: number) =>
    over?.kind === 'field-at' && over.sectionId === sectionId && over.index === index;
  const isOverSection = (sectionId: string) => {
    if (over?.kind === 'field-at') return over.sectionId === sectionId;
    if (over?.kind !== 'section-at') return false;
    const at = findSection(draft, sectionId);
    return at?.tab.id === over.tabId && at.index === over.index;
  };

  function fieldChip(key: string, section: DraftSection, index: number) {
    const name = fieldName(key);
    const dragging = drag?.kind === 'field' && drag.key === key;
    return (
      <li
        key={key}
        className={`layout-field${dragging ? ' is-dragging' : ''}${
          isOverField(section.id, index) ? ' is-drop-before' : ''
        }`}
        data-drop="field"
        data-section-id={section.id}
        data-index={index}
      >
        <GripMenu
          label={t('layouts.fieldActions', { field: name })}
          handle={`field-${key}`}
          items={placedFieldItems(key, section)}
          justDragged={justDragged}
          onStep={(d) => stepFieldBy(key, d)}
          onDragStart={(event) => beginDrag(event, { kind: 'field', key, placed: true, name })}
        />
        <span className="layout-field-name">{name}</span>
      </li>
    );
  }

  function sectionCard(tab: DraftTab, section: DraftSection, index: number) {
    // The full name, with its tab, labels the section and its controls; the heading inside a
    // tab's card says only which section it is.
    const title = sectionName(draft, section.id);
    const titleId = `${id}-section-${section.id}`;
    const hintId = `${id}-section-${section.id}-hint`;
    const dragging = drag?.kind === 'section' && drag.id === section.id;
    return (
      <li key={section.id} className={`layout-section${dragging ? ' is-dragging' : ''}`}>
        {/* biome-ignore lint/a11y/useSemanticElements: it holds a grip, a heading and fields to move, not one set of form fields */}
        <div
          role="group"
          aria-label={title}
          className={`layout-section-box is-${section.kind}${
            isOverSection(section.id) ? ' is-drop-target' : ''
          }`}
          data-drop="section"
          data-section-id={section.id}
        >
          <div className="layout-section-head">
            <GripMenu
              label={t('layouts.sectionActions', { section: title })}
              handle={`section-${section.id}`}
              items={sectionItems(tab, section, index)}
              justDragged={justDragged}
              onStep={(d) => stepSectionBy(section.id, d)}
              onDragStart={(event) =>
                beginDrag(event, { kind: 'section', id: section.id, name: title })
              }
            />
            <h3 className="layout-section-title">
              {t('layouts.sectionTitle', { position: index + 1, kind: section.kind })}
            </h3>
            <button
              type="button"
              className="button-secondary layout-remove"
              aria-label={t('layouts.removeSection', { section: title })}
              onClick={() => {
                const at = findSection(live.current, section.id);
                apply(
                  removeSection(live.current, section.id),
                  () => t('layouts.announce.sectionRemoved', { section: title }),
                  at ? `add-section-${at.tab.id}` : null,
                );
              }}
            >
              {t('layouts.remove')}
            </button>
          </div>
          <div className="layout-section-settings">
            <div className="form-field">
              <label htmlFor={`${titleId}-kind`} className="form-label">
                {t('layouts.column')}
              </label>
              <select
                id={`${titleId}-kind`}
                value={section.kind}
                onChange={(event) =>
                  onChange(
                    updateSection(live.current, section.id, {
                      kind: event.target.value as SectionKind,
                    }),
                  )
                }
              >
                <option value="main">{t('layouts.column.main')}</option>
                <option value="context">{t('layouts.column.context')}</option>
              </select>
            </div>
            <div className="form-field form-field-inline">
              <input
                id={`${titleId}-empty`}
                type="checkbox"
                checked={section.hideWhenEmpty}
                aria-describedby={hintId}
                onChange={(event) =>
                  onChange(
                    updateSection(live.current, section.id, {
                      hideWhenEmpty: event.target.checked,
                    }),
                  )
                }
              />
              <label htmlFor={`${titleId}-empty`}>{t('layouts.hideWhenEmpty')}</label>
            </div>
            <p id={hintId} className="form-hint">
              {t('layouts.hideWhenEmptyHint')}
            </p>
          </div>
          {section.fields.length === 0 ? (
            <p className="page-note layout-section-empty">{t('layouts.sectionEmpty')}</p>
          ) : (
            <ol className="layout-fields" aria-label={t('layouts.fieldsIn', { section: title })}>
              {section.fields.map((key, i) => fieldChip(key, section, i))}
            </ol>
          )}
        </div>
      </li>
    );
  }

  function tabCard(tab: DraftTab, index: number) {
    const titleId = `${id}-tab-${tab.id}`;
    const nameId = `${id}-tab-${tab.id}-name`;
    const label = tabLabel(tab);
    const dragging = drag?.kind === 'tab' && drag.id === tab.id;
    const target = over?.kind === 'tab-at' && over.index === index;
    return (
      <li
        key={tab.id}
        className={`layout-tab glass-card${dragging ? ' is-dragging' : ''}${
          target ? ' is-drop-target' : ''
        }`}
        data-drop="tab"
        data-tab-id={tab.id}
      >
        {/* biome-ignore lint/a11y/useSemanticElements: it holds a grip, a heading and sections to move, not one set of form fields */}
        <div role="group" aria-labelledby={titleId} className="layout-tab-box">
          <div className="layout-tab-head">
            <GripMenu
              label={t('layouts.tabActions', { name: label })}
              handle={`tab-${tab.id}`}
              items={tabItems(index, tab)}
              justDragged={justDragged}
              onStep={(d) => stepTabBy(tab.id, d)}
              onDragStart={(event) => beginDrag(event, { kind: 'tab', id: tab.id, name: label })}
            />
            <h2 id={titleId} className="layout-tab-title">
              {t('layouts.tabTitle', { position: index + 1, name: label })}
            </h2>
            <button
              type="button"
              className="button-secondary layout-remove"
              aria-label={t('layouts.removeTab', { name: label })}
              onClick={() =>
                apply(
                  removeTab(live.current, tab.id),
                  () => t('layouts.announce.tabRemoved', { name: label }),
                  'add-tab',
                )
              }
            >
              {t('layouts.remove')}
            </button>
          </div>
          <div className="form-field layout-tab-name">
            <label htmlFor={nameId} className="form-label">
              {t('layouts.tabName')}
            </label>
            <input
              id={nameId}
              type="text"
              required
              maxLength={MAX_TAB_NAME}
              value={tab.name}
              data-handle={`tab-name-${tab.id}`}
              onChange={(event) => onChange(renameTab(live.current, tab.id, event.target.value))}
            />
          </div>
          <ol className="layout-sections">
            {tab.sections.map((section, i) => sectionCard(tab, section, i))}
          </ol>
          <div className="layout-tab-actions">
            <button
              type="button"
              className="button-secondary"
              data-handle={`add-section-${tab.id}`}
              disabled={tab.sections.length >= MAX_SECTIONS}
              aria-label={t('layouts.addSectionTo', { name: label })}
              onClick={() => {
                const before = new Set(
                  live.current.tabs.flatMap((x) => x.sections.map((s) => s.id)),
                );
                const next = addSection(live.current, tab.id, 'main');
                const made = next.tabs.flatMap((x) => x.sections).find((s) => !before.has(s.id));
                apply(
                  next,
                  (shown) =>
                    made
                      ? t('layouts.announce.sectionAdded', {
                          section: sectionName(shown, made.id),
                        })
                      : '',
                  made ? `section-${made.id}` : null,
                );
              }}
            >
              {t('layouts.addSection')}
            </button>
            {tab.sections.length >= MAX_SECTIONS && (
              <span className="form-hint">
                {t('layouts.sectionLimit', { count: MAX_SECTIONS })}
              </span>
            )}
          </div>
        </div>
      </li>
    );
  }

  return (
    <div className="layout-canvas">
      <p role="status" className="visually-hidden">
        {said}
      </p>
      <section
        aria-labelledby={`${id}-palette`}
        className={`layout-palette glass-card${over?.kind === 'palette' ? ' is-drop-target' : ''}`}
        data-drop="palette"
      >
        <h2 id={`${id}-palette`} className="section-title">
          {t('layouts.palette')}
        </h2>
        <p className="form-hint">{t('layouts.paletteHint')}</p>
        {unplaced.length === 0 ? (
          <p className="page-note">{t('layouts.allPlaced')}</p>
        ) : (
          <ul className="layout-fields">
            {unplaced.map((key) => {
              const name = fieldName(key);
              return (
                <li key={key} className="layout-field is-unplaced">
                  <GripMenu
                    label={t('layouts.placeActions', { field: name })}
                    handle={`palette-${key}`}
                    items={paletteItems(key)}
                    justDragged={justDragged}
                    onDragStart={(event) =>
                      beginDrag(event, { kind: 'field', key, placed: false, name })
                    }
                  />
                  <span className="layout-field-name">{name}</span>
                </li>
              );
            })}
          </ul>
        )}
        {sections.length === 0 && unplaced.length > 0 && (
          <p className="form-hint">{t('layouts.noSections')}</p>
        )}
      </section>
      <div className="layout-board">
        {draft.tabs.length === 0 ? (
          <p className="page-note">{t('layouts.noTabs')}</p>
        ) : (
          <ol className="layout-tabs" aria-label={t('layouts.tabs')}>
            {draft.tabs.map(tabCard)}
          </ol>
        )}
        <div className="layout-tab-actions">
          <button
            type="button"
            className="button-secondary"
            data-handle="add-tab"
            disabled={draft.tabs.length >= MAX_TABS}
            onClick={() => {
              const name = t('layouts.newTab', { position: live.current.tabs.length + 1 });
              const next = addTab(live.current, name);
              const made = next.tabs[next.tabs.length - 1];
              apply(
                next,
                () => t('layouts.announce.tabAdded', { name }),
                made ? `tab-name-${made.id}` : null,
              );
            }}
          >
            {t('layouts.addTab')}
          </button>
          {draft.tabs.length >= MAX_TABS && (
            <span className="form-hint">{t('layouts.tabLimit', { count: MAX_TABS })}</span>
          )}
        </div>
      </div>
      {drag && ghost && (
        <div
          className="layout-drag-ghost"
          aria-hidden="true"
          style={{ transform: `translate(${ghost.x + 12}px, ${ghost.y + 12}px)` }}
        >
          {drag.name}
        </div>
      )}
    </div>
  );
}
