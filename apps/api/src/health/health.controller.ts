import {
  Controller,
  Get,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { EntityManager } from '@mikro-orm/postgresql';
import { SqsGateway } from '@wagering/infrastructure';
import { Public } from '../common/public.decorator.js';

interface ReadinessReport {
  status: 'ok' | 'degraded';
  checks: Record<string, 'up' | 'down'>;
}

/**
 * Sem Terminus: são só duas checagens e não compensa a dependência.
 */
@Controller('health')
export class HealthController {
  private readonly logger = new Logger(HealthController.name);

  constructor(
    private readonly em: EntityManager,
    private readonly sqs: SqsGateway,
  ) {}

  /** Só indica que o processo está de pé; não consulta banco nem fila. */
  @Public()
  @Get('live')
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  @Public()
  @Get('ready')
  async ready(): Promise<ReadinessReport> {
    const [postgres, sqs] = await Promise.all([
      this.checkPostgres(),
      this.checkSqs(),
    ]);
    const checks = { postgres, sqs } as const;

    if (postgres === 'down' || sqs === 'down') {
      throw new ServiceUnavailableException({ status: 'degraded', checks });
    }

    return { status: 'ok', checks };
  }

  private async checkPostgres(): Promise<'up' | 'down'> {
    try {
      await this.em.getConnection().execute('SELECT 1');
      return 'up';
    } catch (error) {
      this.logger.warn({
        message: 'postgres readiness check failed',
        err: String(error),
      });
      return 'down';
    }
  }

  private async checkSqs(): Promise<'up' | 'down'> {
    try {
      await this.sqs.ping();
      return 'up';
    } catch (error) {
      this.logger.warn({
        message: 'sqs readiness check failed',
        err: String(error),
      });
      return 'down';
    }
  }
}
