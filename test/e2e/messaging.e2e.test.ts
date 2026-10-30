import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  ConsumeWagerMessageUseCase,
  METRICS,
  type MetricsPort,
  ProcessPendingReferencesUseCase,
  PublishOutboxBatchUseCase,
  type WagerTransactionRequestedMessage,
} from '@wagering/application';
import { WagerTransactionKind } from '@wagering/domain';
import { WagerMessageConsumer } from '@wagering/infrastructure';
import {
  type Harness,
  PLAYER_A,
  PROVIDER,
  type SubmitResponseBody,
  type WalletBody,
  json,
  openWallet,
  startHarness,
  submitTransaction,
  uniqueSuffix,
  wagerBody,
} from './harness.js';

let h: Harness;
let consume: ConsumeWagerMessageUseCase;
let publishOutbox: PublishOutboxBatchUseCase;
let processPending: ProcessPendingReferencesUseCase;

// Os hooks falam com SQS, que usa long polling: o timeout padrão de 5s do
// runner não dá conta.
beforeAll(async () => {
  h = await startHarness();
  consume = h.get(ConsumeWagerMessageUseCase);
  publishOutbox = h.get(PublishOutboxBatchUseCase);
  processPending = h.get(ProcessPendingReferencesUseCase);

  // Resíduo de execuções anteriores atrapalharia a contagem nas filas.
  await h.drainQueue(h.gateway.options.transactionsQueue, 1);
  await h.drainQueue(h.gateway.options.eventsQueue, 1);
  await h.drainQueue(h.gateway.options.transactionsDlq, 1);
}, 60_000);

afterEach(async () => {
  await h.assertLedgerInvariant();
  await h.reset();
  await h.drainQueue(h.gateway.options.eventsQueue, 1);
}, 30_000);

afterAll(async () => {
  await h.close();
}, 30_000);

const envelope = (
  wallet: WalletBody,
  overrides: Partial<WagerTransactionRequestedMessage['data']> = {},
  messageId = `msg-${uniqueSuffix()}`,
): WagerTransactionRequestedMessage => {
  const externalTransactionId =
    overrides.externalTransactionId ?? `sqs-${uniqueSuffix()}`;

  return {
    messageId,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: PROVIDER,
      externalTransactionId,
      idempotencyKey:
        overrides.idempotencyKey ?? `${PROVIDER}:${externalTransactionId}`,
      playerId: overrides.playerId ?? PLAYER_A,
      walletId: wallet.id,
      roundId: overrides.roundId ?? 'round-987',
      gameId: overrides.gameId ?? 'fortune-chimp',
      kind: overrides.kind ?? WagerTransactionKind.Bet,
      money: overrides.money ?? { amount: '25.00', currency: 'BRL' },
      ...(overrides.referenceExternalTransactionId
        ? {
            referenceExternalTransactionId:
              overrides.referenceExternalTransactionId,
          }
        : {}),
    },
  };
};

const balanceOf = async (walletId: string): Promise<string> => {
  const [row] = await h.sql<{ balance_amount: string }>(
    'SELECT balance_amount::text FROM wallets WHERE id = ?',
    [walletId],
  );
  return row?.balance_amount ?? 'missing';
};

