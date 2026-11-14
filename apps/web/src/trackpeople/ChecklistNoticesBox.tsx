import { type ReactNode, useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { TrackPeopleClient } from './client';

export interface ChecklistNoticesBoxProps {
  /** The id of its heading, for the card that names itself after it. */
  titleId?: string;
  track: { id: number; key: string };
  /** What the track has stored. */
  on: boolean;
  client: Pick<TrackPeopleClient, 'setChecklistNotices'>;
  /** Says what changed, for the page to say beside the box. */
  onSaid: (text: string) => void;
  /** A refusal, for the page to say why beside the box. */
  onRefused: (error: unknown) => void;
  /** What the page says about the last change, shown right under the box (T-248). */
  answer?: ReactNode;
}

/**
 * Whether a track's followers hear of checklist changes (T-196a; NTF-015): a choice of whoever
 * runs the track, off until they turn it on. It saves as soon as it is ticked, and goes back if
 * the server refuses; the page says either way. What followers then get, and when, is the
 * server's: their own channel choices, never their own changes, one notice for a run.
 */
export function ChecklistNoticesBox({
  titleId,
  track,
  on: stored,
  client,
  onSaid,
  onRefused,
  answer,
}: ChecklistNoticesBoxProps) {
  const t = useT();
  const id = useId();
  const [on, setOn] = useState(stored);
  // One save at a time; the box stays usable, so focus never leaves it.
  const busy = useRef(false);
  useEffect(() => setOn(stored), [stored]);

  const turn = async (next: boolean) => {
    if (busy.current) return;
    busy.current = true;
    setOn(next);
    try {
      const saved = await client.setChecklistNotices(track.id, next);
      setOn(saved);
      onSaid(
        t(saved ? 'trackPeople.noticesOnSaid' : 'trackPeople.noticesOffSaid', { key: track.key }),
      );
    } catch (error) {
      setOn(!next);
      onRefused(error);
    } finally {
      busy.current = false;
    }
  };

  return (
    <>
      <h2 id={titleId} className="facts-title">
        {t('trackPeople.notices')}
      </h2>
      <div className="form-field form-field-inline">
        <input
          id={`${id}-box`}
          type="checkbox"
          checked={on}
          aria-describedby={`${id}-hint`}
          onChange={(event) => void turn(event.target.checked)}
        />
        <label htmlFor={`${id}-box`}>{t('trackPeople.checklistNotices')}</label>
      </div>
      {answer}
      <p id={`${id}-hint`} className="form-hint">
        {t('trackPeople.checklistNoticesHint')}
      </p>
    </>
  );
}
