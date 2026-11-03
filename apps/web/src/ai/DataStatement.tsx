import { useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import type { MessageId } from '../i18n/messages.en';

/**
 * What leaves this instance for AI (M1-077; IAM-022 (2)), as `GET /api/v1/admin/ai/statement`
 * and `GET /api/v1/ai/notice` answer: the provider and region, what each feature sends, the
 * redaction in force (administrators only), and what is never sent.
 */
export type DataKind =
  | 'question'
  | 'ticket-fields'
  | 'comments'
  | 'field-names'
  | 'track-settings'
  | 'pasted-text'
  | 'candidate-tickets'
  | 'tool-results';

export type AiFeatureId = 'summarize' | 'query-from-text' | 'assisted-creation' | 'duplicates';

export interface DataStatement {
  configured: boolean;
  provider: string | null;
  region: string | null;
  features: { id: string; enabled: boolean; model: string; effort: string; sends: DataKind[] }[];
  redaction?: { patterns: string[]; terms: number; fields: string[] };
  contentDays: number;
  neverSent: string[];
}

export const FEATURE_NAMES: Record<string, MessageId> = {
  summarize: 'ai.statement.feature.summarize',
  'query-from-text': 'ai.statement.feature.queryFromText',
  'assisted-creation': 'ai.statement.feature.assistedCreation',
  duplicates: 'ai.statement.feature.duplicates',
};

const DATA_NAMES: Record<DataKind, MessageId> = {
  question: 'ai.data.question',
  'ticket-fields': 'ai.data.ticketFields',
  comments: 'ai.data.comments',
  'field-names': 'ai.data.fieldNames',
  'track-settings': 'ai.data.trackSettings',
  'pasted-text': 'ai.data.pastedText',
  'candidate-tickets': 'ai.data.candidateTickets',
  'tool-results': 'ai.data.toolResults',
};

const NEVER_NAMES: Record<string, MessageId> = {
  'hidden-tickets': 'ai.never.hiddenTickets',
  'hidden-fields': 'ai.never.hiddenFields',
  'redacted-fields': 'ai.never.redactedFields',
  attachments: 'ai.never.attachments',
  credentials: 'ai.never.credentials',
};

const PATTERN_NAMES: Record<string, MessageId> = {
  'card-number': 'ai.pattern.cardNumber',
  iban: 'ai.pattern.iban',
  'us-ssn': 'ai.pattern.usSsn',
  email: 'ai.pattern.email',
};

const PROVIDER_NAMES: Record<string, MessageId> = {
  anthropic: 'ai.statement.provider.anthropic',
  bedrock: 'ai.statement.provider.bedrock',
  vertex: 'ai.statement.provider.vertex',
  foundry: 'ai.statement.provider.foundry',
  'openai-compatible': 'ai.statement.provider.openaiCompatible',
};

/** A feature's name in the reader's language; an unknown one by its ID. */
export function useFeatureName(): (id: string) => string {
  const t = useT();
  return (id) => {
    const name = FEATURE_NAMES[id];
    return name ? t(name) : id;
  };
}

export function DataStatementView({
  statement,
  headingLevel = 2,
}: {
  statement: DataStatement;
  headingLevel?: 2 | 3;
}) {
  const t = useT();
  const featureName = useFeatureName();
  const titleId = useId();
  const Heading = headingLevel === 2 ? 'h2' : 'h3';
  const provider = statement.provider
    ? PROVIDER_NAMES[statement.provider]
      ? t(PROVIDER_NAMES[statement.provider] as MessageId)
      : statement.provider
    : '';
  const enabled = statement.features.filter((f) => f.enabled);
  return (
    <section aria-labelledby={titleId} className="ai-statement">
      <Heading id={titleId} className="facts-title">
        {t('ai.statement.title')}
      </Heading>
      {!statement.configured ? (
        <p className="page-note">{t('ai.statement.notConfigured')}</p>
      ) : (
        <>
          <p>
            {statement.region
              ? t('ai.statement.providerRegion', { provider, region: statement.region })
              : t('ai.statement.provider', { provider })}
          </p>
          <ul className="ai-statement-features">
            {enabled.map((feature) => (
              <li key={feature.id}>
                <strong>{featureName(feature.id)}</strong>{' '}
                {t('ai.statement.featureSends', {
                  model: feature.model,
                  data: feature.sends.map((kind) => t(DATA_NAMES[kind])).join(', '),
                })}
              </li>
            ))}
          </ul>
          {enabled.length === 0 && <p className="page-note">{t('ai.statement.allOff')}</p>}
        </>
      )}
      <p>
        {t('ai.statement.never', {
          list: statement.neverSent
            .map((n) => (NEVER_NAMES[n] ? t(NEVER_NAMES[n] as MessageId) : n))
            .join(', '),
        })}
      </p>
      <p>
        {statement.contentDays > 0
          ? t('ai.statement.contentKept', { days: statement.contentDays })
          : t('ai.statement.contentNotKept')}
      </p>
      {statement.redaction && (
        <p>
          {t('ai.statement.redaction', {
            patterns:
              statement.redaction.patterns
                .map((p) => (PATTERN_NAMES[p] ? t(PATTERN_NAMES[p] as MessageId) : p))
                .join(', ') || t('ai.statement.none'),
            fields: statement.redaction.fields.length,
            terms: statement.redaction.terms,
          })}
        </p>
      )}
    </section>
  );
}
