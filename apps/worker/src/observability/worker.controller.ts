import { EntityManager } from '@mikro-orm/postgresql';
import {
  Controller,
  Get,
  Header,
  Inject,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { METRICS } from '@wagering/application';
import { SqsGateway, type MetricsRegistry } from '@wagering/infrastructure';

/**
 * `retries_total`, `dlq_messages_total` e `outbox_lag_seconds` só são
 * incrementados no worker, e cada processo tem seu próprio registry do
 * `prom-client`. Por isso o worker também expõe `/metrics`.
 */
@Controller()
export class WorkerController {
  private readonly logger = new Logger(WorkerController.name);

  constructor(
    @Inject(METRICS) private readonly metrics: MetricsRegistry,
    private readonly em: EntityManager,
    private readonly sqs: SqsGateway,
  ) {}

  @Get('metrics')
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return this.metrics.metrics();
  }

  @Get('health/live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Get('health/ready')
  async ready(): Promise<{ status: 'ok'; checks: Record<string, 'up'> }> {
    const failures: string[] = [];

    try {
      await this.em.getConnection().execute('SELECT 1');
    } catch (error) {
      this.logger.warn({
        message: 'postgres readiness failed',
        err: String(error),
      });
      failures.push('postgres');
    }

    try {
      await this.sqs.ping();
    } catch (error) {
      this.logger.warn({ message: 'sqs readiness failed', err: String(error) });
      failures.push('sqs');
    }

    if (failures.length > 0) {
      throw new ServiceUnavailableException({ status: 'degraded', failures });
    }

    return { status: 'ok', checks: { postgres: 'up', sqs: 'up' } };
  }
}
