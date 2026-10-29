import { Migration } from '@mikro-orm/migrations';

/**
 * Schema inicial.
 *
 * Unicidade, imutabilidade e não-negatividade também são garantidas no banco:
 *
 * - `wallets_player_currency_uq` é o que mantém "uma wallet por player+moeda"
 *   correto com várias instâncias criando a mesma wallet ao mesmo tempo;
 * - `ledger_entries` é append-only via trigger;
 * - a aritmética do lançamento é verificada por CHECK, além da factory;
 * - o balanceamento de partidas dobradas é um constraint trigger DEFERRABLE,
 *   senão ele dispararia no primeiro INSERT do par.
 */
export class Migration0001Initial extends Migration {
  override up(): void {
    this.addSql(`
      CREATE TABLE wallets (
        id UUID PRIMARY KEY,
        player_id UUID NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_amount NUMERIC(20,2) NOT NULL,
        version INTEGER NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT wallets_balance_non_negative CHECK (balance_amount >= 0),
        CONSTRAINT wallets_version_positive CHECK (version >= 1),
        CONSTRAINT wallets_currency_format CHECK (currency ~ '^[A-Z]{3}$')
      );
    `);
    this.addSql(
      `CREATE UNIQUE INDEX wallets_player_currency_uq ON wallets (player_id, currency);`,
    );

    this.addSql(`
      CREATE TABLE ledger_accounts (
        id UUID PRIMARY KEY,
        kind VARCHAR(32) NOT NULL,
        wallet_id UUID REFERENCES wallets (id),
        currency CHAR(3) NOT NULL,
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT ledger_accounts_kind_valid
          CHECK (kind IN ('PLAYER_WALLET', 'HOUSE_WAGERING', 'EXTERNAL_FUNDING')),
        CONSTRAINT ledger_accounts_wallet_pairing CHECK (
          (kind = 'PLAYER_WALLET' AND wallet_id IS NOT NULL)
          OR (kind <> 'PLAYER_WALLET' AND wallet_id IS NULL)
        )
      );
    `);
    this.addSql(`
      CREATE UNIQUE INDEX ledger_accounts_wallet_uq
        ON ledger_accounts (wallet_id) WHERE wallet_id IS NOT NULL;
    `);
    this.addSql(`
      CREATE UNIQUE INDEX ledger_accounts_system_uq
        ON ledger_accounts (kind, currency) WHERE wallet_id IS NULL;
    `);

    this.addSql(`
      CREATE TABLE wager_transactions (
        id UUID PRIMARY KEY,
        provider_id VARCHAR(64) NOT NULL,
        external_transaction_id VARCHAR(128) NOT NULL,
        idempotency_key VARCHAR(255) NOT NULL,
        payload_hash CHAR(64) NOT NULL,
        wallet_id UUID NOT NULL REFERENCES wallets (id),
        player_id UUID NOT NULL,
        round_id VARCHAR(128) NOT NULL,
        game_id VARCHAR(128) NOT NULL,
        kind VARCHAR(16) NOT NULL,
        amount NUMERIC(20,2) NOT NULL,
        currency CHAR(3) NOT NULL,
        reference_external_transaction_id VARCHAR(128),
        reference_transaction_id UUID REFERENCES wager_transactions (id),
        status VARCHAR(24) NOT NULL,
        failure_code VARCHAR(48),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL,
        processed_at TIMESTAMPTZ,
        CONSTRAINT wager_transactions_kind_valid
          CHECK (kind IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT wager_transactions_status_valid
          CHECK (status IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT wager_transactions_amount_non_negative CHECK (amount >= 0),
        CONSTRAINT wager_transactions_reference_required CHECK (
          kind NOT IN ('REFUND', 'ROLLBACK')
          OR reference_external_transaction_id IS NOT NULL
        )
      );
    `);
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_idempotency_key_uq
        ON wager_transactions (idempotency_key);
    `);
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_provider_external_uq
        ON wager_transactions (provider_id, external_transaction_id);
    `);
    // A constraint impede a segunda reversão do mesmo tipo; a regra de
    // negócio vai além e recusa qualquer segunda reversão, porque
    // um REFUND somado a um ROLLBACK sobre a mesma BET duplicaria o crédito.
    this.addSql(`
      CREATE UNIQUE INDEX wager_transactions_reversal_uq
        ON wager_transactions (reference_transaction_id, kind)
        WHERE kind IN ('REFUND', 'ROLLBACK') AND status = 'PROCESSED';
    `);
    this.addSql(`
      CREATE INDEX wager_transactions_pending_reference_idx
        ON wager_transactions (next_attempt_at) WHERE status = 'PENDING_REFERENCE';
    `);

