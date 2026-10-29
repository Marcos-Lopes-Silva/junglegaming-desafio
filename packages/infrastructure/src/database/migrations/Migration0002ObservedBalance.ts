import { Migration } from '@mikro-orm/migrations';

/**
 * Saldo observado no momento em que a transação atingiu o estado terminal.
 *
 * Repetir uma operação já processada precisa devolver o resultado original,
 * incluindo o saldo observado naquele momento. Para transações com
 * lançamento dá para derivar de `balance_after`, mas `LOSS`, `REJECTED` e
 * `PENDING_REFERENCE` não geram lançamento nenhum — sem esta coluna o replay
 * delas teria que devolver o saldo atual, que pode já ter mudado.
 *
 * O índice em `reference_transaction_id` serve à checagem de "esta referência
 * já foi revertida?", que roda em toda REFUND e ROLLBACK.
 */
export class Migration0002ObservedBalance extends Migration {
  override up(): void {
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD COLUMN observed_balance_amount NUMERIC(20,2);
    `);
    this.addSql(`
      ALTER TABLE wager_transactions
        ADD CONSTRAINT wager_transactions_observed_balance_non_negative
        CHECK (observed_balance_amount IS NULL OR observed_balance_amount >= 0);
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_reference_idx
        ON wager_transactions (reference_transaction_id)
        WHERE reference_transaction_id IS NOT NULL;
    `);
  }

  override down(): void {
    this.addSql(`DROP INDEX IF EXISTS wager_transactions_reference_idx;`);
    this.addSql(`
      ALTER TABLE wager_transactions
        DROP CONSTRAINT IF EXISTS wager_transactions_observed_balance_non_negative;
    `);
    this.addSql(`
      ALTER TABLE wager_transactions DROP COLUMN IF EXISTS observed_balance_amount;
    `);
  }
}
