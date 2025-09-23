import { PaginationArgs } from '../../common/dto/pagination-args.dto';

export class GetAssetsDto extends PaginationArgs {
  orderBy?: string;
  sortedBy?: string;
  provider_id?: number;
}
