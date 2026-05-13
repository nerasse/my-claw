export class IterationBudget {
  private used = 0;

  constructor(private readonly maxTotal: number) {}

  consume(): boolean {
    if (this.used >= this.maxTotal) return false;
    this.used += 1;
    return true;
  }

  refund(): void {
    if (this.used > 0) this.used -= 1;
  }

  get remaining(): number {
    return Math.max(0, this.maxTotal - this.used);
  }

  get total(): number {
    return this.maxTotal;
  }
}
