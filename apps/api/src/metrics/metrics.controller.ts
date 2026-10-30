import { Controller, Get, Header, Inject } from '@nestjs/common';
import { METRICS } from '@wagering/application';
import type { MetricsRegistry } from '@wagering/infrastructure';
import { Public } from '../common/public.decorator.js';

@Controller('metrics')
export class MetricsController {
  constructor(@Inject(METRICS) private readonly metrics: MetricsRegistry) {}

  @Public()
  @Get()
  @Header('content-type', 'text/plain; version=0.0.4; charset=utf-8')
  async scrape(): Promise<string> {
    return this.metrics.metrics();
  }
}
