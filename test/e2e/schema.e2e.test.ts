import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  PLAYER_A,
  type Harness,
  openWallet,
  rejectionMessage,
  startHarness,
} from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.reset();
});

afterAll(async () => {
  await h.close();
});

const seedWallet = async (amount = '100.00') => {
  const wallet = await openWallet(h, amount);

  const [account] = await h.sql<{ id: string }>(
    'SELECT id FROM ledger_accounts WHERE wallet_id = ?',
    [wallet.id],
  );
  const [transaction] = await h.sql<{ id: string }>(
    'SELECT id FROM wager_transactions',
  );

  return {
    walletId: wallet.id,
    accountId: account?.id ?? '',
    transactionId: transaction?.id ?? '',
  };
};

describe('metadata do ORM e schema real', () => {
  /**
   * As migrations são escritas à mão porque triggers, uniques parciais e CHECKs
   * de aritmética não cabem no metadata do MikroORM. Com isso não dá para usar
   * o `migration:check`, e uma coluna nova numa row class sem migration só
   * quebraria em runtime. Este teste compara as colunas que o ORM espera com as
   * que existem no banco.
   */
  it('toda coluna mapeada existe no banco, e vice-versa', async () => {
    const metadata = h.fork().getMetadata().getAll();

    for (const meta of metadata.values()) {
      if (!meta.tableName) {
        continue;
      }

      const mapped = Object.values(meta.properties)
        .filter((property) => property.persist !== false)
        .flatMap((property) => property.fieldNames ?? [])
        .sort();

      const rows = await h.sql<{ column_name: string }>(
        `SELECT column_name FROM information_schema.columns
          WHERE table_schema = 'public' AND table_name = ?`,
        [meta.tableName],
      );
      const actual = rows.map((row) => row.column_name).sort();

      // O nome da tabela entra na asserção para o erro dizer qual falhou.
      expect({ table: meta.tableName, columns: mapped }).toEqual({
        table: meta.tableName,
        columns: actual,
      });
    }
  });
});

describe('ledger_entries é append-only', () => {
  it('UPDATE é recusado pelo trigger', async () => {
    await seedWallet();

    expect(
      await rejectionMessage(
        h.sql(
          "UPDATE ledger_entries SET amount = 1 WHERE direction = 'CREDIT'",
        ),
      ),
    ).toMatch(/append-only/);
  });

  it('DELETE é recusado pelo trigger', async () => {
    await seedWallet();

    expect(await rejectionMessage(h.sql('DELETE FROM ledger_entries'))).toMatch(
      /append-only/,
    );
  });
});

describe('aritmética e sinal dos lançamentos', () => {
  it('recusa lançamento com aritmética inconsistente', async () => {
    const { accountId, transactionId } = await seedWallet();

    expect(
      await rejectionMessage(
        h.sql(
          `INSERT INTO ledger_entries
           (id, account_id, transaction_id, direction, amount, currency,
            balance_before, balance_after, created_at)
         VALUES (gen_random_uuid(), ?, ?, 'CREDIT', 10.00, 'BRL', 100.00, 999.00, now())`,
          [accountId, transactionId],
        ),
      ),
    ).toMatch(/ledger_entries_arithmetic/);
  });

  it('recusa valor zero ou negativo', async () => {
    const { accountId, transactionId } = await seedWallet();

    expect(
      await rejectionMessage(
        h.sql(
          `INSERT INTO ledger_entries
           (id, account_id, transaction_id, direction, amount, currency, created_at)
         VALUES (gen_random_uuid(), ?, ?, 'DEBIT', 0, 'BRL', now())`,
          [accountId, transactionId],
        ),
      ),
    ).toMatch(/ledger_entries_amount_positive/);
  });

  it('recusa saldo resultante negativo', async () => {
    const { accountId, transactionId } = await seedWallet();

    expect(
      await rejectionMessage(
        h.sql(
          `INSERT INTO ledger_entries
           (id, account_id, transaction_id, direction, amount, currency,
            balance_before, balance_after, created_at)
         VALUES (gen_random_uuid(), ?, ?, 'DEBIT', 50.00, 'BRL', 10.00, -40.00, now())`,
          [accountId, transactionId],
        ),
      ),
    ).toMatch(/ledger_entries_balance_non_negative/);
  });

  it('recusa saldo preenchido pela metade', async () => {
    const { accountId, transactionId } = await seedWallet();

    expect(
      await rejectionMessage(
        h.sql(
          `INSERT INTO ledger_entries
           (id, account_id, transaction_id, direction, amount, currency,
            balance_before, created_at)
         VALUES (gen_random_uuid(), ?, ?, 'CREDIT', 10.00, 'BRL', 100.00, now())`,
          [accountId, transactionId],
        ),
      ),
    ).toMatch(/ledger_entries_balance_pairing/);
  });
});

