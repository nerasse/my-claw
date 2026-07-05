export class IterationBudget {
  private used = 0;

  constructor(private maxTotal: number) {}

  consume(): boolean {
    if (this.used >= this.maxTotal) return false;
    this.used += 1;
    return true;
  }

  /** Extend the budget, e.g. when a user message is injected mid-run (a real new turn). */
  grant(n: number): void {
    if (n > 0) this.maxTotal += n;
  }

  get remaining(): number {
    return Math.max(0, this.maxTotal - this.used);
  }

  get total(): number {
    return this.maxTotal;
  }
}
