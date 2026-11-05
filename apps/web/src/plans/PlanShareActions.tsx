import { useEffect, useId, useRef, useState } from 'react';
import { useT } from '../i18n/I18nProvider';
import { navigate, routeUrl, useRoute } from '../routing/router';
import { planHref } from './address';
import type { Plan, PlanClient } from './client';
import { DuplicatePlanDialog } from './DuplicatePlanDialog';

export interface PlanShareActionsProps {
  plan: Pick<Plan, 'id' | 'name' | 'hiddenSources'>;
  client: Pick<PlanClient, 'duplicate'>;
}

/**
 * The header's actions on every tab of a plan (T-089g; PLN-014). **Copy link** copies the address as
 * it stands, with the view's filters, grouping and position: it gives no access, it is only an
 * address. Where the browser refuses the clipboard (plain http, say) a read-only field holds it,
 * selected. **Duplicate plan** makes the person's own private copy.
 */
export function PlanShareActions({ plan, client }: PlanShareActionsProps) {
  const t = useT();
  const id = useId();
  const route = useRoute();
  const field = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState('');
  const [fallback, setFallback] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState(false);
  const address = routeUrl(route);

  // Where the view moved on, the status no longer speaks of this address.
  // biome-ignore lint/correctness/useExhaustiveDependencies: cleared when the address changes
  useEffect(() => {
    setStatus('');
    setFallback(null);
  }, [address]);

  useEffect(() => {
    if (fallback !== null) field.current?.select();
  }, [fallback]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(address);
      setFallback(null);
      setStatus(t('plans.link.copied'));
    } catch {
      setFallback(address);
      setStatus(t('plans.link.refused'));
    }
  };

  return (
    <>
      <button type="button" className="button-secondary" onClick={() => void copy()}>
        {t('plans.link.copy')}
      </button>
      <button type="button" className="button-secondary" onClick={() => setDuplicating(true)}>
        {t('plans.duplicate')}
      </button>
      <div className="plan-share-status">
        {/* Polite and always there, without being the page's one status line, which a tab has. */}
        <p className="board-hint" aria-live="polite" aria-atomic="true">
          {status}
        </p>
        {fallback !== null && (
          <label className="form-field" htmlFor={`${id}-link`}>
            <span className="form-label">{t('plans.link.field')}</span>
            <input
              ref={field}
              id={`${id}-link`}
              readOnly
              value={fallback}
              onFocus={(event) => event.target.select()}
            />
          </label>
        )}
      </div>
      {duplicating && (
        <DuplicatePlanDialog
          name={plan.name}
          hiddenSources={plan.hiddenSources}
          onDuplicate={(name) => client.duplicate(plan.id, name)}
          onOpen={(copied) => {
            setDuplicating(false);
            navigate(planHref(copied));
          }}
          onClose={() => setDuplicating(false)}
        />
      )}
    </>
  );
}
