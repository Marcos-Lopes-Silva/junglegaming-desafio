import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type Harness, startHarness } from './harness.js';

let h: Harness;

beforeAll(async () => {
  h = await startHarness();
});

afterAll(async () => {
  await h.close();
});

describe('health checks', () => {
  it('liveness responde sem tocar em dependências', async () => {
    const response = await h.request('/health/live');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok' });
  });

  it('readiness verifica PostgreSQL e SQS', async () => {
    const response = await h.request('/health/ready');

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      status: 'ok',
      checks: { postgres: 'up', sqs: 'up' },
    });
  });

  it('health não exige autenticação', async () => {
    for (const path of ['/health/live', '/health/ready']) {
      expect((await h.request(path)).status).toBe(200);
    }
  });
});

describe('observabilidade', () => {
  it('expõe métricas em formato Prometheus', async () => {
    const response = await h.request('/metrics');
    const body = await response.text();

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toContain('text/plain');
    expect(body).toContain('wallets_opened_total');
    expect(body).toContain('reconciliations_total');
  });

  it('devolve o correlationId no header da resposta', async () => {
    const response = await h.request('/health/live');

    expect(response.headers.get('x-correlation-id')).toBeTruthy();
  });

  it('propaga o correlationId enviado pelo cliente', async () => {
    const response = await h.request('/health/live', {
      headers: { 'x-correlation-id': 'corr-from-client' },
    });

    expect(response.headers.get('x-correlation-id')).toBe('corr-from-client');
  });

  it('erros carregam o correlationId no corpo', async () => {
    const response = await h.request(
      '/wallets/0192f291-27dd-7d3f-8071-5f8685deef37',
      {
        headers: { 'x-correlation-id': 'corr-error' },
      },
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      failureCode: 'WALLET_NOT_FOUND',
      correlationId: 'corr-error',
    });
  });
});
