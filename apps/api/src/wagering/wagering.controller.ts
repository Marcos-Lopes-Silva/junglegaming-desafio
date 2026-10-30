import {
  BadRequestException,
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  ParseUUIDPipe,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import {
  GetWagerTransactionByExternalIdUseCase,
  GetWagerTransactionUseCase,
  SubmitWagerTransactionUseCase,
} from '@wagering/application';
import { WagerTransactionStatus } from '@wagering/domain';
import type { Request, Response } from 'express';
import { SubmitWagerTransactionDto } from './dto/submit-wager-transaction.dto.js';
import {
  type SubmitWagerTransactionResponse,
  type WagerTransactionResponse,
  presentSubmitResult,
  presentTransaction,
} from './presenters/wager-transaction.presenter.js';

/**
 * O status HTTP vem do status da transação. Rejeição não lança exceção: ela é
 * gravada e devolvida como resultado.
 */
const STATUS_CODE: Readonly<Record<string, HttpStatus>> = {
  [WagerTransactionStatus.Processed]: HttpStatus.OK,
  [WagerTransactionStatus.PendingReference]: HttpStatus.ACCEPTED,
  [WagerTransactionStatus.Rejected]: HttpStatus.UNPROCESSABLE_ENTITY,
  [WagerTransactionStatus.Failed]: HttpStatus.SERVICE_UNAVAILABLE,
  [WagerTransactionStatus.Pending]: HttpStatus.ACCEPTED,
};

@Controller()
export class WageringController {
  constructor(
    @Inject(SubmitWagerTransactionUseCase)
    private readonly submit: SubmitWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase)
    private readonly getTransaction: GetWagerTransactionUseCase,
    @Inject(GetWagerTransactionByExternalIdUseCase)
    private readonly getByExternalId: GetWagerTransactionByExternalIdUseCase,
  ) {}

  @Post('wagering/transactions')
  async submitTransaction(
    @Body() dto: SubmitWagerTransactionDto,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Req() request: Request & { id?: string },
    @Res({ passthrough: true }) response: Response,
  ): Promise<SubmitWagerTransactionResponse> {
    if (!idempotencyKey?.trim()) {
      throw new BadRequestException('Idempotency-Key header is required');
    }

    const result = await this.submit.execute({
      idempotencyKey: idempotencyKey.trim(),
      providerId: dto.providerId,
      externalTransactionId: dto.externalTransactionId,
      playerId: dto.playerId,
      walletId: dto.walletId,
      roundId: dto.roundId,
      gameId: dto.gameId,
      kind: dto.kind,
      money: { amount: dto.money.amount, currency: dto.money.currency },
      referenceExternalTransactionId: dto.referenceExternalTransactionId,
      correlationId: request.id ?? 'unknown',
    });

    response.status(STATUS_CODE[result.transaction.status] ?? HttpStatus.OK);

    return presentSubmitResult(result);
  }

  @Get('wagering/transactions/:transactionId')
  async findOne(
    @Param('transactionId', new ParseUUIDPipe()) transactionId: string,
  ): Promise<WagerTransactionResponse> {
    return presentTransaction(await this.getTransaction.execute(transactionId));
  }

  @Get('providers/:providerId/wagering/transactions/:externalTransactionId')
  async findByExternalId(
    @Param('providerId') providerId: string,
    @Param('externalTransactionId') externalTransactionId: string,
  ): Promise<WagerTransactionResponse> {
    return presentTransaction(
      await this.getByExternalId.execute(providerId, externalTransactionId),
    );
  }
}
