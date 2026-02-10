import { IsOptional, IsString, IsNumberString } from 'class-validator';

export class EventSinkQueryDto {
    @IsNumberString()
    page!: string;

    @IsNumberString()
    limit!: string;

    @IsOptional()
    @IsString()
    category?: string;

    @IsOptional()
    @IsString()
    symbol?: string;

    @IsOptional()
    @IsString()
    search?: string;

    @IsOptional()
    @IsString()
    from?: string;

    @IsOptional()
    @IsString()
    to?: string;
}
