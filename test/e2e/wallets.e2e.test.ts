import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  type ErrorBody,
  type Harness,
  type LedgerPageBody,
  MISSING_WALLET,
  PLAYER_A,
  PLAYER_B,
  type ReconciliationBody,
  type WalletBody,
  createWallet,
  json,
  openWallet,
  startHarness,
} from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterEach(async () => {
  // Invariante final, verificada depois de cada teste.
  await h.assertLedgerInvariant();
  await h.reset();
});

afterAll(async () => {
  await h.close();
});

describe('POST /wallets', () => {
  it('cria a wallet com 201 e o corpo esperado', async () => {
    const response = await createWallet(h, {
      playerId: PLAYER_A,
      initialBalance: { amount: '1000.00', currency: 'BRL' },
    });

    expect(response.status).toBe(201);
    const body = await json<WalletBody>(response);

    expect(body).toMatchObject({
      playerId: PLAYER_A,
      balance: { amount: '1000.00', currency: 'BRL' },
      version: 1,
    });
    expect(body.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-/);
  });

  it('grava wallet, conta, OPENING, par de lançamentos e outbox numa só transação', async () => {
    const wallet = await openWallet(h, '1000.00');

    const [transaction] = await h.sql<{
      kind: string;
      status: string;
      amount: string;
    }>(
      'SELECT kind, status, amount::text FROM wager_transactions WHERE wallet_id = ?',
      [wallet.id],
    );
    expect(transaction).toMatchObject({
      kind: 'OPENING',
      status: 'PROCESSED',
      amount: '1000.00',
    });

    const entries = await h.sql<{
      direction: string;
      amount: string;
      balance_after: string | null;
    }>(
      `SELECT direction, amount::text, balance_after::text
         FROM ledger_entries ORDER BY direction`,
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      direction: 'CREDIT',
      balance_after: '1000.00',
    });
    // A contrapartida não materializa saldo.
    expect(entries[1]).toMatchObject({
      direction: 'DEBIT',
      balance_after: null,
    });

    const [outbox] = await h.sql<{
      event_type: string;
      published_at: string | null;
    }>('SELECT event_type, published_at FROM outbox_messages');
    expect(outbox).toMatchObject({
      event_type: 'WalletBalanceChanged',
      published_at: null,
    });
  });

  it('o evento da outbox carrega string decimal, não número', async () => {
    const wallet = await openWallet(h, '1000.00');

    const [row] = await h.sql<{ payload: Record<string, unknown> }>(
      'SELECT payload FROM outbox_messages',
    );
    const payload = row?.payload as {
      eventType: string;
      version: number;
      data: Record<string, unknown>;
    };

    expect(payload.eventType).toBe('WalletBalanceChanged');
    expect(payload.version).toBe(1);
    expect(payload.data).toMatchObject({
      walletId: wallet.id,
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
      walletVersion: 1,
    });
  });

  it('os lançamentos da transação somam zero (partidas dobradas)', async () => {
    await openWallet(h, '1000.00');

    const [row] = await h.sql<{ imbalance: string }>(`
      SELECT SUM(CASE WHEN direction = 'CREDIT' THEN amount ELSE -amount END)
             ::numeric(20,2)::text AS imbalance
        FROM ledger_entries
    `);

    expect(row?.imbalance).toBe('0.00');
  });

  it('saldo inicial zero não gera OPENING nem lançamento', async () => {
    const wallet = await openWallet(h, '0.00');

    expect(wallet.balance.amount).toBe('0.00');
    expect(await h.sql('SELECT 1 FROM wager_transactions')).toHaveLength(0);
    expect(await h.sql('SELECT 1 FROM ledger_entries')).toHaveLength(0);
    expect(await h.sql('SELECT 1 FROM outbox_messages')).toHaveLength(0);
    expect(await h.sql('SELECT 1 FROM ledger_accounts')).toHaveLength(1);
  });

  it('wallet duplicada para player + moeda responde 409', async () => {
    const body = {
      playerId: PLAYER_A,
      initialBalance: { amount: '10.00', currency: 'BRL' },
    };

    expect((await createWallet(h, body)).status).toBe(201);

    const conflict = await createWallet(h, body);
    expect(conflict.status).toBe(409);
    expect(await json<ErrorBody>(conflict)).toMatchObject({
      statusCode: 409,
      failureCode: 'WALLET_ALREADY_EXISTS',
    });
  });

  it('o mesmo player pode ter wallets em moedas diferentes', async () => {
    await openWallet(h, '1.00', { currency: 'BRL' });
    await openWallet(h, '1.00', { currency: 'USD' });

    expect(await h.sql('SELECT 1 FROM wallets')).toHaveLength(2);
  });

  it('duas criações concorrentes da mesma wallet: uma cria, a outra conflita', async () => {
    // Quem barra a duplicata é a unique constraint.
    const body = {
      playerId: PLAYER_B,
      initialBalance: { amount: '50.00', currency: 'BRL' },
    };

    const [first, second] = await Promise.all([
      createWallet(h, body),
      createWallet(h, body),
    ]);
    const statuses = [first.status, second.status].sort();

    expect(statuses).toEqual([201, 409]);
    expect(await h.sql('SELECT 1 FROM wallets')).toHaveLength(1);
  });

  it.each([
    ['amount com 3 casas', { amount: '10.999', currency: 'BRL' }],
    ['amount negativo', { amount: '-10.00', currency: 'BRL' }],
    ['notação científica', { amount: '1e3', currency: 'BRL' }],
    ['amount vazio', { amount: '', currency: 'BRL' }],
    ['moeda minúscula', { amount: '10.00', currency: 'brl' }],
    ['moeda com 4 letras', { amount: '10.00', currency: 'BRLL' }],
  ])('rejeita %s com 400', async (_label, initialBalance) => {
    const response = await createWallet(h, {
      playerId: PLAYER_A,
      initialBalance,
    });

    expect(response.status).toBe(400);
    expect(await json<ErrorBody>(response)).toMatchObject({
      failureCode: 'VALIDATION_FAILED',
    });
  });

  it('rejeita playerId que não é UUID', async () => {
    const response = await createWallet(h, {
      playerId: 'not-a-uuid',
      initialBalance: { amount: '10.00', currency: 'BRL' },
    });

    expect(response.status).toBe(400);
  });

  it('rejeita campo desconhecido no corpo', async () => {
    const response = await h.request('/wallets', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        playerId: PLAYER_A,
        initialBalance: { amount: '10.00', currency: 'BRL' },
        balance: '999999.00',
      }),
    });

    expect(response.status).toBe(400);
  });
});

