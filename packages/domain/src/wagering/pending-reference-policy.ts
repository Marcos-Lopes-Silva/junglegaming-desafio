/**
 * Política de reprocessamento de `PENDING_REFERENCE`.
 *
 * Os limites escolhidos:
 *
 * - backoff exponencial de base 2s, fator 2, teto de 60s;
 * - 8 tentativas, o que cobre ~4 minutos de atraso de entrega;
 * - TTL absoluto de 10 minutos a partir da criação.
 *
 * O backoff cobre o caso comum, de entrega fora de ordem por alguns segundos.
 * O TTL evita que uma transação cuja referência nunca chega fique pendente para
 * sempre. Vale o limite que for atingido primeiro.
 */
export const PENDING_REFERENCE_MAX_ATTEMPTS = 8;
export const PENDING_REFERENCE_TTL_MS = 10 * 60 * 1000;

const BASE_DELAY_MS = 2_000;
const FACTOR = 2;
const CAP_MS = 60_000;

export function nextPendingReferenceAttemptAt(
  attempts: number,
  now: Date,
): Date {
  const delay = Math.min(
    BASE_DELAY_MS * FACTOR ** Math.max(attempts - 1, 0),
    CAP_MS,
  );
  return new Date(now.getTime() + delay);
}

export function isPendingReferenceExhausted(
  attempts: number,
  createdAt: Date,
  now: Date,
): boolean {
  return (
    attempts >= PENDING_REFERENCE_MAX_ATTEMPTS ||
    now.getTime() - createdAt.getTime() >= PENDING_REFERENCE_TTL_MS
  );
}
