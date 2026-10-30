import { type EntityManager, MikroORM } from '@mikro-orm/postgresql';
import type { INestApplication } from '@nestjs/common';
import { SqsGateway } from '@wagering/infrastructure';
import { expect } from 'bun:test';
import { bootstrap } from '../../apps/api/src/main.js';

let suffix = 0;
export const uniqueSuffix = (): string =>
  `${Date.now().toString(36)}-${(suffix += 1)}`;

/** Mensagem do erro com que a promise rejeita, ou `undefined` se ela resolver. */
export const rejectionMessage = (
  promise: Promise<unknown>,
): Promise<string | undefined> =>
  promise.then(
    () => undefined,
    (error: unknown) =>
      error instanceof Error ? error.message : String(error),
  );

process.env.DATABASE_URL ??=
  'postgresql://wagering:wagering@localhost:55432/wagering_test';
process.env.AWS_SQS_ENDPOINT ??= 'http://localhost:44566';
process.env.AWS_REGION ??= 'us-east-1';
process.env.AWS_ACCESS_KEY_ID ??= 'test';
process.env.AWS_SECRET_ACCESS_KEY ??= 'test';
process.env.LOG_LEVEL ??= 'silent';
// 20s de long polling por `receive` só deixaria a suíte lenta.
process.env.SQS_WAIT_TIME_SECONDS ??= '2';

export interface MoneyBody {
  amount: string;
  currency: string;
}

export interface WalletBody {
  id: string;
  playerId: string;
  balance: MoneyBody;
  version: number;
}

export interface LedgerEntryBody {
  id: string;
  transactionId: string;
  direction: string;
  money: MoneyBody;
  balanceBefore: MoneyBody | null;
  balanceAfter: MoneyBody | null;
  createdAt: string;
}

export interface LedgerPageBody {
  entries: LedgerEntryBody[];
  nextCursor: string | null;
}

export interface ReconciliationBody {
  walletId: string;
  storedBalance: MoneyBody;
  calculatedBalance: MoneyBody;
  difference: MoneyBody;
  consistent: boolean;
  checkedEntries: number;
}

export interface ErrorBody {
  statusCode: number;
  failureCode: string;
  message: string;
  correlationId?: string;
}

export const json = <T>(response: Response): Promise<T> =>
  response.json() as Promise<T>;

export interface Harness {
  app: INestApplication;
  baseUrl: string;
  request: (path: string, init?: RequestInit) => Promise<Response>;
  fork: () => EntityManager;
  sql: <T = Record<string, unknown>>(
    query: string,
    params?: unknown[],
  ) => Promise<T[]>;
  reset: () => Promise<void>;
  assertLedgerInvariant: () => Promise<void>;
  close: () => Promise<void>;
  get: <T>(token: unknown) => T;
  gateway: SqsGateway;
  sendWagerMessage: (
    envelope: Record<string, unknown>,
    options?: { groupId?: string; deduplicationId?: string },
  ) => Promise<void>;
  drainQueue: (queue: string, attempts?: number) => Promise<string[]>;
}

export interface StartHarnessOptions {
  /**
   * Desligue ao subir instâncias adicionais que compartilham o mesmo banco:
   * a segunda truncaria o que a primeira criou.
   */
  reset?: boolean;
}

