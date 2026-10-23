// Шапка «Итогов» (спека stats-page, multi-company-person п.4): название компании и пояс суток
// показываются, только когда у смотрящего две и больше действующих компаний — как метки в боте.
// При одной компании путать нечего, и лишняя строка только мешает. Без JSX — проверяется тестом.

export interface HeadingSpace { kind: 'company' | 'personal'; invited?: boolean }

export function showStatsHeading(spaces: HeadingSpace[]): boolean {
  return spaces.filter((s) => s.kind === 'company' && !s.invited).length > 1;
}
