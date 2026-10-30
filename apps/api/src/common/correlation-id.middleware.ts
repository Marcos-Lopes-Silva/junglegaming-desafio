import type { NextFunction, Request, Response } from 'express';
import { v7 as uuidv7 } from 'uuid';

export const CORRELATION_ID_HEADER = 'x-correlation-id';

/**
 * Reaproveita o `x-correlation-id` recebido ou gera um novo, devolve no header
 * da resposta e o expõe em `request.id` para os controllers e o filtro de erro.
 */
export function correlationId(
  request: Request & { id?: string },
  response: Response,
  next: NextFunction,
): void {
  const incoming = request.headers[CORRELATION_ID_HEADER];
  const id = (Array.isArray(incoming) ? incoming[0] : incoming) ?? uuidv7();

  request.id = id;
  response.setHeader(CORRELATION_ID_HEADER, id);
  next();
}