describe('um lançamento por conta por transação', () => {
  it('recusa o segundo lançamento na mesma conta para a mesma transação', async () => {
    const { accountId, transactionId } = await seedWallet();

    expect(
      await rejectionMessage(
        h.sql(
          `INSERT INTO ledger_entries
           (id, account_id, transaction_id, direction, amount, currency, created_at)
         VALUES (gen_random_uuid(), ?, ?, 'CREDIT', 1.00, 'BRL', now())`,
          [accountId, transactionId],
        ),
      ),
    ).toMatch(/ledger_entries_account_transaction_uq/);
  });
});

describe('balanceamento de partidas dobradas', () => {
  it('o par legítimo passa, apesar de o primeiro INSERT ficar desbalanceado', async () => {
    // O trigger é DEFERRABLE INITIALLY DEFERRED: se disparasse por statement,
    // nenhum par de partidas dobradas conseguiria ser gravado.
    const { accountId } = await seedWallet();
    const [funding] = await h.sql<{ id: string }>(
      "SELECT id FROM ledger_accounts WHERE kind = 'EXTERNAL_FUNDING'",
    );
    const [newTx] = await h.sql<{ id: string }>(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
       SELECT gen_random_uuid(), 'p', 'ext-pair', 'key-pair', repeat('a', 64),
              w.id, w.player_id, 'r', 'g', 'WIN', 5.00, 'BRL', 'PROCESSED', now()
         FROM wallets w LIMIT 1
       RETURNING id`,
    );

    await h.fork().transactional(async (em) => {
      for (const [account, direction] of [
        [accountId, 'CREDIT'],
        [funding?.id, 'DEBIT'],
      ] as const) {
        await em.execute(
          `INSERT INTO ledger_entries
             (id, account_id, transaction_id, direction, amount, currency, created_at)
           VALUES (gen_random_uuid(), ?, ?, ?, 5.00, 'BRL', now())`,
          [account, newTx?.id, direction],
        );
      }
    });

    expect(
      await h.sql('SELECT 1 FROM ledger_entries WHERE transaction_id = ?', [
        newTx?.id,
      ]),
    ).toHaveLength(2);

    await h.sql('UPDATE wallets SET balance_amount = balance_amount + 5.00');
  });

  it('recusa no commit uma transação com lançamento desbalanceado', async () => {
    const { accountId } = await seedWallet();
    const [newTx] = await h.sql<{ id: string }>(
      `INSERT INTO wager_transactions
         (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
       SELECT gen_random_uuid(), 'p', 'ext-solo', 'key-solo', repeat('a', 64),
              w.id, w.player_id, 'r', 'g', 'WIN', 5.00, 'BRL', 'PROCESSED', now()
         FROM wallets w LIMIT 1
       RETURNING id`,
    );

    expect(
      await rejectionMessage(
        h.fork().transactional(async (em) => {
          await em.execute(
            `INSERT INTO ledger_entries
             (id, account_id, transaction_id, direction, amount, currency, created_at)
           VALUES (gen_random_uuid(), ?, ?, 'CREDIT', 5.00, 'BRL', now())`,
            [accountId, newTx?.id],
          );
        }),
      ),
    ).toMatch(/double-entry imbalance/);

    expect(
      await h.sql('SELECT 1 FROM ledger_entries WHERE transaction_id = ?', [
        newTx?.id,
      ]),
    ).toHaveLength(0);
  });
});

describe('invariantes de wallets', () => {
  it('recusa saldo negativo', async () => {
    const { walletId } = await seedWallet();

    expect(
      await rejectionMessage(
        h.sql('UPDATE wallets SET balance_amount = -1 WHERE id = ?', [
          walletId,
        ]),
      ),
    ).toMatch(/wallets_balance_non_negative/);
  });

  it('recusa version menor que 1', async () => {
    const { walletId } = await seedWallet();

    expect(
      await rejectionMessage(
        h.sql('UPDATE wallets SET version = 0 WHERE id = ?', [walletId]),
      ),
    ).toMatch(/wallets_version_positive/);
  });

  it('recusa wallet duplicada para player + moeda direto no banco', async () => {
    const { walletId } = await seedWallet();
    const [wallet] = await h.sql<{ player_id: string }>(
      'SELECT player_id FROM wallets WHERE id = ?',
      [walletId],
    );

    expect(
      await rejectionMessage(
        h.sql(
          `INSERT INTO wallets
           (id, player_id, currency, balance_amount, version, created_at, updated_at)
         VALUES (gen_random_uuid(), ?, 'BRL', 0, 1, now(), now())`,
          [wallet?.player_id],
        ),
      ),
    ).toMatch(/wallets_player_currency_uq/);
  });
});

describe('invariantes de wager_transactions', () => {
  it('recusa idempotency key duplicada', async () => {
    const { walletId } = await seedWallet();

    expect(
      await rejectionMessage(
        h.sql(
          `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
         VALUES (gen_random_uuid(), 'internal', 'x', ?, repeat('a', 64),
                 ?, ?, 'r', 'g', 'BET', 1.00, 'BRL', 'PENDING', now())`,
          [`internal:opening:${walletId}`, walletId, PLAYER_A],
        ),
      ),
    ).toMatch(/wager_transactions_idempotency_key_uq/);
  });

  it('recusa REFUND sem referência', async () => {
    const { walletId } = await seedWallet();

    expect(
      await rejectionMessage(
        h.sql(
          `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
         VALUES (gen_random_uuid(), 'p', 'y', 'k-refund', repeat('a', 64),
                 ?, ?, 'r', 'g', 'REFUND', 1.00, 'BRL', 'PENDING', now())`,
          [walletId, PLAYER_A],
        ),
      ),
    ).toMatch(/wager_transactions_reference_required/);
  });

  it('recusa a segunda reversão PROCESSED do mesmo tipo sobre a mesma referência', async () => {
    const { walletId, transactionId } = await seedWallet();

    const insertRefund = (key: string) =>
      h.sql(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, amount, currency,
            reference_external_transaction_id, reference_transaction_id, status, created_at)
         VALUES (gen_random_uuid(), 'p', ?, ?, repeat('a', 64),
                 ?, ?, 'r', 'g', 'REFUND', 1.00, 'BRL', 'ref-1', ?, 'PROCESSED', now())`,
        [key, key, walletId, PLAYER_A, transactionId],
      );

    await insertRefund('k1');
    expect(await rejectionMessage(insertRefund('k2'))).toMatch(
      /wager_transactions_reversal_uq/,
    );
  });

  it('recusa kind e status fora do enum', async () => {
    const { walletId } = await seedWallet();

    const insert = (kind: string, status: string) =>
      h.sql(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, amount, currency, status, created_at)
         VALUES (gen_random_uuid(), 'p', gen_random_uuid()::text, gen_random_uuid()::text,
                 repeat('a', 64), ?, ?, 'r', 'g', ?, 1.00, 'BRL', ?, now())`,
        [walletId, PLAYER_A, kind, status],
      );

    expect(await rejectionMessage(insert('TRANSFER', 'PENDING'))).toMatch(
      /wager_transactions_kind_valid/,
    );
    expect(await rejectionMessage(insert('BET', 'UNKNOWN'))).toMatch(
      /wager_transactions_status_valid/,
    );
  });
});

describe('contas do ledger', () => {
  it('recusa uma segunda conta para a mesma wallet', async () => {
    const { walletId } = await seedWallet();

    expect(
      await rejectionMessage(
        h.sql(
          `INSERT INTO ledger_accounts (id, kind, wallet_id, currency, created_at)
         VALUES (gen_random_uuid(), 'PLAYER_WALLET', ?, 'BRL', now())`,
          [walletId],
        ),
      ),
    ).toMatch(/ledger_accounts_wallet_uq/);
  });

  it('recusa uma segunda conta de sistema para a mesma moeda', async () => {
    await seedWallet();

    expect(
      await rejectionMessage(
        h.sql(
          `INSERT INTO ledger_accounts (id, kind, wallet_id, currency, created_at)
         VALUES (gen_random_uuid(), 'EXTERNAL_FUNDING', NULL, 'BRL', now())`,
        ),
      ),
    ).toMatch(/ledger_accounts_system_uq/);
  });

  it('recusa conta de jogador sem wallet e conta de sistema com wallet', async () => {
    const { walletId } = await seedWallet();

    expect(
      await rejectionMessage(
        h.sql(
          `INSERT INTO ledger_accounts (id, kind, wallet_id, currency, created_at)
         VALUES (gen_random_uuid(), 'PLAYER_WALLET', NULL, 'BRL', now())`,
        ),
      ),
    ).toMatch(/ledger_accounts_wallet_pairing/);

    expect(
      await rejectionMessage(
        h.sql(
          `INSERT INTO ledger_accounts (id, kind, wallet_id, currency, created_at)
         VALUES (gen_random_uuid(), 'HOUSE_WAGERING', ?, 'BRL', now())`,
          [walletId],
        ),
      ),
    ).toMatch(/ledger_accounts_wallet_pairing/);
  });
});