    this.addSql(`
      CREATE TABLE ledger_entries (
        id UUID PRIMARY KEY,
        account_id UUID NOT NULL REFERENCES ledger_accounts (id),
        transaction_id UUID NOT NULL REFERENCES wager_transactions (id),
        direction VARCHAR(8) NOT NULL,
        amount NUMERIC(20,2) NOT NULL,
        currency CHAR(3) NOT NULL,
        balance_before NUMERIC(20,2),
        balance_after NUMERIC(20,2),
        created_at TIMESTAMPTZ NOT NULL,
        CONSTRAINT ledger_entries_direction_valid CHECK (direction IN ('DEBIT', 'CREDIT')),
        CONSTRAINT ledger_entries_amount_positive CHECK (amount > 0),
        CONSTRAINT ledger_entries_balance_pairing CHECK (
          (balance_before IS NULL AND balance_after IS NULL)
          OR (balance_before IS NOT NULL AND balance_after IS NOT NULL)
        ),
        CONSTRAINT ledger_entries_balance_non_negative
          CHECK (balance_after IS NULL OR balance_after >= 0),
        CONSTRAINT ledger_entries_arithmetic CHECK (
          balance_after IS NULL
          OR (direction = 'CREDIT' AND balance_after = balance_before + amount)
          OR (direction = 'DEBIT' AND balance_after = balance_before - amount)
        )
      );
    `);
    this.addSql(`
      CREATE UNIQUE INDEX ledger_entries_account_transaction_uq
        ON ledger_entries (account_id, transaction_id);
    `);
    this.addSql(`
      CREATE INDEX ledger_entries_account_cursor_idx
        ON ledger_entries (account_id, created_at DESC, id DESC);
    `);

    this.addSql(`
      CREATE FUNCTION ledger_entries_reject_mutation() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'ledger_entries is append-only, % rejected', TG_OP
          USING ERRCODE = '23514';
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE TRIGGER ledger_entries_immutable
        BEFORE UPDATE OR DELETE ON ledger_entries
        FOR EACH ROW EXECUTE FUNCTION ledger_entries_reject_mutation();
    `);

    this.addSql(`
      CREATE FUNCTION ledger_entries_assert_balanced() RETURNS trigger AS $$
      DECLARE
        imbalance NUMERIC(20,2);
      BEGIN
        SELECT COALESCE(SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END), 0)
          INTO imbalance
          FROM ledger_entries
          WHERE transaction_id = NEW.transaction_id;

        IF imbalance <> 0 THEN
          RAISE EXCEPTION 'double-entry imbalance % on transaction %',
            imbalance, NEW.transaction_id USING ERRCODE = '23514';
        END IF;

        RETURN NULL;
      END;
      $$ LANGUAGE plpgsql;
    `);
    this.addSql(`
      CREATE CONSTRAINT TRIGGER ledger_entries_balanced
        AFTER INSERT ON ledger_entries
        DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION ledger_entries_assert_balanced();
    `);

    this.addSql(`
      CREATE TABLE outbox_messages (
        id UUID PRIMARY KEY,
        aggregate_id UUID NOT NULL,
        event_type VARCHAR(64) NOT NULL,
        payload JSONB NOT NULL,
        occurred_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        published_at TIMESTAMPTZ
      );
    `);
    this.addSql(`
      CREATE INDEX outbox_messages_pending_idx
        ON outbox_messages (next_attempt_at) WHERE published_at IS NULL;
    `);
  }

  override down(): void {
    this.addSql(`DROP TABLE IF EXISTS outbox_messages;`);
    this.addSql(
      `DROP TRIGGER IF EXISTS ledger_entries_balanced ON ledger_entries;`,
    );
    this.addSql(
      `DROP TRIGGER IF EXISTS ledger_entries_immutable ON ledger_entries;`,
    );
    this.addSql(`DROP TABLE IF EXISTS ledger_entries;`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_entries_assert_balanced();`);
    this.addSql(`DROP FUNCTION IF EXISTS ledger_entries_reject_mutation();`);
    this.addSql(`DROP TABLE IF EXISTS wager_transactions;`);
    this.addSql(`DROP TABLE IF EXISTS ledger_accounts;`);
    this.addSql(`DROP TABLE IF EXISTS wallets;`);
  }
}