describe('inbox e redelivery', () => {
  it('aplica a transação e registra a mensagem na mesma transação SQL', async () => {
    const wallet = await openWallet(h, '100.00');

    const outcome = await consume.execute(envelope(wallet));

    expect(outcome.status).toBe('settled');
    expect(await balanceOf(wallet.id)).toBe('75.00');

    const [inbox] = await h.sql<{
      consumer_name: string;
      processed_at: string | null;
    }>('SELECT consumer_name, processed_at FROM inbox_messages');
    expect(inbox?.consumer_name).toBe('wager-transactions');
    // Inbox e transação são gravados juntos.
    expect(inbox?.processed_at).toBeTruthy();
  });

  it('redelivery da mesma mensagem não duplica o débito', async () => {
    const wallet = await openWallet(h, '100.00');
    const message = envelope(wallet);

    await consume.execute(message);
    const second = await consume.execute(message);
    const third = await consume.execute(message);

    expect(second.status).toBe('duplicate');
    expect(third.status).toBe('duplicate');
    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(
      await h.sql("SELECT 1 FROM wager_transactions WHERE kind = 'BET'"),
    ).toHaveLength(1);
    expect(await h.sql('SELECT 1 FROM inbox_messages')).toHaveLength(1);
  });

  it('20 redeliveries concorrentes da mesma mensagem debitam uma vez', async () => {
    const wallet = await openWallet(h, '100.00');
    const message = envelope(wallet);

    const outcomes = await Promise.all(
      Array.from({ length: 20 }, () => consume.execute(message)),
    );

    expect(
      outcomes.filter((outcome) => outcome.status === 'settled'),
    ).toHaveLength(1);
    expect(await balanceOf(wallet.id)).toBe('75.00');

    const debits = await h.sql(
      `SELECT 1 FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.wallet_id = ? AND e.direction = 'DEBIT'`,
      [wallet.id],
    );
    expect(debits).toHaveLength(1);
  }, 60_000);

  it('o commit do inbox e o efeito financeiro são atômicos', async () => {
    // Wallet inexistente: o caso de uso lança, e nada deve sobrar: nem a
    // linha do inbox nem a transação.
    const ghost = { id: '0192f291-27dd-7d3f-8071-5f8685deef37' } as WalletBody;

    const error = await consume
      .execute(envelope(ghost))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);

    expect(await h.sql('SELECT 1 FROM inbox_messages')).toHaveLength(0);
    expect(await h.sql('SELECT 1 FROM wager_transactions')).toHaveLength(0);
  });
});

describe('publisher da outbox', () => {
  it('publica os eventos pendentes na fila de eventos', async () => {
    const wallet = await openWallet(h, '100.00');
    await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        externalTransactionId: `bet-${uniqueSuffix()}`,
      }),
    );

    const pending = await h.sql(
      'SELECT 1 FROM outbox_messages WHERE published_at IS NULL',
    );
    expect(pending.length).toBeGreaterThan(0);

    const result = await publishOutbox.execute();

    expect(result.published).toBe(pending.length);
    expect(result.failed).toBe(0);
    expect(
      await h.sql('SELECT 1 FROM outbox_messages WHERE published_at IS NULL'),
    ).toHaveLength(0);

    const delivered = await h.drainQueue(h.gateway.options.eventsQueue, 4);
    const types = delivered.map(
      (body) => (JSON.parse(body) as { eventType: string }).eventType,
    );
    expect(types).toContain('WagerTransactionProcessed');
    expect(types).toContain('WalletBalanceChanged');
  }, 60_000);

  it('o envelope publicado traz o dinheiro em string', async () => {
    const wallet = await openWallet(h, '100.00');
    await publishOutbox.execute();

    const [body] = await h.drainQueue(h.gateway.options.eventsQueue, 4);
    const event = JSON.parse(body ?? '{}') as Record<string, unknown>;

    expect(event).toMatchObject({
      eventType: 'WalletBalanceChanged',
      aggregateId: wallet.id,
      version: 1,
    });
    expect(typeof event.occurredAt).toBe('string');
    expect((event.data as { money: unknown }).money).toEqual({
      amount: '100.00',
      currency: 'BRL',
    });
  }, 60_000);

  it('dois publishers concorrentes não publicam a mesma mensagem', async () => {
    const wallet = await openWallet(h, '500.00');
    for (let i = 0; i < 4; i += 1) {
      await submitTransaction(
        h,
        wagerBody({
          walletId: wallet.id,
          playerId: PLAYER_A,
          kind: 'BET',
          money: { amount: '10.00', currency: 'BRL' },
          externalTransactionId: `bet-${uniqueSuffix()}`,
        }),
      );
    }

    const total = (
      await h.sql('SELECT 1 FROM outbox_messages WHERE published_at IS NULL')
    ).length;

    // FOR UPDATE SKIP LOCKED: cada publisher pega um lote disjunto.
    const results = await Promise.all([
      publishOutbox.execute(total),
      publishOutbox.execute(total),
      publishOutbox.execute(total),
    ]);

    const published = results.reduce(
      (sum, result) => sum + result.published,
      0,
    );
    expect(published).toBe(total);
    expect(
      await h.sql('SELECT 1 FROM outbox_messages WHERE published_at IS NULL'),
    ).toHaveLength(0);

    const delivered = await h.drainQueue(h.gateway.options.eventsQueue, 6);
    const ids = delivered.map(
      (body) => (JSON.parse(body) as { eventId: string }).eventId,
    );
    expect(new Set(ids).size).toBe(ids.length);
  }, 90_000);

  it('eventos pendentes sobrevivem ao restart e são publicados depois', async () => {
    const wallet = await openWallet(h, '100.00');
    const pending = (
      await h.sql('SELECT 1 FROM outbox_messages WHERE published_at IS NULL')
    ).length;
    expect(pending).toBeGreaterThan(0);

    const restarted = await startHarness({ reset: false });
    try {
      const result = await restarted
        .get<PublishOutboxBatchUseCase>(PublishOutboxBatchUseCase)
        .execute();

      expect(result.published).toBe(pending);
      expect(await balanceOf(wallet.id)).toBe('100.00');
    } finally {
      await restarted.close();
    }
  }, 60_000);
});

