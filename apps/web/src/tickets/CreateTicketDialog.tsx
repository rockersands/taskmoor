import { useId } from 'react';
import { useT } from '../i18n/I18nProvider';
import { ModalDialog } from '../shell/ModalDialog';
import { type CreateClient, CreateTicketPage } from './CreateTicketPage';

export interface CreateTicketDialogProps {
  onClose: () => void;
  client?: CreateClient;
}

/**
 * Creating a ticket without leaving the page (M1-052): the create form in a modal dialog, opened
 * from the top bar, the C key or the command palette.
 */
export function CreateTicketDialog({ onClose, client }: CreateTicketDialogProps) {
  const t = useT();
  const titleId = useId();
  return (
    <ModalDialog onClose={onClose} labelledBy={titleId} closeLabel={t('tickets.create.close')}>
      <CreateTicketPage
        {...(client ? { client } : {})}
        variant="dialog"
        titleId={titleId}
        onClose={onClose}
      />
    </ModalDialog>
  );
}