describe('GET /wallets/:walletId', () => {
  it('devolve a wallet', async () => {
    const created = await openWallet(h, '250.50');
    const response = await h.request(`/wallets/${created.id}`);

    expect(response.status).toBe(200);
    expect(await json<WalletBody>(response)).toMatchObject({
      id: created.id,
      balance: { amount: '250.50', currency: 'BRL' },
      version: 1,
    });
  });

  it('404 para wallet inexistente', async () => {
    const response = await h.request(`/wallets/${MISSING_WALLET}`);

    expect(response.status).toBe(404);
    expect(await json<ErrorBody>(response)).toMatchObject({
      failureCode: 'WALLET_NOT_FOUND',
    });
  });

  it('400 para id que não é UUID', async () => {
    expect((await h.request('/wallets/abc')).status).toBe(400);
  });
});

/**
 * Cada crédito tem sua própria transação e contrapartida, porque a unique
 * `(account_id, transaction_id)` e o trigger de partidas dobradas exigem as duas
 * coisas. O saldo materializado acompanha para a invariante do `afterEach`
 * continuar valendo.
 */
async function appendCredits(walletId: string, count: number): Promise<void> {
  const [account] = await h.sql<{ id: string }>(
    'SELECT id FROM ledger_accounts WHERE wallet_id = ?',
    [walletId],
  );
  const [house] = await h.sql<{ id: string }>(
    `INSERT INTO ledger_accounts (id, kind, wallet_id, currency, created_at)
     VALUES (gen_random_uuid(), 'HOUSE_WAGERING', NULL, 'BRL', now())
     ON CONFLICT (kind, currency) WHERE wallet_id IS NULL DO NOTHING
     RETURNING id`,
  );
  const houseId =
    house?.id ??
    (
      await h.sql<{ id: string }>(
        "SELECT id FROM ledger_accounts WHERE kind = 'HOUSE_WAGERING' AND currency = 'BRL'",
      )
    )[0]?.id;

  const [current] = await h.sql<{ balance_amount: string }>(
    'SELECT balance_amount::text FROM wallets WHERE id = ?',
    [walletId],
  );
  let running = Number.parseInt(
    (current?.balance_amount ?? '0').replace('.', ''),
    10,
  );

  for (let i = 0; i < count; i += 1) {
    const before = running;
    running += 100;

    await h.fork().transactional(async (em) => {
      const [tx] = await em.execute<{ id: string }[]>(
        `INSERT INTO wager_transactions
           (id, provider_id, external_transaction_id, idempotency_key, payload_hash,
            wallet_id, player_id, round_id, game_id, kind, amount, currency, status,
            created_at, processed_at)
         SELECT gen_random_uuid(), 'provider-a', ?, ?, repeat('a', 64),
                w.id, w.player_id, 'round-1', 'game-1', 'WIN', 1.00, 'BRL', 'PROCESSED',
                now(), now()
           FROM wallets w WHERE w.id = ?
         RETURNING id`,
        [`ext-page-${i}`, `key-page-${i}`, walletId],
      );

      await em.execute(
        `INSERT INTO ledger_entries
           (id, account_id, transaction_id, direction, amount, currency,
            balance_before, balance_after, created_at)
         VALUES (gen_random_uuid(), ?, ?, 'CREDIT', 1.00, 'BRL', ?, ?,
                 now() + (? || ' seconds')::interval)`,
        [
          account?.id,
          tx?.id,
          (before / 100).toFixed(2),
          (running / 100).toFixed(2),
          i + 1,
        ],
      );

      await em.execute(
        `INSERT INTO ledger_entries
           (id, account_id, transaction_id, direction, amount, currency, created_at)
         VALUES (gen_random_uuid(), ?, ?, 'DEBIT', 1.00, 'BRL',
                 now() + (? || ' seconds')::interval)`,
        [houseId, tx?.id, i + 1],
      );
    });
  }

  await h.sql(
    'UPDATE wallets SET balance_amount = ?, version = version + ? WHERE id = ?',
    [(running / 100).toFixed(2), count, walletId],
  );
}

