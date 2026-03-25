import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiTags,
  ApiOperation,
  ApiQuery,
  ApiOkResponse,
} from '@nestjs/swagger';
import { EventSinkRepository } from './event-sink.repository';
import { PaginatorInfo } from '../../common/dto/paginator-info.dto';

@ApiTags('EventSink')
@Controller('eventsink')
export class EventSinkController {
  constructor(private readonly repo: EventSinkRepository) {}

  @Get()
  @ApiOperation({
    summary: 'List events (paginated)',
    description:
      'Returns paginated events from the event sink. Filter by category, symbol, from, to, search. includePayload=true includes full payload in each event.',
  })
  @ApiQuery({
    name: 'page',
    required: false,
    description: 'Page number (default 1)',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Page size (default 50)',
  })
  @ApiQuery({ name: 'category', required: false })
  @ApiQuery({ name: 'symbol', required: false })
  @ApiQuery({ name: 'from', required: false, description: 'Timestamp from' })
  @ApiQuery({ name: 'to', required: false, description: 'Timestamp to' })
  @ApiQuery({ name: 'search', required: false })
  @ApiQuery({
    name: 'includePayload',
    required: false,
    description: 'Include full payload (true/false)',
  })
  @ApiOkResponse({
    description: '{ data: events[], paginator: PaginatorInfo }',
  })
  async getPaginated(
    @Query('page') page = 1,
    @Query('limit') limit = 50,
    @Query('category') category?: string,
    @Query('symbol') symbol?: string,
    @Query('from') from?: number,
    @Query('to') to?: number,
    @Query('search') search?: string,
    @Query('includePayload') includePayload?: string,
  ) {
    page = Number(page);
    limit = Number(limit);
    const withPayload =
      String(includePayload ?? '')
        .trim()
        .toLowerCase() === 'true';

    const { data, total } = await this.repo.getPaginated({
      page,
      limit,
      category,
      symbol,
      from: from ? Number(from) : undefined,
      to: to ? Number(to) : undefined,
      search,
      includePayload: withPayload,
    });

    const paginator: PaginatorInfo = {
      count: data.length,
      current_page: page,
      per_page: limit,
      total,
      last_page: Math.ceil(total / limit),

      firstItem: data.length ? (page - 1) * limit + 1 : null,
      lastItem: data.length ? (page - 1) * limit + data.length : null,

      first_page_url: `/api/eventsink?page=1`,
      last_page_url: `/api/eventsink?page=${Math.ceil(total / limit)}`,
      next_page_url:
        page * limit < total ? `/api/eventsink?page=${page + 1}` : null,
      prev_page_url: page > 1 ? `/api/eventsink?page=${page - 1}` : null,

      path: '/api/eventsink',
      from: from ?? null,
      to: to ?? null,
    };

    return { data, paginator };
  }
}
