import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Logger,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  GetWalletUseCase,
  ListWalletLedgerUseCase,
  OpenWalletUseCase,
  ReconcileWalletUseCase,
} from '@wagering/application';
import type { Request } from 'express';
import { CreateWalletDto } from './dto/create-wallet.dto.js';
import { ListLedgerQuery } from './dto/list-ledger.query.js';
import { decodeCursor } from './presenters/cursor.codec.js';
import {
  type LedgerPageResponse,
  type ReconciliationResponse,
  type WalletResponse,
  presentLedgerPage,
  presentReconciliation,
  presentWallet,
} from './presenters/wallet.presenter.js';

@Controller()
export class WalletsController {
  private readonly logger = new Logger(WalletsController.name);

  constructor(
    @Inject(OpenWalletUseCase) private readonly openWallet: OpenWalletUseCase,
    @Inject(GetWalletUseCase) private readonly getWallet: GetWalletUseCase,
    @Inject(ListWalletLedgerUseCase)
    private readonly listLedger: ListWalletLedgerUseCase,
    @Inject(ReconcileWalletUseCase)
    private readonly reconcile: ReconcileWalletUseCase,
  ) {}

  @Post('wallets')
  @HttpCode(HttpStatus.CREATED)
  async create(
    @Body() dto: CreateWalletDto,
    @Req() request: Request & { id?: string },
  ): Promise<WalletResponse> {
    const wallet = await this.openWallet.execute({
      playerId: dto.playerId,
      initialBalance: {
        amount: dto.initialBalance.amount,
        currency: dto.initialBalance.currency,
      },
      correlationId: request.id ?? 'unknown',
    });

    return presentWallet(wallet);
  }

  @Get('wallets/:walletId')
  async findOne(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
  ): Promise<WalletResponse> {
    return presentWallet(await this.getWallet.execute(walletId));
  }

  @Get('wallets/:walletId/ledger')
  async ledger(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Query() query: ListLedgerQuery,
  ): Promise<LedgerPageResponse> {
    const page = await this.listLedger.execute({
      walletId,
      limit: query.limit,
      cursor: decodeCursor(query.cursor),
    });

    return presentLedgerPage(page);
  }

  /**
   * Divergência responde 200 com `consistent: false`. Com um status de erro, o
   * cliente não distinguiria "não consegui verificar" de "está divergente".
   */
  @Post('wallets/:walletId/reconciliation')
  @HttpCode(HttpStatus.OK)
  async reconciliation(
    @Param('walletId', new ParseUUIDPipe()) walletId: string,
    @Req() request: Request & { id?: string },
  ): Promise<ReconciliationResponse> {
    const result = await this.reconcile.execute(walletId);

    if (!result.consistent) {
      this.logger.error({
        message: 'wallet reconciliation divergence',
        walletId: result.walletId,
        correlationId: request.id,
        difference: result.difference.toString(),
        checkedEntries: result.checkedEntries,
      });
    }

    return presentReconciliation(result);
  }
}
