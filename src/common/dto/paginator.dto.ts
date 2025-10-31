export class Paginator<T> {
  data!: T[];

  count!: number;
  current_page!: number;

  firstItem!: number | null;
  lastItem!: number | null;
  last_page!: number;

  per_page!: number;
  total!: number;

  first_page_url!: string;
  last_page_url!: string;
  next_page_url!: string | null;
  prev_page_url!: string | null;

  from!: number | null;
  to!: number | null;
  path!: string;
}
