import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  type ErrorBody,
  type Harness,
  MISSING_WALLET,
  PLAYER_A,
  PLAYER_B,
  PROVIDER,
  type SubmitResponseBody,
  type WalletBody,
  json,
  openWallet,
  startHarness,
  submitTransaction,
  wagerBody,
} from './harness.js';

let h: Harness;
let wallet: WalletBody;

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

const open = async (amount: string): Promise<WalletBody> => {
  wallet = await openWallet(h, amount);
  return wallet;
};

const bet = (
  amount: string,
  external: string,
  extra: Record<string, unknown> = {},
) =>
  submitTransaction(
    h,
    wagerBody({
      walletId: wallet.id,
      playerId: PLAYER_A,
      kind: 'BET',
      money: { amount, currency: 'BRL' },
      externalTransactionId: external,
      ...extra,
    }),
  );

describe('POST /wagering/transactions — BET', () => {
  it('aplica o débito e responde 200', async () => {
    await open('1000.00');

    const response = await bet('25.00', 'bet-1');
    expect(response.status).toBe(200);

    expect(await json<SubmitResponseBody>(response)).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '975.00', currency: 'BRL' },
      idempotentReplay: false,
    });
  });

  it('grava transação, par de lançamentos e eventos na mesma transação', async () => {
    await open('1000.00');
    const body = await json<SubmitResponseBody>(await bet('25.00', 'bet-1'));

    const entries = await h.sql<{
      direction: string;
      balance_after: string | null;
    }>(
      `SELECT direction, balance_after::text FROM ledger_entries
        WHERE transaction_id = ? ORDER BY direction`,
      [body.transactionId],
    );
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      direction: 'CREDIT',
      balance_after: null,
    });
    expect(entries[1]).toMatchObject({
      direction: 'DEBIT',
      balance_after: '975.00',
    });

    const events = await h.sql<{ event_type: string }>(
      'SELECT event_type FROM outbox_messages ORDER BY event_type',
    );
    expect(events.map((e) => e.event_type)).toEqual(
      [
        'WalletBalanceChanged',
        'WalletBalanceChanged',
        'WagerTransactionProcessed',
      ].sort(),
    );
  });

  it('saldo insuficiente responde 422 e deixa registro auditável', async () => {
    await open('10.00');

    const response = await bet('25.00', 'bet-1');
    expect(response.status).toBe(422);
    expect(await json<SubmitResponseBody>(response)).toMatchObject({
      status: 'REJECTED',
      failureCode: 'INSUFFICIENT_FUNDS',
      balance: { amount: '10.00', currency: 'BRL' },
    });

    const [row] = await h.sql<{ status: string; failure_code: string }>(
      "SELECT status, failure_code FROM wager_transactions WHERE kind = 'BET'",
    );
    expect(row).toMatchObject({
      status: 'REJECTED',
      failure_code: 'INSUFFICIENT_FUNDS',
    });
    expect(
      await h.sql("SELECT 1 FROM ledger_entries WHERE amount = '25.00'"),
    ).toHaveLength(0);
  });
});

describe('WIN, LOSS e reversões', () => {
  it('WIN credita', async () => {
    await open('100.00');

    const response = await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'WIN',
        money: { amount: '40.00', currency: 'BRL' },
        externalTransactionId: 'win-1',
      }),
    );

    expect(await json<SubmitResponseBody>(response)).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '140.00', currency: 'BRL' },
    });
  });

  it('LOSS registra sem mover saldo nem gerar lançamento', async () => {
    await open('100.00');

    const response = await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'LOSS',
        money: { amount: '40.00', currency: 'BRL' },
        externalTransactionId: 'loss-1',
      }),
    );

    expect(response.status).toBe(200);
    expect(await json<SubmitResponseBody>(response)).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
    });

    const entries = await h.sql(
      "SELECT 1 FROM ledger_entries e JOIN wager_transactions t ON t.id = e.transaction_id WHERE t.kind = 'LOSS'",
    );
    expect(entries).toHaveLength(0);

    const events = await h.sql<{ event_type: string }>(
      "SELECT event_type FROM outbox_messages WHERE event_type = 'WalletBalanceChanged'",
    );
    // Só o da abertura da wallet: LOSS não muda saldo.
    expect(events).toHaveLength(1);
  });

  it('REFUND reverte a BET e devolve o valor', async () => {
    await open('100.00');
    await bet('25.00', 'bet-1');

    const response = await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        externalTransactionId: 'refund-1',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    expect(await json<SubmitResponseBody>(response)).toMatchObject({
      status: 'PROCESSED',
      balance: { amount: '100.00', currency: 'BRL' },
    });
  });

  it('a segunda reversão da mesma BET é recusada, inclusive de outro tipo', async () => {
    await open('100.00');
    await bet('25.00', 'bet-1');

    await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'REFUND',
        money: { amount: '25.00', currency: 'BRL' },
        externalTransactionId: 'refund-1',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    const rollback = await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'ROLLBACK',
        money: { amount: '25.00', currency: 'BRL' },
        externalTransactionId: 'rollback-1',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    expect(rollback.status).toBe(422);
    expect(await json<SubmitResponseBody>(rollback)).toMatchObject({
      failureCode: 'REFERENCE_ALREADY_REVERSED',
    });

    const [row] = await h.sql<{ balance_amount: string }>(
      'SELECT balance_amount::text FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(row?.balance_amount).toBe('100.00');
  });

  it('referência ausente responde 202 com PENDING_REFERENCE', async () => {
    await open('100.00');

    const response = await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'ROLLBACK',
        money: { amount: '25.00', currency: 'BRL' },
        externalTransactionId: 'rollback-1',
        referenceExternalTransactionId: 'ainda-nao-chegou',
      }),
    );

    expect(response.status).toBe(202);
    expect(await json<SubmitResponseBody>(response)).toMatchObject({
      status: 'PENDING_REFERENCE',
      balance: { amount: '100.00', currency: 'BRL' },
    });

    const [row] = await h.sql<{ attempts: number; next_attempt_at: string }>(
      "SELECT attempts, next_attempt_at FROM wager_transactions WHERE kind = 'ROLLBACK'",
    );
    expect(row?.attempts).toBe(1);
    expect(row?.next_attempt_at).toBeTruthy();

    const events = await h.sql(
      "SELECT 1 FROM outbox_messages WHERE event_type = 'WagerTransactionPendingReference'",
    );
    expect(events).toHaveLength(1);
  });
});

