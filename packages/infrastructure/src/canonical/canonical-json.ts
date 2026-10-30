import { createHash } from 'node:crypto';
import type { PayloadHasherPort } from '@wagering/application';

/**
 * Chaves ordenadas, sem espaços, `undefined` descartado: a ordem com que o
 * provedor serializa o corpo não pode mudar o `payloadHash`.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Só campos de negócio entram. O header `Idempotency-Key` e metadados de
 * transporte ficam de fora, senão dois envios idênticos por canais diferentes
 * teriam hashes diferentes.
 */
export class Sha256PayloadHasher implements PayloadHasherPort {
  hash(payload: Record<string, unknown>): string {
    return createHash('sha256')
      .update(canonicalJson(payload), 'utf8')
      .digest('hex');
  }
}
