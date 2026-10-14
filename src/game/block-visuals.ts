export function getVisualBlockCount(amount: number): number {
  const safeAmount = Math.max(1, Math.round(amount));
  if (safeAmount <= 10) return safeAmount;
  if (safeAmount <= 30) return Math.ceil(safeAmount / 2);
  if (safeAmount <= 100) return 18;
  if (safeAmount <= 500) return 22;
  return 26;
}
