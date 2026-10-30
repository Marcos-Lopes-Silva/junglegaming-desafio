import type { MetricsPort } from '@wagering/application';

/** Descarta as métricas até existir um adaptador que as exponha. */
export class NoopMetrics implements MetricsPort {
  recordReconciliation(): void {}
  recordWalletOpened(): void {}
  recordTransaction(): void {}
  recordIdempotentReplay(): void {}
  recordIdempotencyConflict(): void {}
  recordInboxDuplicate(): void {}
  recordRetry(): void {}
  recordDlqMessage(): void {}
  recordOutboxLag(): void {}
  observeProcessingLatency(): void {}
}
