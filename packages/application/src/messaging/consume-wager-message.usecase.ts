import {
  InboxMessage,
  type MoneyProps,
  type WagerTransactionKind,
} from '@wagering/domain';
import type {
  ClockPort,
  InboxRepositoryPort,
  MetricsPort,
  PayloadHasherPort,
  TransactionRunnerPort,
} from '../ports/index.js';
import type { SubmitWagerTransactionUseCase } from '../wagering/submit-wager-transaction.usecase.js';

export interface WagerTransactionRequestedMessage {
  messageId: string;
  type: string;
  occurredAt: string;
  data: {
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
  };
}

export type ConsumeOutcome =
  | { status: 'duplicate' }
  | {
      status: 'settled';
      transactionId: string;
      transactionStatus: string;
      failureCode?: string;
    };

export interface ConsumeWagerMessageDeps {
  inbox: InboxRepositoryPort;
  submit: SubmitWagerTransactionUseCase;
  runner: TransactionRunnerPort;
  clock: ClockPort;
  hasher: PayloadHasherPort;
  metrics: MetricsPort;
}

export const WAGER_CONSUMER_NAME = 'wager-transactions';

/**
 * O registro no inbox e os efeitos financeiros ficam na mesma transação SQL (o
 * `runner.run()` da submissão roda aninhado, por savepoint). Se o processo cair
 * antes do commit, não sobra linha no inbox e a redelivery reprocessa a
 * mensagem.
 */
export class ConsumeWagerMessageUseCase {
  constructor(
    private readonly deps: ConsumeWagerMessageDeps,
    private readonly consumerName: string = WAGER_CONSUMER_NAME,
  ) {}

  async execute(
    message: WagerTransactionRequestedMessage,
  ): Promise<ConsumeOutcome> {
    const startedAt = this.deps.clock.now();

    const input = {
      idempotencyKey: message.data.idempotencyKey,
      providerId: message.data.providerId,
      externalTransactionId: message.data.externalTransactionId,
      playerId: message.data.playerId,
      walletId: message.data.walletId,
      roundId: message.data.roundId,
      gameId: message.data.gameId,
      kind: message.data.kind,
      money: message.data.money,
      referenceExternalTransactionId:
        message.data.referenceExternalTransactionId,
      correlationId: message.messageId,
      causationId: message.messageId,
    };

    // O hash do inbox cobre o `data` inteiro do envelope; o da transação, só
    // os campos de negócio.
    const envelopeHash = this.deps.hasher.hash(message.data);

    const outcome = await this.deps.runner.run<ConsumeOutcome>(async () => {
      const received = InboxMessage.receive({
        messageId: message.messageId,
        consumerName: this.consumerName,
        payloadHash: envelopeHash,
        receivedAt: startedAt,
      });
      received.markProcessed(startedAt);

      const fresh = await this.deps.inbox.receiveIfAbsent(received);
      if (!fresh) {
        this.deps.metrics.recordInboxDuplicate();
        return { status: 'duplicate' };
      }

      const result = await this.deps.submit.execute(input);

      const settled: ConsumeOutcome = {
        status: 'settled',
        transactionId: result.transaction.id,
        transactionStatus: result.transaction.status,
      };
      const failureCode = result.transaction.failureCode;
      return failureCode ? { ...settled, failureCode } : settled;
    });

    const elapsedMs = this.deps.clock.now().getTime() - startedAt.getTime();
    this.deps.metrics.observeProcessingLatency('sqs', elapsedMs / 1000);

    return outcome;
  }
}
