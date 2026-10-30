import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  type Harness,
  PLAYER_A,
  PLAYER_B,
  type SubmitResponseBody,
  json,
  openWallet,
  startHarness,
  submitTransaction,
  wagerBody,
} from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterEach(async () => {
  await h.assertLedgerInvariant();
  await h.reset();
});

afterAll(async () => {
  await h.close();
});

const countBy = (statuses: number[]) =>
  statuses.reduce<Record<number, number>>((acc, status) => {
    acc[status] = (acc[status] ?? 0) + 1;
    return acc;
  }, {});

describe('apostas simultâneas na mesma wallet', () => {
  it('saldo 100.00, duas apostas de 80.00 simultâneas', async () => {
    const wallet = await openWallet(h, '100.00');

    const [first, second] = await Promise.all([
      submitTransaction(
        h,
        wagerBody({
          walletId: wallet.id,
          playerId: PLAYER_A,
          kind: 'BET',
          money: { amount: '80.00', currency: 'BRL' },
          externalTransactionId: 'bet-a',
        }),
      ),
      submitTransaction(
        h,
        wagerBody({
          walletId: wallet.id,
          playerId: PLAYER_A,
          kind: 'BET',
          money: { amount: '80.00', currency: 'BRL' },
          externalTransactionId: 'bet-b',
        }),
      ),
    ]);

    const bodies = await Promise.all([
      json<SubmitResponseBody>(first),
      json<SubmitResponseBody>(second),
    ]);

    const statuses = bodies.map((b) => b.status).sort();
    expect(statuses).toEqual(['PROCESSED', 'REJECTED']);
    expect(bodies.find((b) => b.status === 'REJECTED')?.failureCode).toBe(
      'INSUFFICIENT_FUNDS',
    );
    expect([first.status, second.status].sort()).toEqual([200, 422]);

    const [row] = await h.sql<{ balance_amount: string; version: number }>(
      'SELECT balance_amount::text, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(row?.balance_amount).toBe('20.00');
    expect(row?.version).toBe(2);

    const debits = await h.sql(
      `SELECT 1 FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.wallet_id = ? AND e.direction = 'DEBIT'`,
      [wallet.id],
    );
    expect(debits).toHaveLength(1);
  });
});

describe('a mesma aposta enviada 50 vezes em paralelo', () => {
  it('produz um único débito', async () => {
    const wallet = await openWallet(h, '1000.00');
    const body = wagerBody({
      walletId: wallet.id,
      playerId: PLAYER_A,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      externalTransactionId: 'bet-duplicada',
    });

    const responses = await Promise.all(
      Array.from({ length: 50 }, () => submitTransaction(h, body)),
    );
    const bodies = await Promise.all(
      responses.map((r) => json<SubmitResponseBody>(r)),
    );

    expect(countBy(responses.map((r) => r.status))).toEqual({ 200: 50 });

    const ids = new Set(bodies.map((b) => b.transactionId));
    expect(ids.size).toBe(1);
    expect(bodies.filter((b) => !b.idempotentReplay)).toHaveLength(1);
    expect(bodies.every((b) => b.balance.amount === '975.00')).toBe(true);

    expect(
      await h.sql("SELECT 1 FROM wager_transactions WHERE kind = 'BET'"),
    ).toHaveLength(1);
    expect(
      await h.sql('SELECT 1 FROM ledger_entries WHERE transaction_id = ?', [
        bodies[0]?.transactionId,
      ]),
    ).toHaveLength(2);

    const [walletRow] = await h.sql<{
      balance_amount: string;
      version: number;
    }>('SELECT balance_amount::text, version FROM wallets WHERE id = ?', [
      wallet.id,
    ]);
    expect(walletRow?.balance_amount).toBe('975.00');
    expect(walletRow?.version).toBe(2);
  }, 60_000);
});

describe('disputa de saldo na mesma wallet', () => {
  it('20 apostas concorrentes param exatamente quando o saldo acaba', async () => {
    // 100.00 de saldo, 20 apostas de 10.00: 10 passam, 10 são rejeitadas.
    const wallet = await openWallet(h, '100.00');

    const responses = await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        submitTransaction(
          h,
          wagerBody({
            walletId: wallet.id,
            playerId: PLAYER_A,
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
            externalTransactionId: `bet-${index}`,
          }),
        ),
      ),
    );

    expect(countBy(responses.map((r) => r.status))).toEqual({
      200: 10,
      422: 10,
    });

    const [row] = await h.sql<{ balance_amount: string; version: number }>(
      'SELECT balance_amount::text, version FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(row?.balance_amount).toBe('0.00');
    // version só incrementa quando o saldo muda: 1 abertura + 10 débitos.
    expect(row?.version).toBe(11);

    const debits = await h.sql(
      `SELECT 1 FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.wallet_id = ? AND e.direction = 'DEBIT'`,
      [wallet.id],
    );
    expect(debits).toHaveLength(10);
  }, 60_000);

  it('nunca produz saldo negativo sob disputa agressiva', async () => {
    const wallet = await openWallet(h, '50.00');

    await Promise.all(
      Array.from({ length: 30 }, (_, index) =>
        submitTransaction(
          h,
          wagerBody({
            walletId: wallet.id,
            playerId: PLAYER_A,
            kind: 'BET',
            money: { amount: '7.00', currency: 'BRL' },
            externalTransactionId: `bet-${index}`,
          }),
        ),
      ),
    );

    const [row] = await h.sql<{ balance_amount: string }>(
      'SELECT balance_amount::text FROM wallets WHERE id = ?',
      [wallet.id],
    );
    // 7 apostas de 7.00 cabem em 50.00; sobra 1.00.
    expect(row?.balance_amount).toBe('1.00');
  }, 60_000);
});

