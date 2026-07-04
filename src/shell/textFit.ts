export function fit(value: string, width: number): string {
  const max = Math.max(1, width);
  if (value.length <= max) return value;
  if (max <= 1) return '…';
  return value.slice(0, max - 1) + '…';
}
