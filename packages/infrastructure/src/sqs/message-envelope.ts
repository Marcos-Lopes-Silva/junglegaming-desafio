import type { WagerTransactionRequestedMessage } from '@wagering/application';
import { DomainError, WagerTransactionKind } from '@wagering/domain';

/**
 * Herda de `DomainError` para ser classificada como permanente: nenhuma
 * retentativa conserta um envelope malformado, então ele vai direto para a DLQ.
 */
export class MalformedMessageError extends DomainError {
  readonly code = 'MALFORMED_MESSAGE';

  constructor(reason: string) {
    super(`malformed message: ${reason}`);
  }
}

export const WAGER_TRANSACTION_REQUESTED = 'WagerTransactionRequested';

const KINDS = new Set<string>(Object.values(WagerTransactionKind));

const requireString = (value: unknown, field: string): string => {
  if (typeof value !== 'string' || value.length === 0) {
    throw new MalformedMessageError(`${field} must be a non-empty string`);
  }
  return value;
};

/**
 * Validação só estrutural: regra de negócio é do caso de uso, e o resultado
 * dela é uma rejeição auditável, não um descarte de mensagem.
 */
export function parseWagerTransactionMessage(
  body: string,
): WagerTransactionRequestedMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new MalformedMessageError('body is not valid JSON');
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new MalformedMessageError('body is not an object');
  }

  const envelope = parsed as Record<string, unknown>;
  const type = requireString(envelope.type, 'type');
  if (type !== WAGER_TRANSACTION_REQUESTED) {
    throw new MalformedMessageError(`unsupported type "${type}"`);
  }

  if (typeof envelope.data !== 'object' || envelope.data === null) {
    throw new MalformedMessageError('data is missing');
  }
  const data = envelope.data as Record<string, unknown>;

  const kind = requireString(data.kind, 'data.kind');
  if (!KINDS.has(kind)) {
    throw new MalformedMessageError(`unknown kind "${kind}"`);
  }

  if (typeof data.money !== 'object' || data.money === null) {
    throw new MalformedMessageError('data.money is missing');
  }
  const money = data.money as Record<string, unknown>;

  const reference = data.referenceExternalTransactionId;
  if (reference !== undefined && typeof reference !== 'string') {
    throw new MalformedMessageError(
      'data.referenceExternalTransactionId must be a string',
    );
  }

  return {
    messageId: requireString(envelope.messageId, 'messageId'),
    type,
    occurredAt: requireString(envelope.occurredAt, 'occurredAt'),
    data: {
      providerId: requireString(data.providerId, 'data.providerId'),
      externalTransactionId: requireString(
        data.externalTransactionId,
        'data.externalTransactionId',
      ),
      idempotencyKey: requireString(data.idempotencyKey, 'data.idempotencyKey'),
      playerId: requireString(data.playerId, 'data.playerId'),
      walletId: requireString(data.walletId, 'data.walletId'),
      roundId: requireString(data.roundId, 'data.roundId'),
      gameId: requireString(data.gameId, 'data.gameId'),
      kind: kind as WagerTransactionKind,
      money: {
        amount: requireString(money.amount, 'data.money.amount'),
        currency: requireString(money.currency, 'data.money.currency'),
      },
      ...(reference ? { referenceExternalTransactionId: reference } : {}),
    },
  };
}

export type DeliveryDecision = 'dlq' | 'retry';

/**
 * Rejeições de negócio não lançam: voltam como resultado persistido e a
 * mensagem recebe `ack`. Então todo `DomainError` aqui é problema permanente do
 * payload, e o resto é infraestrutura, isto é, transitório.
 */
export function classifyDeliveryFailure(error: unknown): DeliveryDecision {
  return error instanceof DomainError ? 'dlq' : 'retry';
}
