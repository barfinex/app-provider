import { APP_URL } from '../constants';
import { PaginatorInfo } from '../dto/paginator-info.dto';

export function paginate(
  totalItems: number,
  current_page = 1,
  pageSize = 10,
  count = 0,
  url = '',
): PaginatorInfo {
  const totalPages = Math.ceil(totalItems / pageSize);

  // ensure current page isn't out of range
  if (current_page < 1) current_page = 1;
  else if (current_page > totalPages) current_page = totalPages;

  // calculate start and end item indexes
  const from = totalItems === 0 ? null : (current_page - 1) * pageSize + 1;
  const to =
    totalItems === 0
      ? null
      : Math.min(current_page * pageSize, totalItems);

  const first_page_url = `${APP_URL}${url}&page=1`;
  const last_page_url = `${APP_URL}${url}&page=${totalPages}`;
  const next_page_url =
    current_page < totalPages
      ? `${APP_URL}${url}&page=${current_page + 1}`
      : null;
  const prev_page_url =
    current_page > 1 ? `${APP_URL}${url}&page=${current_page - 1}` : null;

  return {
    total: totalItems,
    current_page,
    count,
    last_page: totalPages,
    firstItem: from,
    lastItem: to,
    per_page: pageSize,
    first_page_url,
    last_page_url,
    next_page_url,
    prev_page_url,
    path: `${APP_URL}${url}`,
    from,
    to,
  };
}
