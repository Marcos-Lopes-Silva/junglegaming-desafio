import {
  InvalidLedgerCursorError,
  type LedgerCursor,
} from '@wagering/application';

/**
 * Base64url de `(createdAt, id)`, a chave de ordenação do índice. Opaco para o
 * cliente não depender do formato.
 */
export function encodeCursor(cursor: LedgerCursor): string {
  const payload = JSON.stringify({
    c: cursor.createdAt.toISOString(),
    i: cursor.id,
  });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

export function decodeCursor(
  raw: string | undefined,
): LedgerCursor | undefined {
  if (!raw) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(
      Buffer.from(raw, 'base64url').toString('utf8'),
    ) as {
      c?: unknown;
      i?: unknown;
    };

    if (typeof parsed.c !== 'string' || typeof parsed.i !== 'string') {
      throw new InvalidLedgerCursorError();
    }

    const createdAt = new Date(parsed.c);
    if (Number.isNaN(createdAt.getTime())) {
      throw new InvalidLedgerCursorError();
    }

    return { createdAt, id: parsed.i };
  } catch {
    throw new InvalidLedgerCursorError();
  }
}