describe('wallets distintas em paralelo', () => {
  it('não se bloqueiam entre si', async () => {
    const [walletA, walletB] = await Promise.all([
      openWallet(h, '100.00', { playerId: PLAYER_A }),
      openWallet(h, '100.00', { playerId: PLAYER_B }),
    ]);

    const responses = await Promise.all(
      [walletA, walletB].flatMap((wallet, walletIndex) =>
        Array.from({ length: 5 }, (_, index) =>
          submitTransaction(
            h,
            wagerBody({
              walletId: wallet.id,
              playerId: walletIndex === 0 ? PLAYER_A : PLAYER_B,
              kind: 'BET',
              money: { amount: '10.00', currency: 'BRL' },
              externalTransactionId: `bet-${walletIndex}-${index}`,
            }),
          ),
        ),
      ),
    );

    expect(countBy(responses.map((r) => r.status))).toEqual({ 200: 10 });

    const rows = await h.sql<{ id: string; balance_amount: string }>(
      'SELECT id, balance_amount::text FROM wallets ORDER BY id',
    );
    expect(rows.map((r) => r.balance_amount)).toEqual(['50.00', '50.00']);
  }, 60_000);
});

describe('reversão concorrente', () => {
  it('duas reversões simultâneas da mesma BET: só uma credita', async () => {
    const wallet = await openWallet(h, '100.00');
    await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        externalTransactionId: 'bet-1',
      }),
    );

    const reversal = (kind: string, external: string) =>
      submitTransaction(
        h,
        wagerBody({
          walletId: wallet.id,
          playerId: PLAYER_A,
          kind,
          money: { amount: '25.00', currency: 'BRL' },
          externalTransactionId: external,
          referenceExternalTransactionId: 'bet-1',
        }),
      );

    const responses = await Promise.all([
      reversal('REFUND', 'refund-1'),
      reversal('ROLLBACK', 'rollback-1'),
    ]);

    expect(countBy(responses.map((r) => r.status))).toEqual({ 200: 1, 422: 1 });

    const [row] = await h.sql<{ balance_amount: string }>(
      'SELECT balance_amount::text FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(row?.balance_amount).toBe('100.00');
  }, 60_000);
});

describe('múltiplas instâncias da aplicação', () => {
  it('três instâncias disputando a mesma wallet mantêm a correção', async () => {
    // Instâncias independentes, cada uma com seu pool de conexões, identity
    // map e porta.
    const extra = await Promise.all([
      startHarness({ reset: false }),
      startHarness({ reset: false }),
    ]);
    const instances = [h, ...extra];

    try {
      const wallet = await openWallet(h, '100.00');

      const responses = await Promise.all(
        Array.from({ length: 21 }, (_, index) =>
          submitTransaction(
            instances[index % instances.length] as Harness,
            wagerBody({
              walletId: wallet.id,
              playerId: PLAYER_A,
              kind: 'BET',
              money: { amount: '10.00', currency: 'BRL' },
              externalTransactionId: `bet-${index}`,
            }),
          ),
        ),
      );

      expect(countBy(responses.map((r) => r.status))).toEqual({
        200: 10,
        422: 11,
      });

      const [row] = await h.sql<{ balance_amount: string }>(
        'SELECT balance_amount::text FROM wallets WHERE id = ?',
        [wallet.id],
      );
      expect(row?.balance_amount).toBe('0.00');

      const debits = await h.sql(
        `SELECT 1 FROM ledger_entries e
           JOIN ledger_accounts a ON a.id = e.account_id
          WHERE a.wallet_id = ? AND e.direction = 'DEBIT'`,
        [wallet.id],
      );
      expect(debits).toHaveLength(10);
    } finally {
      await Promise.all(extra.map((instance) => instance.close()));
    }
  }, 120_000);

  it('a mesma aposta enviada a três instâncias ao mesmo tempo debita uma vez', async () => {
    const extra = await Promise.all([
      startHarness({ reset: false }),
      startHarness({ reset: false }),
    ]);
    const instances = [h, ...extra];

    try {
      const wallet = await openWallet(h, '100.00');
      const body = wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
        externalTransactionId: 'bet-compartilhada',
      });

      const bodies = await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          submitTransaction(
            instances[index % instances.length] as Harness,
            body,
          ).then((r) => json<SubmitResponseBody>(r)),
        ),
      );

      expect(new Set(bodies.map((b) => b.transactionId)).size).toBe(1);
      expect(bodies.filter((b) => !b.idempotentReplay)).toHaveLength(1);

      const [row] = await h.sql<{ balance_amount: string }>(
        'SELECT balance_amount::text FROM wallets WHERE id = ?',
        [wallet.id],
      );
      expect(row?.balance_amount).toBe('70.00');
    } finally {
      await Promise.all(extra.map((instance) => instance.close()));
    }
  }, 120_000);
});
