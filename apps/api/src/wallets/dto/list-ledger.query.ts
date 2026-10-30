import { LEDGER_PAGE_MAX_LIMIT } from '@wagering/application';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, Max, Min } from 'class-validator';

export class ListLedgerQuery {
  @IsOptional()
  @IsString()
  cursor?: string;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(LEDGER_PAGE_MAX_LIMIT)
  limit?: number;
}
