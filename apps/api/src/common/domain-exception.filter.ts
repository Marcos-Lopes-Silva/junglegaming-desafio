import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ConnectionException } from '@mikro-orm/postgresql';
import { DomainError } from '@wagering/domain';
import type { Request, Response } from 'express';

/**
 * Converte erros de domínio em respostas HTTP. Fica num lugar só para que
 * todos os controllers usem os mesmos status.
 */
const STATUS_BY_CODE: Readonly<Record<string, HttpStatus>> = {
  INVALID_MONEY_AMOUNT: HttpStatus.BAD_REQUEST,
  INVALID_CURRENCY: HttpStatus.BAD_REQUEST,
  INVALID_LEDGER_CURSOR: HttpStatus.BAD_REQUEST,

  WALLET_NOT_FOUND: HttpStatus.NOT_FOUND,
  TRANSACTION_NOT_FOUND: HttpStatus.NOT_FOUND,

  WALLET_ALREADY_EXISTS: HttpStatus.CONFLICT,
  IDEMPOTENCY_PAYLOAD_MISMATCH: HttpStatus.CONFLICT,

  CURRENCY_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  INSUFFICIENT_FUNDS: HttpStatus.UNPROCESSABLE_ENTITY,
  INSUFFICIENT_FUNDS_FOR_REVERSAL: HttpStatus.UNPROCESSABLE_ENTITY,
  INTERNAL_KIND_NOT_ALLOWED: HttpStatus.UNPROCESSABLE_ENTITY,
  REFERENCE_REQUIRED: HttpStatus.UNPROCESSABLE_ENTITY,
  REFERENCE_NOT_FOUND: HttpStatus.UNPROCESSABLE_ENTITY,
  REFERENCE_NOT_PROCESSED: HttpStatus.UNPROCESSABLE_ENTITY,
  REFERENCE_KIND_NOT_REVERSIBLE: HttpStatus.UNPROCESSABLE_ENTITY,
  REFERENCE_ALREADY_REVERSED: HttpStatus.UNPROCESSABLE_ENTITY,
  REFERENCE_AMOUNT_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  REFERENCE_SCOPE_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  WALLET_PLAYER_MISMATCH: HttpStatus.UNPROCESSABLE_ENTITY,
  UNBALANCED_LEDGER_ENTRY: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_LEDGER_ENTRY_AMOUNT: HttpStatus.UNPROCESSABLE_ENTITY,
};

export interface ErrorBody {
  statusCode: number;
  failureCode: string;
  message: string;
  correlationId: string | undefined;
}

const TRANSIENT_CODES = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EPIPE',
  '57P01', // admin_shutdown
  '57P03', // cannot_connect_now
  '53300', // too_many_connections
]);

function isTransientInfraError(error: unknown): boolean {
  if (error instanceof ConnectionException) return true;
  const code = (error as { code?: string })?.code;
  if (code && (TRANSIENT_CODES.has(code) || code.startsWith('08'))) return true;
  return error instanceof Error && /timeout acquiring a connection|connection terminated/i.test(error.message);
}

@Catch()
export class DomainExceptionFilter implements ExceptionFilter {
  private readonly logger = new Logger(DomainExceptionFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const response = http.getResponse<Response>();
    const request = http.getRequest<Request & { id?: string }>();
    const correlationId = request.id;

    const { status, failureCode, message } = this.classify(exception);

    if (status >= HttpStatus.INTERNAL_SERVER_ERROR) {
      this.logger.error({
        message: 'unhandled error',
        failureCode,
        correlationId,
        err: exception instanceof Error ? exception.stack : String(exception),
      });
    }

    const body: ErrorBody = {
      statusCode: status,
      failureCode,
      message,
      correlationId,
    };
    response.status(status).json(body);
  }

  private classify(exception: unknown): {
    status: HttpStatus;
    failureCode: string;
    message: string;
  } {
    if (exception instanceof DomainError) {
      return {
        status:
          STATUS_BY_CODE[exception.code] ?? HttpStatus.UNPROCESSABLE_ENTITY,
        failureCode: exception.code,
        message: exception.message,
      };
    }

    if (exception instanceof HttpException) {
      const status: HttpStatus = exception.getStatus();
      const payload = exception.getResponse();
      const message =
        typeof payload === 'string'
          ? payload
          : (() => {
              const detail = (payload as { message?: string | string[] })
                .message;
              return Array.isArray(detail)
                ? detail.join('; ')
                : (detail ?? exception.message);
            })();

      return {
        status,
        failureCode:
          status === HttpStatus.BAD_REQUEST
            ? 'VALIDATION_FAILED'
            : 'HTTP_ERROR',
        message,
      };
    }

    if (isTransientInfraError(exception)) {
      return {
        status: HttpStatus.SERVICE_UNAVAILABLE,
        failureCode: 'TRANSIENT_FAILURE',
        message: 'service temporarily unavailable, retry later',
      };
    }

    return {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      failureCode: 'INTERNAL_ERROR',
      message: 'internal server error',
    };
  }
}
