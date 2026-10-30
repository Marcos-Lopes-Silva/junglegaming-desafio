import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { ProcessPendingReferencesUseCase } from '@wagering/application';

const INTERVAL_MS = Number(process.env.PENDING_REFERENCE_INTERVAL_MS ?? 2_000);

/**
 * O intervalo pode ser curto porque o backoff de cada transação fica em
 * `next_attempt_at`: a cada tick só são buscadas as vencidas, com `LIMIT`.
 */
@Injectable()
export class PendingReferenceService {
  private readonly logger = new Logger(PendingReferenceService.name);
  private busy = false;

  constructor(
    @Inject(ProcessPendingReferencesUseCase)
    private readonly process: ProcessPendingReferencesUseCase,
  ) {}

  @Interval(INTERVAL_MS)
  async tick(): Promise<void> {
    if (this.busy) {
      return;
    }
    this.busy = true;

    try {
      const { examined, settled } = await this.process.execute();
      if (settled > 0) {
        this.logger.log({
          message: 'pending references settled',
          examined,
          settled,
        });
      }
    } catch (error) {
      this.logger.error({
        message: 'pending reference sweep failed',
        err: String(error),
      });
    } finally {
      this.busy = false;
    }
  }
}
