import type { Database } from '@taskmoor/db';
import type { PepperRing } from '@taskmoor/iam';
import type { FastifyReply } from 'fastify';
import type { Kysely } from 'kysely';
import {
  changePassword,
  DirectoryBindError,
  DirectoryClient,
  DirectoryOperationError,
  DirectoryUnavailableError,
  type Verdict,
  verifyPassword,
} from './client';
import {
  DIRECTORY_COLUMNS,
  type DirectoryMode,
  type DirectoryRow,
  directorySettings,
  SealedSecretError,
} from './settings';

/**
 * What the rest of the API asks of directories (M1-082, IAM-005): which accounts and groups a
 * directory manages, checking a person's password by binding as them, and, for read-write
 * directories, writing password, profile and membership changes back. Read-only directories
 * own those values: changing them in Taskmoor is refused, since the next sync would undo it.
 */
export interface ManagedAccount {
  userId: number;
  dn: string;
  directory: DirectoryRow;
}

export interface ManagedGroup {
  groupId: number;
  dn: string;
  directory: DirectoryRow;
}

/** A directory said no, or could not be reached; routes answer with `directoryFailure`. */
export type DirectoryFailure = 'directory_unavailable' | 'directory_refused';

export class DirectoryGateway {
  constructor(
    private readonly db: Kysely<Database>,
    private readonly peppers: PepperRing | undefined,
  ) {}

  /** The directory managing an account, if one does (entries that left it no longer count). */
  async account(workspaceId: number, userId: number): Promise<ManagedAccount | null> {
    const row = await this.db
      .selectFrom('ldap_user as l')
      .innerJoin('ldap_directory as d', 'd.id', 'l.directory_id')
      .select(['l.user_id', 'l.dn'])
      .select(DIRECTORY_COLUMNS.map((c) => `d.${c}` as const))
      .where('l.user_id', '=', userId)
      .where('l.workspace_id', '=', workspaceId)
      .where('l.removed_at', 'is', null)
      .executeTakeFirst();
    if (!row) return null;
    const { user_id, dn, ...directory } = row;
    return { userId: user_id, dn, directory: directory as unknown as DirectoryRow };
  }

  async group(workspaceId: number, groupId: number): Promise<ManagedGroup | null> {
    const row = await this.db
      .selectFrom('ldap_group as l')
      .innerJoin('ldap_directory as d', 'd.id', 'l.directory_id')
      .select(['l.group_id', 'l.dn'])
      .select(DIRECTORY_COLUMNS.map((c) => `d.${c}` as const))
      .where('l.group_id', '=', groupId)
      .where('l.workspace_id', '=', workspaceId)
      .executeTakeFirst();
    if (!row) return null;
    const { group_id, dn, ...directory } = row;
    return { groupId: group_id, dn, directory: directory as unknown as DirectoryRow };
  }

  /** Binds as the person; a disabled directory, or one that cannot be reached, is 'unavailable'. */
  async verifyPassword(account: ManagedAccount, password: string): Promise<Verdict> {
    if (!account.directory.enabled) return 'unavailable';
    return verifyPassword(
      {
        url: account.directory.url,
        startTls: account.directory.start_tls,
        caCertificates: account.directory.ca_certificates,
      },
      account.dn,
      password,
    );
  }

  /** Changes the person's password in a read-write directory, as the person. */
  async changePassword(
    account: ManagedAccount,
    oldPassword: string,
    newPassword: string,
  ): Promise<Verdict | 'refused'> {
    if (!account.directory.enabled) return 'unavailable';
    try {
      return await changePassword(
        {
          url: account.directory.url,
          startTls: account.directory.start_tls,
          caCertificates: account.directory.ca_certificates,
          kind: account.directory.kind,
        },
        account.dn,
        oldPassword,
        newPassword,
      );
    } catch (error) {
      if (error instanceof DirectoryOperationError) return 'refused';
      throw error;
    }
  }

  private async asServiceAccount<T>(
    directory: DirectoryRow,
    work: (client: DirectoryClient) => Promise<T>,
  ): Promise<T | DirectoryFailure> {
    if (!directory.enabled) return 'directory_unavailable';
    let client: DirectoryClient | undefined;
    try {
      client = await DirectoryClient.connect(directorySettings(directory, this.peppers));
      return await work(client);
    } catch (error) {
      if (error instanceof DirectoryUnavailableError || error instanceof SealedSecretError) {
        return 'directory_unavailable';
      }
      if (error instanceof DirectoryOperationError || error instanceof DirectoryBindError) {
        return 'directory_refused';
      }
      throw error;
    } finally {
      await client?.close();
    }
  }

  /** Writes a changed name or address to the person's entry (read-write directories). */
  async writeProfile(
    account: ManagedAccount,
    values: { name?: string; email?: string },
  ): Promise<null | DirectoryFailure> {
    const settings = directorySettings(account.directory, this.peppers, '');
    const changes = [
      ...(values.name !== undefined
        ? [{ operation: 'replace' as const, type: settings.attributes.name, values: [values.name] }]
        : []),
      ...(values.email !== undefined
        ? [
            {
              operation: 'replace' as const,
              type: settings.attributes.email,
              values: [values.email],
            },
          ]
        : []),
    ];
    if (changes.length === 0) return null;
    const outcome = await this.asServiceAccount(account.directory, (client) =>
      client.modify(account.dn, changes),
    );
    return outcome === undefined ? null : outcome;
  }

  /** Adds a member DN to, or removes it from, a group entry (read-write directories). */
  async writeMembership(
    group: ManagedGroup,
    memberDn: string,
    operation: 'add' | 'delete',
  ): Promise<null | DirectoryFailure> {
    const settings = directorySettings(group.directory, this.peppers, '');
    const outcome = await this.asServiceAccount(group.directory, async (client) => {
      try {
        await client.modify(group.dn, [
          { operation, type: settings.attributes.member, values: [memberDn] },
        ]);
      } catch (error) {
        // Already a member (typeOrValueExists), or already gone (noSuchAttribute): done.
        const code = error instanceof DirectoryOperationError ? error.code : null;
        if ((operation === 'add' && code === 20) || (operation === 'delete' && code === 16)) return;
        throw error;
      }
    });
    return outcome === undefined ? null : outcome;
  }
}

/** True when the directory owns the value and Taskmoor may not change it. */
export function readOnly(mode: DirectoryMode): boolean {
  return mode !== 'read_write';
}

/** The answer for a directory that said no or could not be reached. */
export function directoryFailure(reply: FastifyReply, failure: DirectoryFailure) {
  return reply.code(failure === 'directory_unavailable' ? 503 : 502).send({ error: failure });
}

/** The answer for a change a directory owns. */
export function directoryManaged(reply: FastifyReply, directory: { id: number; name: string }) {
  return reply
    .code(409)
    .send({ error: 'directory_managed', directory: { id: directory.id, name: directory.name } });
}
