import { afterAll, afterEach, beforeAll, describe, expect, it } from 'bun:test';
import {
  ConsumeWagerMessageUseCase,
  type WagerTransactionRequestedMessage,
} from '@wagering/application';
import { WagerTransactionKind } from '@wagering/domain';
import {
  type SpawnedProcess,
  allocatePort,
  sleep,
  spawnApi,
  spawnProcess,
  spawnWorker,
  waitFor,
  waitForHttp,
} from '../support/processes.js';
import {
  type Harness,
  PLAYER_A,
  PROVIDER,
  type SubmitResponseBody,
  type WalletBody,
  json,
  openWallet,
  startHarness,
  uniqueSuffix,
  wagerBody,
} from './harness.js';

let h: Harness;
const running: SpawnedProcess[] = [];

beforeAll(async () => {
  h = await startHarness();
  await h.drainQueue(h.gateway.options.transactionsQueue, 1);
  await h.drainQueue(h.gateway.options.eventsQueue, 1);
}, 60_000);

afterEach(async () => {
  for (const process_ of running.splice(0)) {
    process_.kill();
  }
  await h.assertLedgerInvariant();
  await h.reset();
  await h.drainQueue(h.gateway.options.transactionsQueue, 1);
  await h.drainQueue(h.gateway.options.eventsQueue, 1);
}, 60_000);

afterAll(async () => {
  await h.close();
}, 30_000);

const track = (process_: SpawnedProcess): SpawnedProcess => {
  running.push(process_);
  return process_;
};

const balanceOf = async (walletId: string): Promise<string> => {
  const [row] = await h.sql<{ balance_amount: string }>(
    'SELECT balance_amount::text FROM wallets WHERE id = ?',
    [walletId],
  );
  return row?.balance_amount ?? 'missing';
};

const betEnvelope = (
  wallet: WalletBody,
  amount = '25.00',
): WagerTransactionRequestedMessage => {
  const externalTransactionId = `crash-${uniqueSuffix()}`;
  return {
    messageId: `msg-${uniqueSuffix()}`,
    type: 'WagerTransactionRequested',
    occurredAt: new Date().toISOString(),
    data: {
      providerId: PROVIDER,
      externalTransactionId,
      idempotencyKey: `${PROVIDER}:${externalTransactionId}`,
      playerId: PLAYER_A,
      walletId: wallet.id,
      roundId: 'round-crash',
      gameId: 'fortune-chimp',
      kind: WagerTransactionKind.Bet,
      money: { amount, currency: 'BRL' },
    },
  };
};

describe('worker morto depois do commit e antes do ack', () => {
  it('o efeito é aplicado uma vez e a redelivery vira no-op', async () => {
    const wallet = await openWallet(h, '100.00');
    const envelope = betEnvelope(wallet, '25.00');
    await h.sendWagerMessage(envelope as unknown as Record<string, unknown>);

    // Visibilidade curta para a redelivery acontecer dentro do teste.
    const crasher = track(
      spawnProcess('test/support/crash-after-commit.ts', {
        SQS_VISIBILITY_TIMEOUT: '5',
      }),
    );

    // Morreu por SIGKILL depois de processar, e não por falha ao subir nem por
    // ter desistido sem achar mensagem.
    expect(await crasher.waitForExit()).toMatchObject({ signal: 'SIGKILL' });

    expect(await balanceOf(wallet.id)).toBe('75.00');
    const [inbox] = await h.sql<{ processed_at: string | null }>(
      'SELECT processed_at FROM inbox_messages',
    );
    expect(inbox?.processed_at).toBeTruthy();

    // E a mensagem continua na fila, porque o ack nunca aconteceu.
    await sleep(6_000);
    const consume = h.get<ConsumeWagerMessageUseCase>(
      ConsumeWagerMessageUseCase,
    );
    const redelivered = await waitForMessage();
    expect(redelivered).toBeDefined();

    const outcome = await consume.execute(
      JSON.parse(redelivered ?? '{}') as WagerTransactionRequestedMessage,
    );

    // O inbox transforma o reprocessamento em no-op.
    expect(outcome.status).toBe('duplicate');
    expect(await balanceOf(wallet.id)).toBe('75.00');

    const debits = await h.sql(
      `SELECT 1 FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.wallet_id = ? AND e.direction = 'DEBIT'`,
      [wallet.id],
    );
    expect(debits).toHaveLength(1);
  }, 120_000);

  it('um worker normal assume a mensagem redelivered sem duplicar', async () => {
    const wallet = await openWallet(h, '100.00');
    await h.sendWagerMessage(
      betEnvelope(wallet, '40.00') as unknown as Record<string, unknown>,
    );

    const crasher = track(
      spawnProcess('test/support/crash-after-commit.ts', {
        SQS_VISIBILITY_TIMEOUT: '5',
      }),
    );
    expect(await crasher.waitForExit()).toMatchObject({ signal: 'SIGKILL' });
    expect(await balanceOf(wallet.id)).toBe('60.00');

    const port = allocatePort();
    const worker = track(spawnWorker(port));
    await waitForHttp(`http://127.0.0.1:${port}/health/ready`, 40_000);

    await waitFor(
      async () =>
        (await h.drainQueue(h.gateway.options.transactionsQueue, 1)).length ===
        0,
      40_000,
      'fila drenada',
    );

    // Nenhum segundo débito: o saldo é o mesmo do commit original.
    expect(await balanceOf(wallet.id)).toBe('60.00');
    await worker.terminate();
  }, 150_000);
});

