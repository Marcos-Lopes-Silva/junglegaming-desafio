import { Type } from 'class-transformer';
import { IsDefined, IsUUID, ValidateNested } from 'class-validator';
import { MoneyDto } from '../../common/money.dto.js';

export { MoneyDto };

export class CreateWalletDto {
  @IsUUID()
  playerId!: string;

  @IsDefined()
  @ValidateNested()
  @Type(() => MoneyDto)
  initialBalance!: MoneyDto;
}
