import { beforeEach, describe, expect, it } from 'bun:test';
import {
  ConsumeWagerMessageUseCase,
  type WagerTransactionRequestedMessage,
} from '@wagering/application';
import {
  FailureCode,
  WagerTransactionKind,
  WagerTransactionStatus,
} from '@wagering/domain';
import {
  MalformedMessageError,
  classifyDeliveryFailure,
  parseWagerTransactionMessage,
  retryVisibilitySeconds,
} from '@wagering/infrastructure';
import { FakeInboxRepository } from './fakes.js';
import {
  PLAYER,
  PROVIDER,
  ROUND,
  type WageringHarness,
  buildWageringHarness,
  openWallet,
  submitInput,
} from './wagering.harness.js';

let h: WageringHarness;

beforeEach(() => {
  h = buildWageringHarness();
});

const message = (
  overrides: Partial<WagerTransactionRequestedMessage['data']> & {
    walletId: string;
  },
  messageId = 'msg-1',
): WagerTransactionRequestedMessage => ({
  messageId,
  type: 'WagerTransactionRequested',
  occurredAt: '2026-07-29T15:00:00.000Z',
  data: {
    providerId: PROVIDER,
    externalTransactionId: overrides.externalTransactionId ?? 'tx-sqs-1',
    idempotencyKey:
      overrides.idempotencyKey ??
      `${PROVIDER}:${overrides.externalTransactionId ?? 'tx-sqs-1'}`,
    playerId: overrides.playerId ?? PLAYER,
    walletId: overrides.walletId,
    roundId: overrides.roundId ?? ROUND,
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
});

describe('consumo com dedup por inbox', () => {
  it('aplica a transação e registra a mensagem', async () => {
    const wallet = await openWallet(h, '100.00');

    const outcome = await h.consume.execute(message({ walletId: wallet.id }));

    expect(outcome).toMatchObject({
      status: 'settled',
      transactionStatus: WagerTransactionStatus.Processed,
    });
    expect(wallet.balance.toString()).toBe('75.00');
    expect(h.inbox.messages).toHaveLength(1);
    expect(h.inbox.messages[0]?.isProcessed()).toBe(true);
  });

  it('a mesma mensagem reentregue não produz segundo efeito', async () => {
    const wallet = await openWallet(h, '100.00');
    const msg = message({ walletId: wallet.id });

    await h.consume.execute(msg);
    const second = await h.consume.execute(msg);

    expect(second.status).toBe('duplicate');
    expect(wallet.balance.toString()).toBe('75.00');
    expect(h.metrics.inboxDuplicates).toBe(1);
    expect(
      h.transactions.transactions.filter(
        (t) => t.kind === WagerTransactionKind.Bet,
      ),
    ).toHaveLength(1);
  });

  it('dez redeliveries da mesma mensagem debitam uma vez', async () => {
    const wallet = await openWallet(h, '100.00');
    const msg = message({ walletId: wallet.id });

    for (let i = 0; i < 10; i += 1) {
      await h.consume.execute(msg);
    }

    expect(wallet.balance.toString()).toBe('75.00');
    expect(h.metrics.inboxDuplicates).toBe(9);
  });

  it('messageIds diferentes com a mesma idempotency key caem na idempotência da transação', async () => {
    // Duas mensagens distintas do broker para a mesma operação de negócio: o
    // inbox deixa passar, a unique da transação segura.
    const wallet = await openWallet(h, '100.00');

    await h.consume.execute(message({ walletId: wallet.id }, 'msg-a'));
    await h.consume.execute(message({ walletId: wallet.id }, 'msg-b'));

    expect(wallet.balance.toString()).toBe('75.00');
    expect(h.inbox.messages).toHaveLength(2);
    expect(h.metrics.idempotentReplays).toBe(1);
  });

  it('a dedup é por consumidor, não só por messageId', async () => {
    // Dois consumidores compartilhando o mesmo inbox: cada um precisa poder
    // processar a mesma mensagem uma vez, porque a chave é
    // `(consumerName, messageId)`.
    const sharedInbox = new FakeInboxRepository();
    const deps = {
      inbox: sharedInbox,
      submit: h.submit,
      runner: h.runner,
      clock: h.clock,
      hasher: h.hasher,
      metrics: h.metrics,
    };
    const first = new ConsumeWagerMessageUseCase(deps, 'consumidor-a');
    const second = new ConsumeWagerMessageUseCase(deps, 'consumidor-b');

    const wallet = await openWallet(h, '100.00');
    const msg = message({ walletId: wallet.id });

    expect((await first.execute(msg)).status).toBe('settled');
    // Passa pelo inbox do outro consumidor, e a unique da transação faz o
    // resto: o efeito financeiro continua único.
    expect((await second.execute(msg)).status).toBe('settled');
    expect((await first.execute(msg)).status).toBe('duplicate');

    expect(sharedInbox.messages).toHaveLength(2);
    expect(wallet.balance.toString()).toBe('75.00');
  });

  it('rejeição de negócio é desfecho, não falha de entrega', async () => {
    const wallet = await openWallet(h, '10.00');

    const outcome = await h.consume.execute(message({ walletId: wallet.id }));

    expect(outcome).toMatchObject({
      status: 'settled',
      transactionStatus: WagerTransactionStatus.Rejected,
      failureCode: FailureCode.InsufficientFunds,
    });
  });

  it('registra latência de processamento', async () => {
    const wallet = await openWallet(h, '100.00');
    await h.consume.execute(message({ walletId: wallet.id }));

    expect(h.metrics.latencies.some((entry) => entry.source === 'sqs')).toBe(
      true,
    );
  });
});

describe('publisher da outbox', () => {
  const enqueue = async (count: number) => {
    const wallet = await openWallet(h, '1000.00');
    for (let i = 0; i < count; i += 1) {
      await h.submit.execute(
        submitInput({
          walletId: wallet.id,
          kind: WagerTransactionKind.Bet,
          amount: '1.00',
          externalTransactionId: `bet-${i}`,
        }),
      );
    }
    return wallet;
  };

  it('publica as mensagens pendentes', async () => {
    await enqueue(2);
    const pending = h.outbox.messages.length;

    const result = await h.publishOutbox.execute();

    expect(result).toEqual({ published: pending, failed: 0 });
    expect(h.publisher.published).toHaveLength(pending);
    expect(h.outbox.messages.every((message) => !message.isPending())).toBe(
      true,
    );
  });

  it('respeita o limite do lote', async () => {
    await enqueue(3);

    const result = await h.publishOutbox.execute(2);

    expect(result.published).toBe(2);
  });

  it('falha de publicação agenda retentativa com backoff', async () => {
    await enqueue(1);
    h.publisher.failTimes = 99;

    const result = await h.publishOutbox.execute();

    expect(result.failed).toBeGreaterThan(0);
    expect(result.published).toBe(0);
    expect(
      h.metrics.retries.filter((stage) => stage === 'outbox').length,
    ).toBeGreaterThan(0);

    const [message] = h.outbox.messages;
    expect(message?.isPending()).toBe(true);
    expect(message?.attempts).toBe(1);
    expect(message?.nextAttemptAt?.getTime()).toBeGreaterThan(
      h.clock.now().getTime(),
    );
  });

  it('a mensagem volta a ser publicada depois do backoff', async () => {
    await enqueue(1);
    const total = h.outbox.messages.length;
    h.publisher.failTimes = 1;

    expect(await h.publishOutbox.execute()).toEqual({
      published: total - 1,
      failed: 1,
    });

    expect((await h.publishOutbox.execute()).published).toBe(0);

    h.clock.advance(3_000);
    expect((await h.publishOutbox.execute()).published).toBe(1);
    expect(h.outbox.messages.every((message) => !message.isPending())).toBe(
      true,
    );
  });

  it('publishers concorrentes não publicam a mesma mensagem', async () => {
    // O dublê imita o FOR UPDATE SKIP LOCKED.
    await enqueue(2);
    const total = h.outbox.messages.length;

    const [first, second] = await Promise.all([
      h.publishOutbox.execute(total),
      h.publishOutbox.execute(total),
    ]);

    expect(first.published + second.published).toBe(total);
    expect(
      new Set(h.publisher.published.map((message) => message.id)).size,
    ).toBe(total);
  });

  it('reporta o outbox lag', async () => {
    await enqueue(1);
    h.clock.advance(5_000);

    await h.publishOutbox.execute();

    expect(h.metrics.outboxLagSeconds).toBe(0);
  });
});

describe('backoff da outbox', () => {
  it('cresce exponencialmente até o teto', async () => {
    await openWallet(h, '100.00');
    const outboxMessage = h.outbox.messages[0];
    expect(outboxMessage).toBeDefined();

    const now = h.clock.now();
    const delays: number[] = [];

    for (let i = 0; i < 6; i += 1) {
      outboxMessage?.scheduleRetry(now);
      delays.push(
        (outboxMessage?.nextAttemptAt?.getTime() ?? 0) - now.getTime(),
      );
    }

    expect(delays).toEqual([2_000, 4_000, 8_000, 16_000, 32_000, 60_000]);
    expect(outboxMessage?.attempts).toBe(6);
  });

  it('isDue respeita a janela agendada', async () => {
    await openWallet(h, '100.00');
    const outboxMessage = h.outbox.messages[0];
    const now = h.clock.now();

    expect(outboxMessage?.isDue(now)).toBe(true);

    outboxMessage?.scheduleRetry(now);
    expect(outboxMessage?.isDue(now)).toBe(false);
    expect(outboxMessage?.isDue(new Date(now.getTime() + 2_000))).toBe(true);
  });

  it('mensagem publicada deixa de ser elegível', async () => {
    await openWallet(h, '100.00');
    const outboxMessage = h.outbox.messages[0];
    const now = h.clock.now();

    outboxMessage?.markPublished(now);

    expect(outboxMessage?.isPending()).toBe(false);
    expect(outboxMessage?.isDue(now)).toBe(false);
  });
});

describe('parser do envelope', () => {
  const valid = JSON.stringify(
    message({ walletId: '0192f291-27dd-7d3f-8071-5f8685deef37' }),
  );

  it('aceita o envelope de WagerTransactionRequested', () => {
    const parsed = parseWagerTransactionMessage(valid);

    expect(parsed.messageId).toBe('msg-1');
    expect(parsed.data.kind).toBe(WagerTransactionKind.Bet);
    expect(parsed.data.money).toEqual({ amount: '25.00', currency: 'BRL' });
  });

  it('preserva a referência quando presente', () => {
    const body = JSON.stringify(
      message({ walletId: 'w1', referenceExternalTransactionId: 'bet-1' }),
    );
    expect(
      parseWagerTransactionMessage(body).data.referenceExternalTransactionId,
    ).toBe('bet-1');
  });

  it.each([
    ['json inválido', 'not json'],
    ['não é objeto', '"texto"'],
    ['sem type', JSON.stringify({ messageId: 'm' })],
    [
      'type desconhecido',
      JSON.stringify({
        messageId: 'm',
        type: 'Outro',
        occurredAt: 'x',
        data: {},
      }),
    ],
    [
      'sem data',
      JSON.stringify({
        messageId: 'm',
        type: 'WagerTransactionRequested',
        occurredAt: 'x',
      }),
    ],
    [
      'kind inválido',
      JSON.stringify({
        messageId: 'm',
        type: 'WagerTransactionRequested',
        occurredAt: 'x',
        data: { ...message({ walletId: 'w' }).data, kind: 'TRANSFER' },
      }),
    ],
    [
      'sem money',
      JSON.stringify({
        messageId: 'm',
        type: 'WagerTransactionRequested',
        occurredAt: 'x',
        data: { ...message({ walletId: 'w' }).data, money: undefined },
      }),
    ],
  ])('rejeita %s', (_label, body) => {
    expect(() => parseWagerTransactionMessage(body)).toThrow(
      MalformedMessageError,
    );
  });
});

describe('classificação de falha de entrega', () => {
  it('erro de domínio é permanente e vai para a DLQ', () => {
    expect(classifyDeliveryFailure(new MalformedMessageError('x'))).toBe('dlq');
  });

  it('erro de infraestrutura é transitório e vira retentativa', () => {
    expect(classifyDeliveryFailure(new Error('connection reset'))).toBe(
      'retry',
    );
    expect(classifyDeliveryFailure('string solta')).toBe('retry');
  });

  it('backoff da visibilidade cresce até o teto de 5 minutos', () => {
    expect(retryVisibilitySeconds(1)).toBe(5);
    expect(retryVisibilitySeconds(2)).toBe(10);
    expect(retryVisibilitySeconds(3)).toBe(20);
    expect(retryVisibilitySeconds(20)).toBe(300);
  });
});