describe('idempotência', () => {
  it('requisição idêntica devolve o resultado original sem duplicar o débito', async () => {
    await open('1000.00');

    const first = await json<SubmitResponseBody>(await bet('25.00', 'bet-1'));
    const second = await bet('25.00', 'bet-1');

    expect(second.status).toBe(200);
    const body = await json<SubmitResponseBody>(second);
    expect(body.idempotentReplay).toBe(true);
    expect(body.transactionId).toBe(first.transactionId);
    expect(body.balance).toEqual({ amount: '975.00', currency: 'BRL' });

    expect(
      await h.sql("SELECT 1 FROM wager_transactions WHERE kind = 'BET'"),
    ).toHaveLength(1);
    expect(
      await h.sql('SELECT 1 FROM ledger_entries WHERE transaction_id = ?', [
        first.transactionId,
      ]),
    ).toHaveLength(2);
  });

  it('o replay preserva o status HTTP original de uma rejeição', async () => {
    await open('10.00');

    expect((await bet('25.00', 'bet-1')).status).toBe(422);
    const replay = await bet('25.00', 'bet-1');

    expect(replay.status).toBe(422);
    expect(await json<SubmitResponseBody>(replay)).toMatchObject({
      idempotentReplay: true,
      failureCode: 'INSUFFICIENT_FUNDS',
    });
  });

  it('mesma key com payload diferente responde 409', async () => {
    await open('1000.00');
    await bet('25.00', 'bet-1');

    const conflict = await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'BET',
        money: { amount: '99.00', currency: 'BRL' },
        externalTransactionId: 'bet-1',
      }),
    );

    expect(conflict.status).toBe(409);
    expect(await json<ErrorBody>(conflict)).toMatchObject({
      failureCode: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    });

    const [row] = await h.sql<{ balance_amount: string }>(
      'SELECT balance_amount::text FROM wallets WHERE id = ?',
      [wallet.id],
    );
    expect(row?.balance_amount).toBe('975.00');
  });

  it('a ordem das chaves do corpo não altera o hash', async () => {
    await open('1000.00');
    const body = wagerBody({
      walletId: wallet.id,
      playerId: PLAYER_A,
      kind: 'BET',
      money: { amount: '25.00', currency: 'BRL' },
      externalTransactionId: 'bet-1',
    });

    await submitTransaction(h, body);

    // Mesmo conteúdo com chaves reordenadas: tem que ser replay, não conflito.
    const reordered = {
      money: { currency: 'BRL', amount: '25.00' },
      kind: 'BET',
      gameId: body.gameId,
      roundId: body.roundId,
      walletId: body.walletId,
      playerId: body.playerId,
      externalTransactionId: body.externalTransactionId,
      providerId: body.providerId,
    } as typeof body;

    const replay = await submitTransaction(h, reordered);
    expect(await json<SubmitResponseBody>(replay)).toMatchObject({
      idempotentReplay: true,
    });
  });

  it('header Idempotency-Key ausente responde 400', async () => {
    await open('1000.00');

    const response = await h.request('/wagering/transactions', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(
        wagerBody({ walletId: wallet.id, playerId: PLAYER_A, kind: 'BET' }),
      ),
    });

    expect(response.status).toBe(400);
  });
});