export async function startHarness(
  options: StartHarnessOptions = {},
): Promise<Harness> {
  const app = await bootstrap();
  await app.listen(0, '127.0.0.1');

  const baseUrl = await app.getUrl();
  const orm = app.get(MikroORM);
  const gateway = app.get(SqsGateway);

  // `allowGlobalContext: false` protege o código de produção de usar o EM
  // fora de um contexto; nos testes o fork explícito é esse contexto.
  const fork = (): EntityManager => orm.em.fork();

  const sql = async <T = Record<string, unknown>>(
    query: string,
    params: unknown[] = [],
  ): Promise<T[]> => fork().execute<T[]>(query, params);

  const harness: Harness = {
    app,
    baseUrl,
    request: (path, init) => fetch(`${baseUrl}${path}`, init),
    fork,
    sql,

    /**
     * TRUNCATE em vez de DELETE: o trigger de imutabilidade de
     * `ledger_entries` recusa DELETE por linha, e TRUNCATE não dispara
     * triggers de linha.
     */
    reset: async () => {
      await sql(`
        TRUNCATE ledger_entries, outbox_messages, inbox_messages, wager_transactions,
                 ledger_accounts, wallets RESTART IDENTITY CASCADE
      `);
    },

    /** Invariante final de todos os testes: wallet.balance == saldo do ledger. */
    assertLedgerInvariant: async () => {
      const rows = await sql<{
        wallet_id: string;
        stored: string;
        calculated: string;
      }>(`
        SELECT w.id AS wallet_id,
               w.balance_amount::text AS stored,
               COALESCE(SUM(
                 CASE WHEN e.direction = 'CREDIT' THEN e.amount ELSE -e.amount END
               ), 0)::numeric(20,2)::text AS calculated
          FROM wallets w
          JOIN ledger_accounts a ON a.wallet_id = w.id
          LEFT JOIN ledger_entries e ON e.account_id = a.id
         GROUP BY w.id, w.balance_amount
      `);

      for (const row of rows) {
        expect(`${row.wallet_id} stored=${row.stored}`).toBe(
          `${row.wallet_id} stored=${row.calculated}`,
        );
      }
    },

    close: async () => {
      await app.close();
    },

    get: <T>(token: unknown): T => app.get<T>(token as never),
    gateway,

    /**
     * Numa fila FIFO o SQS descarta, sem erro, mensagens com o mesmo dedup id
     * dentro de 5 minutos. Reusar o id entre testes faria a mensagem não
     * chegar.
     */
    sendWagerMessage: async (envelope, options = {}) => {
      const messageId =
        typeof envelope.messageId === 'string' ? envelope.messageId : 'default';
      await gateway.send({
        queue: gateway.options.transactionsQueue,
        body: JSON.stringify(envelope),
        groupId: options.groupId ?? messageId,
        deduplicationId:
          options.deduplicationId ?? `${messageId}-${uniqueSuffix()}`,
      });
    },

    drainQueue: async (queue, attempts = 3) => {
      const bodies: string[] = [];

      for (let attempt = 0; attempt < attempts; attempt += 1) {
        const messages = await gateway.receive(queue);
        if (messages.length === 0) {
          continue;
        }
        for (const message of messages) {
          if (message.Body) {
            bodies.push(message.Body);
          }
          if (message.ReceiptHandle) {
            await gateway.deleteMessage(queue, message.ReceiptHandle);
          }
        }
      }

      return bodies;
    },
  };

  // Parte de um banco limpo mesmo quando os containers já estavam de pé de uma
  // execução anterior: `bun run test:e2e` precisa ser repetível sem recriar
  // a infra toda vez.
  if (options.reset !== false) {
    await harness.reset();
  }

  return harness;
}

export const PLAYER_A = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1';
export const PLAYER_B = '0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2';
export const MISSING_WALLET = '0192f291-27dd-7d3f-8071-5f8685deef37';

export const createWallet = (
  harness: Harness,
  body: { playerId: string; initialBalance: MoneyBody },
): Promise<Response> =>
  harness.request('/wallets', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

export interface SubmitBody {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: MoneyBody;
  referenceExternalTransactionId?: string;
}

export interface SubmitResponseBody {
  transactionId: string;
  status: string;
  balance: MoneyBody;
  idempotentReplay: boolean;
  failureCode?: string;
}

export const PROVIDER = 'provider-a';

export function wagerBody(
  overrides: Partial<SubmitBody> & {
    walletId: string;
    playerId: string;
    kind: string;
  },
): SubmitBody {
  const externalTransactionId =
    overrides.externalTransactionId ??
    `tx-${Math.floor(performance.now() * 1000)}`;

  return {
    providerId: overrides.providerId ?? PROVIDER,
    externalTransactionId,
    playerId: overrides.playerId,
    walletId: overrides.walletId,
    roundId: overrides.roundId ?? 'round-987',
    gameId: overrides.gameId ?? 'fortune-chimp',
    kind: overrides.kind,
    money: overrides.money ?? { amount: '25.00', currency: 'BRL' },
    ...(overrides.referenceExternalTransactionId
      ? {
          referenceExternalTransactionId:
            overrides.referenceExternalTransactionId,
        }
      : {}),
  };
}

export const submitTransaction = (
  harness: Harness,
  body: SubmitBody,
  idempotencyKey?: string,
): Promise<Response> =>
  harness.request('/wagering/transactions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'idempotency-key':
        idempotencyKey ?? `${body.providerId}:${body.externalTransactionId}`,
    },
    body: JSON.stringify(body),
  });

export async function openWallet(
  harness: Harness,
  amount: string,
  options: { playerId?: string; currency?: string } = {},
): Promise<WalletBody> {
  const response = await createWallet(harness, {
    playerId: options.playerId ?? PLAYER_A,
    initialBalance: { amount, currency: options.currency ?? 'BRL' },
  });

  if (response.status !== 201) {
    throw new Error(
      `failed to open wallet: ${response.status} ${await response.text()}`,
    );
  }

  return json<WalletBody>(response);
}
