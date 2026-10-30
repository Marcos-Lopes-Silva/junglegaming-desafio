import { WagerTransactionKind } from '@wagering/domain';
import { Type } from 'class-transformer';
import {
  IsDefined,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { MoneyDto } from '../../common/money.dto.js';

export class SubmitWagerTransactionDto {
  @IsString()
  @MinLength(1)
  @MaxLength(64)
  providerId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  externalTransactionId!: string;

  @IsUUID()
  playerId!: string;

  @IsUUID()
  walletId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  roundId!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(128)
  gameId!: string;

  /**
   * Aceita `OPENING` aqui; quem recusa é o domínio, com 422
   * `INTERNAL_KIND_NOT_ALLOWED`.
   */
  @IsEnum(WagerTransactionKind)
  kind!: WagerTransactionKind;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  money!: MoneyDto;

  /** Obrigatório para `REFUND` e `ROLLBACK`; opcional nos demais kinds. */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(128)
  referenceExternalTransactionId?: string;
}