describe('GET /wallets/:walletId/ledger', () => {
  it('lista os lançamentos da wallet e não os da contrapartida', async () => {
    const wallet = await openWallet(h, '1000.00');
    const body = await json<LedgerPageBody>(
      await h.request(`/wallets/${wallet.id}/ledger`),
    );

    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toMatchObject({
      direction: 'CREDIT',
      money: { amount: '1000.00', currency: 'BRL' },
      balanceBefore: { amount: '0.00', currency: 'BRL' },
      balanceAfter: { amount: '1000.00', currency: 'BRL' },
    });
    expect(body.nextCursor).toBeNull();
  });

  it('pagina com cursor opaco e estável', async () => {
    const wallet = await openWallet(h, '10.00');
    await appendCredits(wallet.id, 4);

    const first = await json<LedgerPageBody>(
      await h.request(`/wallets/${wallet.id}/ledger?limit=2`),
    );
    expect(first.entries).toHaveLength(2);
    expect(typeof first.nextCursor).toBe('string');

    const second = await json<LedgerPageBody>(
      await h.request(
        `/wallets/${wallet.id}/ledger?limit=2&cursor=${encodeURIComponent(first.nextCursor ?? '')}`,
      ),
    );
    expect(second.entries).toHaveLength(2);

    const firstIds = first.entries.map((entry) => entry.id);
    const secondIds = second.entries.map((entry) => entry.id);
    expect(firstIds.filter((id) => secondIds.includes(id))).toHaveLength(0);
  });

  it('percorre todas as páginas sem repetir nem perder lançamento', async () => {
    const wallet = await openWallet(h, '10.00');
    await appendCredits(wallet.id, 4);

    const seen: string[] = [];
    let cursor: string | null = null;

    do {
      const query = `limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const page: LedgerPageBody = await json<LedgerPageBody>(
        await h.request(`/wallets/${wallet.id}/ledger?${query}`),
      );
      seen.push(...page.entries.map((entry) => entry.id));
      cursor = page.nextCursor;
    } while (cursor);

    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
  });

  it('400 para cursor malformado', async () => {
    const wallet = await openWallet(h, '10.00');
    const response = await h.request(
      `/wallets/${wallet.id}/ledger?cursor=not-a-cursor`,
    );

    expect(response.status).toBe(400);
    expect(await json<ErrorBody>(response)).toMatchObject({
      failureCode: 'INVALID_LEDGER_CURSOR',
    });
  });

  it('400 para limit fora da faixa', async () => {
    const wallet = await openWallet(h, '10.00');

    expect(
      (await h.request(`/wallets/${wallet.id}/ledger?limit=0`)).status,
    ).toBe(400);
    expect(
      (await h.request(`/wallets/${wallet.id}/ledger?limit=999`)).status,
    ).toBe(400);
  });

  it('404 para wallet inexistente', async () => {
    expect((await h.request(`/wallets/${MISSING_WALLET}/ledger`)).status).toBe(
      404,
    );
  });
});

describe('POST /wallets/:walletId/reconciliation', () => {
  it('confirma consistência logo após a criação', async () => {
    const wallet = await openWallet(h, '975.00');
    const response = await h.request(`/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await json<ReconciliationBody>(response)).toEqual({
      walletId: wallet.id,
      storedBalance: { amount: '975.00', currency: 'BRL' },
      calculatedBalance: { amount: '975.00', currency: 'BRL' },
      difference: { amount: '0.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 1,
    });
  });

  it('wallet zerada reconcilia com zero lançamentos', async () => {
    const wallet = await openWallet(h, '0.00');
    const response = await h.request(`/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
    });

    expect(await json<ReconciliationBody>(response)).toMatchObject({
      consistent: true,
      checkedEntries: 0,
    });
  });

  it('divergência responde 200 com consistent false e não corrige o saldo', async () => {
    const wallet = await openWallet(h, '100.00');

    await h.sql('UPDATE wallets SET balance_amount = 150.00 WHERE id = ?', [
      wallet.id,
    ]);

    const response = await h.request(`/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(await json<ReconciliationBody>(response)).toMatchObject({
      storedBalance: { amount: '150.00', currency: 'BRL' },
      calculatedBalance: { amount: '100.00', currency: 'BRL' },
      difference: { amount: '50.00', currency: 'BRL' },
      consistent: false,
    });

    const [row] = await h.sql<{ balance_amount: string }>(
      'SELECT balance_amount::text FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(row?.balance_amount).toBe('150.00');

    // Restaura antes do afterEach, que checa a invariante global.
    await h.sql('UPDATE wallets SET balance_amount = 100.00 WHERE id = ?', [
      wallet.id,
    ]);
  });

  it('404 para wallet inexistente', async () => {
    const response = await h.request(
      `/wallets/${MISSING_WALLET}/reconciliation`,
      {
        method: 'POST',
      },
    );

    expect(response.status).toBe(404);
  });
});
