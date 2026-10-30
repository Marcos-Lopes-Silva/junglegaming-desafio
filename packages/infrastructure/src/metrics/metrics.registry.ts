import type { MetricsPort } from '@wagering/application';
import {
  Counter,
  Gauge,
  Histogram,
  Registry,
  collectDefaultMetrics,
} from 'prom-client';

export class MetricsRegistry implements MetricsPort {
  readonly registry = new Registry();

  private readonly walletsOpened: Counter;
  private readonly reconciliations: Counter;
  private readonly transactions: Counter;
  private readonly idempotentReplays: Counter;
  private readonly idempotencyConflicts: Counter;
  private readonly inboxDuplicates: Counter;
  private readonly retries: Counter;
  private readonly dlqMessages: Counter;
  private readonly outboxLag: Gauge;
  private readonly processingLatency: Histogram;

  constructor() {
    collectDefaultMetrics({ register: this.registry });

    this.walletsOpened = new Counter({
      name: 'wallets_opened_total',
      help: 'Wallets abertas com sucesso',
      registers: [this.registry],
    });

    this.reconciliations = new Counter({
      name: 'reconciliations_total',
      help: 'Reconciliações executadas, rotuladas por resultado',
      labelNames: ['result'] as const,
      registers: [this.registry],
    });

    this.transactions = new Counter({
      name: 'wager_transactions_total',
      help: 'Transações de aposta, por status final e tipo',
      labelNames: ['status', 'kind'] as const,
      registers: [this.registry],
    });

    this.idempotentReplays = new Counter({
      name: 'idempotent_replays_total',
      help: 'Requisições atendidas como replay de uma transação já existente',
      registers: [this.registry],
    });

    this.idempotencyConflicts = new Counter({
      name: 'idempotency_conflicts_total',
      help: 'Mesma idempotency key reusada com payload diferente',
      registers: [this.registry],
    });

    this.inboxDuplicates = new Counter({
      name: 'inbox_duplicates_total',
      help: 'Mensagens redundantes barradas pelo inbox persistente',
      registers: [this.registry],
    });

    this.retries = new Counter({
      name: 'retries_total',
      help: 'Retentativas, por estágio (consumer, outbox, pending-reference)',
      labelNames: ['stage'] as const,
      registers: [this.registry],
    });

    this.dlqMessages = new Counter({
      name: 'dlq_messages_total',
      help: 'Mensagens roteadas para a DLQ, por motivo',
      labelNames: ['reason'] as const,
      registers: [this.registry],
    });

    this.outboxLag = new Gauge({
      name: 'outbox_lag_seconds',
      help: 'Idade da mensagem de outbox pendente mais antiga',
      registers: [this.registry],
    });

    this.processingLatency = new Histogram({
      name: 'processing_latency_seconds',
      help: 'Latência de processamento, por origem',
      labelNames: ['source'] as const,
      buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
      registers: [this.registry],
    });
  }

  recordWalletOpened(): void {
    this.walletsOpened.inc();
  }

  /** Divergências encontradas na reconciliação. */
  recordReconciliation(consistent: boolean): void {
    this.reconciliations.inc({
      result: consistent ? 'consistent' : 'divergent',
    });
  }

  recordTransaction(status: string, kind: string): void {
    this.transactions.inc({ status, kind });
  }

  recordIdempotentReplay(): void {
    this.idempotentReplays.inc();
  }

  recordIdempotencyConflict(): void {
    this.idempotencyConflicts.inc();
  }

  recordInboxDuplicate(): void {
    this.inboxDuplicates.inc();
  }

  recordRetry(stage: string): void {
    this.retries.inc({ stage });
  }

  recordDlqMessage(reason: string): void {
    this.dlqMessages.inc({ reason });
  }

  recordOutboxLag(seconds: number): void {
    this.outboxLag.set(seconds);
  }

  observeProcessingLatency(source: string, seconds: number): void {
    this.processingLatency.observe({ source }, seconds);
  }

  metrics(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
