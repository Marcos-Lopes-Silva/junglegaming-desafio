import { IsString, Matches } from 'class-validator';

/**
 * Validação de formato, para devolver 400 com os campos inválidos. A validação
 * completa continua em `Money.from`.
 */
export class MoneyDto {
  @IsString()
  @Matches(/^\d+(\.\d{1,2})?$/, {
    message:
      'amount must be a non-negative decimal string with at most 2 decimal places',
  })
  amount!: string;

  @IsString()
  @Matches(/^[A-Z]{3}$/, { message: 'currency must be an ISO-4217 code' })
  currency!: string;
}