describe('consumidor contra a fila real', () => {
  const startConsumer = () => {
    return new WagerMessageConsumer({
      gateway: h.gateway,
      consume,
      metrics: h.get<MetricsPort>(METRICS),
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    });
  };

  it('consome da fila, aplica e dá ack', async () => {
    const wallet = await openWallet(h, '100.00');
    await h.sendWagerMessage(
      envelope(wallet) as unknown as Record<string, unknown>,
    );

    const consumer = startConsumer();
    consumer.start();

    try {
      await waitFor(
        async () => (await balanceOf(wallet.id)) === '75.00',
        20_000,
      );
    } finally {
      await consumer.stop();
    }

    expect(await balanceOf(wallet.id)).toBe('75.00');
    expect(
      await h.drainQueue(h.gateway.options.transactionsQueue, 2),
    ).toHaveLength(0);
  }, 90_000);

  it('mensagem malformada vai para a DLQ e sai da fila principal', async () => {
    await h.gateway.send({
      queue: h.gateway.options.transactionsQueue,
      body: 'isto nao e json',
      groupId: 'malformada',
      deduplicationId: `malformada-${uniqueSuffix()}`,
    });

    const consumer = startConsumer();
    consumer.start();

    try {
      const dlq = await waitForValue(async () => {
        const bodies = await h.drainQueue(h.gateway.options.transactionsDlq, 1);
        return bodies.length > 0 ? bodies : undefined;
      }, 20_000);

      expect(dlq).toBeDefined();
      const payload = JSON.parse(dlq?.[0] ?? '{}') as {
        reason: string;
        originalBody: string;
      };
      expect(payload.reason).toContain('malformed message');
      expect(payload.originalBody).toBe('isto nao e json');
    } finally {
      await consumer.stop();
    }
  }, 90_000);

  it('a parada graciosa espera a mensagem em andamento', async () => {
    const wallet = await openWallet(h, '100.00');
    await h.sendWagerMessage(
      envelope(wallet) as unknown as Record<string, unknown>,
    );

    const consumer = startConsumer();
    consumer.start();

    // Pede a parada quase imediatamente: o `stop()` só retorna depois de o
    // loop drenar, então nada pode ficar pela metade.
    await new Promise((resolve) => setTimeout(resolve, 500));
    await consumer.stop();

    expect(consumer.isRunning).toBe(false);

    // A mensagem foi processada ou voltou para a fila.
    const balance = await balanceOf(wallet.id);
    const remaining = await h.drainQueue(
      h.gateway.options.transactionsQueue,
      2,
    );
    expect(balance === '75.00' || remaining.length === 1).toBe(true);
  }, 90_000);
});