describe('validações', () => {
  it('OPENING submetido pela API responde 422', async () => {
    await open('100.00');

    const response = await submitTransaction(
      h,
      wagerBody({ walletId: wallet.id, playerId: PLAYER_A, kind: 'OPENING' }),
    );

    expect(response.status).toBe(422);
    expect(await json<ErrorBody>(response)).toMatchObject({
      failureCode: 'INTERNAL_KIND_NOT_ALLOWED',
    });
  });

  it('REFUND sem referência responde 422', async () => {
    await open('100.00');

    const response = await submitTransaction(
      h,
      wagerBody({ walletId: wallet.id, playerId: PLAYER_A, kind: 'REFUND' }),
    );

    expect(response.status).toBe(422);
    expect(await json<ErrorBody>(response)).toMatchObject({
      failureCode: 'REFERENCE_REQUIRED',
    });
  });

  it('player divergente da wallet responde 422', async () => {
    await open('100.00');

    const response = await submitTransaction(
      h,
      wagerBody({ walletId: wallet.id, playerId: PLAYER_B, kind: 'BET' }),
    );

    expect(response.status).toBe(422);
    expect(await json<SubmitResponseBody>(response)).toMatchObject({
      failureCode: 'WALLET_PLAYER_MISMATCH',
    });
  });

  it('moeda divergente da wallet responde 422', async () => {
    await open('100.00');

    const response = await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'BET',
        money: { amount: '10.00', currency: 'USD' },
      }),
    );

    expect(response.status).toBe(422);
    expect(await json<SubmitResponseBody>(response)).toMatchObject({
      failureCode: 'CURRENCY_MISMATCH',
    });
  });

  it('wallet inexistente responde 404', async () => {
    const response = await submitTransaction(
      h,
      wagerBody({ walletId: MISSING_WALLET, playerId: PLAYER_A, kind: 'BET' }),
    );

    expect(response.status).toBe(404);
  });

  it.each([
    ['kind desconhecido', { kind: 'TRANSFER' }],
    ['amount com 3 casas', { money: { amount: '1.234', currency: 'BRL' } }],
    ['amount negativo', { money: { amount: '-1.00', currency: 'BRL' } }],
    ['walletId não UUID', { walletId: 'abc' }],
  ])('rejeita %s com 400', async (_label, overrides) => {
    await open('100.00');

    const response = await submitTransaction(h, {
      ...wagerBody({ walletId: wallet.id, playerId: PLAYER_A, kind: 'BET' }),
      ...overrides,
    });

    expect(response.status).toBe(400);
  });
});

describe('consultas de transação', () => {
  it('busca por id interno', async () => {
    await open('1000.00');
    const created = await json<SubmitResponseBody>(await bet('25.00', 'bet-1'));

    const response = await h.request(
      `/wagering/transactions/${created.transactionId}`,
    );
    expect(response.status).toBe(200);
    expect(await json<Record<string, unknown>>(response)).toMatchObject({
      transactionId: created.transactionId,
      kind: 'BET',
      status: 'PROCESSED',
      money: { amount: '25.00', currency: 'BRL' },
      observedBalance: { amount: '975.00', currency: 'BRL' },
    });
  });

  it('busca pelo id do provedor', async () => {
    await open('1000.00');
    const created = await json<SubmitResponseBody>(await bet('25.00', 'bet-1'));

    const response = await h.request(
      `/providers/${PROVIDER}/wagering/transactions/bet-1`,
    );
    expect(response.status).toBe(200);
    expect(await json<Record<string, unknown>>(response)).toMatchObject({
      transactionId: created.transactionId,
      externalTransactionId: 'bet-1',
    });
  });

  it('404 para transação inexistente', async () => {
    expect(
      (await h.request(`/wagering/transactions/${MISSING_WALLET}`)).status,
    ).toBe(404);
    expect(
      (
        await h.request(
          `/providers/${PROVIDER}/wagering/transactions/nao-existe`,
        )
      ).status,
    ).toBe(404);
  });
});

describe('reconciliação após operações', () => {
  it('permanece consistente depois de uma sequência completa', async () => {
    await open('100.00');
    await bet('30.00', 'bet-1');
    await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'WIN',
        money: { amount: '12.00', currency: 'BRL' },
        externalTransactionId: 'win-1',
      }),
    );
    await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'LOSS',
        money: { amount: '5.00', currency: 'BRL' },
        externalTransactionId: 'loss-1',
      }),
    );
    await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'REFUND',
        money: { amount: '30.00', currency: 'BRL' },
        externalTransactionId: 'refund-1',
        referenceExternalTransactionId: 'bet-1',
      }),
    );

    const response = await h.request(`/wallets/${wallet.id}/reconciliation`, {
      method: 'POST',
    });

    expect(await json<Record<string, unknown>>(response)).toMatchObject({
      storedBalance: { amount: '112.00', currency: 'BRL' },
      calculatedBalance: { amount: '112.00', currency: 'BRL' },
      consistent: true,
      checkedEntries: 4,
    });
  });
});