describe('reinício do serviço', () => {
  it('eventos pendentes são publicados pela instância que sobe depois', async () => {
    const wallet = await openWallet(h, '200.00');

    for (let i = 0; i < 3; i += 1) {
      await fetch(`${h.baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `${PROVIDER}:restart-${uniqueSuffix()}`,
        },
        body: JSON.stringify(
          wagerBody({
            walletId: wallet.id,
            playerId: PLAYER_A,
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
            externalTransactionId: `restart-${uniqueSuffix()}`,
          }),
        ),
      });
    }

    const pending = await h.sql(
      'SELECT 1 FROM outbox_messages WHERE published_at IS NULL',
    );
    expect(pending.length).toBeGreaterThan(0);

    const port = allocatePort();
    const worker = track(spawnWorker(port));
    await waitForHttp(`http://127.0.0.1:${port}/health/ready`, 40_000);

    await waitFor(
      async () =>
        (
          await h.sql(
            'SELECT 1 FROM outbox_messages WHERE published_at IS NULL',
          )
        ).length === 0,
      40_000,
      'outbox drenada',
    );

    expect(await balanceOf(wallet.id)).toBe('170.00');
    await worker.terminate();
  }, 150_000);

  it('matar e reiniciar no meio do trabalho preserva a consistência final', async () => {
    const wallet = await openWallet(h, '500.00');

    const port = allocatePort();
    const first = track(spawnWorker(port));
    await waitForHttp(`http://127.0.0.1:${port}/health/ready`, 40_000);

    for (let i = 0; i < 10; i += 1) {
      await h.sendWagerMessage(
        betEnvelope(wallet, '10.00') as unknown as Record<string, unknown>,
      );
    }

    await sleep(1_500);
    first.kill();
    await first.exited;

    const balanceAfterCrash = await balanceOf(wallet.id);

    const secondPort = allocatePort();
    const second = track(spawnWorker(secondPort));
    await waitForHttp(`http://127.0.0.1:${secondPort}/health/ready`, 40_000);

    await waitFor(
      async () => (await balanceOf(wallet.id)) === '400.00',
      60_000,
      'dez débitos',
    );

    expect(await balanceOf(wallet.id)).toBe('400.00');
    expect(Number(balanceAfterCrash)).toBeGreaterThanOrEqual(400);

    const debits = await h.sql(
      `SELECT 1 FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.wallet_id = ? AND e.direction = 'DEBIT'`,
      [wallet.id],
    );
    // Dez débitos: nada se perdeu no crash nem duplicou na redelivery.
    expect(debits).toHaveLength(10);

    await second.terminate();
  }, 180_000);

  it('SIGTERM deixa o worker encerrar sem perder mensagem', async () => {
    const wallet = await openWallet(h, '200.00');

    const port = allocatePort();
    const worker = track(spawnWorker(port));
    await waitForHttp(`http://127.0.0.1:${port}/health/ready`, 40_000);

    for (let i = 0; i < 5; i += 1) {
      await h.sendWagerMessage(
        betEnvelope(wallet, '10.00') as unknown as Record<string, unknown>,
      );
    }

    await sleep(1_000);
    await worker.terminate(20_000);

    const recovery = allocatePort();
    const resumed = track(spawnWorker(recovery));
    await waitForHttp(`http://127.0.0.1:${recovery}/health/ready`, 40_000);

    await waitFor(
      async () => (await balanceOf(wallet.id)) === '150.00',
      60_000,
      'cinco débitos',
    );

    expect(await balanceOf(wallet.id)).toBe('150.00');
    await resumed.terminate();
  }, 180_000);
});

describe('três processos simultâneos', () => {
  it('disputam a mesma wallet sem furar o saldo', async () => {
    const wallet = await openWallet(h, '100.00');

    const ports = [allocatePort(), allocatePort(), allocatePort()];
    const apis = ports.map((port) => track(spawnApi(port)));
    await Promise.all(
      ports.map((port) =>
        waitForHttp(`http://127.0.0.1:${port}/health/live`, 40_000),
      ),
    );

    // 21 apostas de 10.00 distribuídas entre os três processos; cabem 10.
    const responses = await Promise.all(
      Array.from({ length: 21 }, (_, index) => {
        const port = ports[index % ports.length];
        const externalTransactionId = `multi-${uniqueSuffix()}`;

        return fetch(`http://127.0.0.1:${port}/wagering/transactions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'idempotency-key': `${PROVIDER}:${externalTransactionId}`,
          },
          body: JSON.stringify(
            wagerBody({
              walletId: wallet.id,
              playerId: PLAYER_A,
              kind: 'BET',
              money: { amount: '10.00', currency: 'BRL' },
              externalTransactionId,
            }),
          ),
        });
      }),
    );

    const accepted = responses.filter(
      (response) => response.status === 200,
    ).length;
    const rejected = responses.filter(
      (response) => response.status === 422,
    ).length;

    expect(accepted).toBe(10);
    expect(rejected).toBe(11);
    expect(await balanceOf(wallet.id)).toBe('0.00');

    const debits = await h.sql(
      `SELECT 1 FROM ledger_entries e
         JOIN ledger_accounts a ON a.id = e.account_id
        WHERE a.wallet_id = ? AND e.direction = 'DEBIT'`,
      [wallet.id],
    );
    expect(debits).toHaveLength(10);

    await Promise.all(apis.map((api) => api.terminate()));
  }, 180_000);

  it('a mesma aposta enviada aos três processos debita uma vez', async () => {
    const wallet = await openWallet(h, '100.00');

    const ports = [allocatePort(), allocatePort(), allocatePort()];
    const apis = ports.map((port) => track(spawnApi(port)));
    await Promise.all(
      ports.map((port) =>
        waitForHttp(`http://127.0.0.1:${port}/health/live`, 40_000),
      ),
    );

    const externalTransactionId = `shared-${uniqueSuffix()}`;
    const body = JSON.stringify(
      wagerBody({
        walletId: wallet.id,
        playerId: PLAYER_A,
        kind: 'BET',
        money: { amount: '30.00', currency: 'BRL' },
        externalTransactionId,
      }),
    );

    const bodies = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        fetch(
          `http://127.0.0.1:${ports[index % ports.length]}/wagering/transactions`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'idempotency-key': `${PROVIDER}:${externalTransactionId}`,
            },
            body,
          },
        ).then((response) => json<SubmitResponseBody>(response)),
      ),
    );

    expect(new Set(bodies.map((item) => item.transactionId)).size).toBe(1);
    expect(bodies.filter((item) => !item.idempotentReplay)).toHaveLength(1);
    expect(await balanceOf(wallet.id)).toBe('70.00');

    await Promise.all(apis.map((api) => api.terminate()));
  }, 180_000);
});

