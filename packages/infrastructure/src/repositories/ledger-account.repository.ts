import type { EntityManager } from '@mikro-orm/postgresql';
import type { LedgerAccountRepositoryPort } from '@wagering/application';
import { LedgerAccount, type LedgerAccountKind } from '@wagering/domain';
import { v7 as uuidv7 } from 'uuid';
import { fromLedgerAccount, toLedgerAccount } from '../database/mappers.js';
import { LedgerAccountSchema } from '../database/schemas.js';

export class LedgerAccountRepository implements LedgerAccountRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async insert(account: LedgerAccount): Promise<void> {
    await this.em.insert(LedgerAccountSchema, fromLedgerAccount(account));
  }

  async findForWallet(walletId: string): Promise<LedgerAccount | undefined> {
    const row = await this.em.findOne(LedgerAccountSchema, { walletId });
    return row ? toLedgerAccount(row) : undefined;
  }

  /**
   * Resolve a conta de sistema da moeda, criando-a na primeira vez.
   *
   * O `ON CONFLICT DO NOTHING` é escrito à mão porque o índice é parcial
   * (`WHERE wallet_id IS NULL`) e porque deixar a unique violation estourar
   * abortaria a transação financeira inteira em vez de ser um no-op.
   */
  async resolveSystemAccount(
    kind: LedgerAccountKind.HouseWagering | LedgerAccountKind.ExternalFunding,
    currency: string,
  ): Promise<LedgerAccount> {
    const existing = await this.em.findOne(LedgerAccountSchema, {
      kind,
      currency,
      walletId: null,
    });
    if (existing) {
      return toLedgerAccount(existing);
    }

    await this.em.execute(
      `INSERT INTO ledger_accounts (id, kind, wallet_id, currency, created_at)
       VALUES (?, ?, NULL, ?, now())
       ON CONFLICT (kind, currency) WHERE wallet_id IS NULL DO NOTHING`,
      [uuidv7(), kind, currency],
    );

    const created = await this.em.findOne(LedgerAccountSchema, {
      kind,
      currency,
      walletId: null,
    });
    if (!created) {
      throw new Error(
        `failed to resolve system ledger account ${kind}/${currency}`,
      );
    }
    return toLedgerAccount(created);
  }
}
