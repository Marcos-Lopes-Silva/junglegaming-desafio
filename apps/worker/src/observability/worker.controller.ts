import { EntityManager } from '@mikro-orm/postgresql';
import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { SqsGateway } from '@wagering/infrastructure';

@Controller()
export class WorkerController {
  private readonly logger = new Logger(WorkerController.name);

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsGateway,
  ) {}

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
