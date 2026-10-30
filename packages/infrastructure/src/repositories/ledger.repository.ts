import type { EntityManager } from '@mikro-orm/postgresql';
import type {
  LedgerAggregate,
  LedgerCursor,
  LedgerPage,
  LedgerRepositoryPort,
} from '@wagering/application';
import { Money, type WalletLedgerEntry } from '@wagering/domain';
import { fromLedgerEntry, toLedgerEntry } from '../database/mappers.js';
import type { LedgerEntryRow } from '../database/rows.js';
import { LedgerEntrySchema } from '../database/schemas.js';

interface RawLedgerRow {
  id: string;
  account_id: string;
  transaction_id: string;
  direction: string;
  amount: string;
  currency: string;
  balance_before: string | null;
  balance_after: string | null;
  created_at: Date | string;
}

const toRow = (raw: RawLedgerRow): LedgerEntryRow => ({
  id: raw.id,
  accountId: raw.account_id,
  transactionId: raw.transaction_id,
  direction: raw.direction,
  amount: raw.amount,
  currency: raw.currency,
  balanceBefore: raw.balance_before,
  balanceAfter: raw.balance_after,
  // `em.execute` devolve a linha crua: o MikroORM só converte tipos quando
  // passa pelo metadata da entidade, então o timestamptz chega como string.
  createdAt:
    raw.created_at instanceof Date ? raw.created_at : new Date(raw.created_at),
});

export class LedgerRepository implements LedgerRepositoryPort {
  constructor(private readonly em: EntityManager) {}

  async insertMany(entries: WalletLedgerEntry[]): Promise<void> {
    if (entries.length === 0) {
      return;
    }
    await this.em.insertMany(LedgerEntrySchema, entries.map(fromLedgerEntry));
  }

  /**
   * Paginação keyset sobre `(account_id, created_at DESC, id DESC)`.
   *
   * A comparação de tupla `(created_at, id) < (?, ?)` é o que permite ao
   * Postgres percorrer o índice direto, sem o custo crescente de um OFFSET.
   */
  async listByAccount(
    accountId: string,
    limit: number,
    cursor: LedgerCursor | undefined,
  ): Promise<LedgerPage> {
    const params: unknown[] = [accountId];
    let predicate = '';

    if (cursor) {
      predicate = 'AND (created_at, id) < (?, ?)';
      params.push(cursor.createdAt, cursor.id);
    }
    params.push(limit + 1);

    const raw = await this.em.execute<RawLedgerRow[]>(
      `SELECT id, account_id, transaction_id, direction, amount, currency,
              balance_before, balance_after, created_at
         FROM ledger_entries
        WHERE account_id = ? ${predicate}
        ORDER BY created_at DESC, id DESC
        LIMIT ?`,
      params,
    );

    const hasMore = raw.length > limit;
    const page = hasMore ? raw.slice(0, limit) : raw;
    const entries = page.map((row) => toLedgerEntry(toRow(row)));
    const last = entries[entries.length - 1];

    return {
      entries,
      nextCursor:
        hasMore && last
          ? { createdAt: last.createdAt, id: last.id }
          : undefined,
    };
  }

  /**
   * Saldo reconstruído pelo ledger.
   *
   * O `::numeric(20,2)::text` é obrigatório: a soma é feita e escalada pelo
   * Postgres e chega como string já normalizada. Converter para `number` em
   * JS para formatar a escala introduziria ponto flutuante no caminho do
   * dinheiro.
   */
  async aggregateByAccount(
    accountId: string,
    currency: string,
  ): Promise<LedgerAggregate> {
    const [row] = await this.em.execute<
      { signed_sum: string; entry_count: string }[]
    >(
      `SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)
                ::numeric(20,2)::text AS signed_sum,
              COUNT(*)::text AS entry_count
         FROM ledger_entries
        WHERE account_id = ?`,
      [accountId],
    );

    return {
      signedSum: Money.rehydrate({
        amount: row?.signed_sum ?? '0.00',
        currency,
      }),
      count: Number.parseInt(row?.entry_count ?? '0', 10),
    };
  }
}