describe('referência fora de ordem resolvida pelo worker', () => {
  it('o ROLLBACK estacionado é aplicado quando a BET chega', async () => {
    const wallet = await openWallet(h, '100.00');
    const betExternalId = `bet-${uniqueSuffix()}`;

    const parked = await json<SubmitResponseBody>(
      await submitTransaction(
        h,
        wagerBody({
          walletId: wallet.id,
          playerId: PLAYER_A,
          kind: 'ROLLBACK',
          money: { amount: '25.00', currency: 'BRL' },
          externalTransactionId: `rollback-${uniqueSuffix()}`,
          referenceExternalTransactionId: betExternalId,
        }),
      ),
    );
    expect(parked.status).toBe('PENDING_REFERENCE');

    await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        externalTransactionId: betExternalId,
      }),
    );
    expect(await balanceOf(wallet.id)).toBe('75.00');

    await h.sql(
      "UPDATE wager_transactions SET next_attempt_at = now() - interval '1 second' WHERE id = ?",
      [parked.transactionId],
    );

    const result = await processPending.execute();

    expect(result).toEqual({ examined: 1, settled: 1 });
    expect(await balanceOf(wallet.id)).toBe('100.00');

    const [settled] = await h.sql<{
      status: string;
      reference_transaction_id: string | null;
    }>(
      'SELECT status, reference_transaction_id FROM wager_transactions WHERE id = ?',
      [parked.transactionId],
    );
    expect(settled?.status).toBe('PROCESSED');
    expect(settled?.reference_transaction_id).toBeTruthy();
  }, 60_000);

  it('esgotado o TTL, a pendência é rejeitada com REFERENCE_NOT_FOUND', async () => {
    const wallet = await openWallet(h, '100.00');

    const parked = await json<SubmitResponseBody>(
      await submitTransaction(
        h,
        wagerBody({
          walletId: wallet.id,
          playerId: PLAYER_A,
          kind: 'REFUND',
          money: { amount: '25.00', currency: 'BRL' },
          externalTransactionId: `refund-${uniqueSuffix()}`,
          referenceExternalTransactionId: 'nunca-vai-chegar',
        }),
      ),
    );
    expect(parked.status).toBe('PENDING_REFERENCE');

    await h.sql(
      `UPDATE wager_transactions
          SET created_at = now() - interval '11 minutes',
              next_attempt_at = now() - interval '1 second'
        WHERE id = ?`,
      [parked.transactionId],
    );

    const result = await processPending.execute();
    expect(result.settled).toBe(1);

    const [rejected] = await h.sql<{ status: string; failure_code: string }>(
      'SELECT status, failure_code FROM wager_transactions WHERE id = ?',
      [parked.transactionId],
    );
    expect(rejected).toMatchObject({
      status: 'REJECTED',
      failure_code: 'REFERENCE_NOT_FOUND',
    });

    expect(await balanceOf(wallet.id)).toBe('100.00');

    const events = await h.sql(
      "SELECT 1 FROM outbox_messages WHERE event_type = 'WagerTransactionRejected'",
    );
    expect(events).toHaveLength(1);
  }, 60_000);

  it('o worker é seguro com várias instâncias rodando junto', async () => {
    const wallet = await openWallet(h, '100.00');
    const betExternalId = `bet-${uniqueSuffix()}`;

    const parked = await json<SubmitResponseBody>(
      await submitTransaction(
        h,
        wagerBody({
          walletId: wallet.id,
          playerId: PLAYER_A,
          kind: 'ROLLBACK',
          money: { amount: '25.00', currency: 'BRL' },
          externalTransactionId: `rollback-${uniqueSuffix()}`,
          referenceExternalTransactionId: betExternalId,
        }),
      ),
    );

    await submitTransaction(
      h,
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'BET',
        money: { amount: '25.00', currency: 'BRL' },
        externalTransactionId: betExternalId,
      }),
    );

    await h.sql(
      "UPDATE wager_transactions SET next_attempt_at = now() - interval '1 second' WHERE id = ?",
      [parked.transactionId],
    );

    const extra = await startHarness({ reset: false });
    try {
      const results = await Promise.all([
        processPending.execute(),
        extra
          .get<ProcessPendingReferencesUseCase>(ProcessPendingReferencesUseCase)
          .execute(),
      ]);

      // Só uma instância conclui; a outra encontra o status já resolvido.
      expect(results.reduce((sum, result) => sum + result.settled, 0)).toBe(1);
      expect(await balanceOf(wallet.id)).toBe('100.00');
    } finally {
      await extra.close();
    }
  }, 90_000);
});

async function waitFor(
  predicate: () => Promise<boolean>,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error('condition not met before timeout');
}

async function waitForValue<T>(
  produce: () => Promise<T | undefined>,
  timeoutMs: number,
): Promise<T | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await produce();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return undefined;
}