describe('dois publishers em processos distintos', () => {
  it('não publicam o mesmo evento duas vezes', async () => {
    const wallet = await openWallet(h, '500.00');

    for (let i = 0; i < 5; i += 1) {
      await fetch(`${h.baseUrl}/wagering/transactions`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'idempotency-key': `${PROVIDER}:pub-${uniqueSuffix()}`,
        },
        body: JSON.stringify(
          wagerBody({
            walletId: wallet.id,
            playerId: PLAYER_A,
            kind: 'BET',
            money: { amount: '10.00', currency: 'BRL' },
            externalTransactionId: `pub-${uniqueSuffix()}`,
          }),
        ),
      });
    }

    const pending = (
      await h.sql('SELECT 1 FROM outbox_messages WHERE published_at IS NULL')
    ).length;
    expect(pending).toBeGreaterThan(5);

    const ports = [allocatePort(), allocatePort()];
    const workers = ports.map((port) => track(spawnWorker(port)));
    await Promise.all(
      ports.map((port) =>
        waitForHttp(`http://127.0.0.1:${port}/health/ready`, 40_000),
      ),
    );

    await waitFor(
      async () =>
        (
          await h.sql(
            'SELECT 1 FROM outbox_messages WHERE published_at IS NULL',
          )
        ).length === 0,
      60_000,
      'outbox drenada pelos dois publishers',
    );

    const delivered = await h.drainQueue(h.gateway.options.eventsQueue, 8);
    const ids = delivered.map(
      (body) => (JSON.parse(body) as { eventId: string }).eventId,
    );

    expect(ids.length).toBeGreaterThanOrEqual(pending);
    // Nenhum eventId repetido: o SKIP LOCKED deu lotes disjuntos.
    expect(new Set(ids).size).toBe(ids.length);

    await Promise.all(workers.map((worker) => worker.terminate()));
  }, 180_000);
});

async function waitForMessage(): Promise<string | undefined> {
  const deadline = Date.now() + 30_000;

  while (Date.now() < deadline) {
    const messages = await h.gateway.receive(
      h.gateway.options.transactionsQueue,
    );
    const message = messages[0];
    if (message?.Body) {
      if (message.ReceiptHandle) {
        await h.gateway.deleteMessage(
          h.gateway.options.transactionsQueue,
          message.ReceiptHandle,
        );
      }
      return message.Body;
    }
  }

  return undefined;
}
