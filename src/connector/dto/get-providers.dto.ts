import { PaginationArgs } from '../../common/dto/pagination-args.dto';

import { Paginator } from '../../common/dto/paginator.dto';
import { ConnectorType, ProviderInfo } from '@barfinex/types';

export class ProviderPaginator extends Paginator<ProviderInfo> {
    data: ProviderInfo[];
}

export class GetProvidersDto extends PaginationArgs {
    orderBy?: string;
    search?: string;
    sortedBy?: string;
    is_active?: boolean;
}
