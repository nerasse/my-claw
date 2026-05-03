export class ActionBlacklist {
  constructor(private blacklistedActions: string[]) {}

  requiresConfirmation(action: string): boolean {
    return this.blacklistedActions.includes(action);
  }

  add(action: string): void {
    if (!this.blacklistedActions.includes(action)) {
      this.blacklistedActions.push(action);
    }
  }

  remove(action: string): void {
    this.blacklistedActions = this.blacklistedActions.filter((a) => a !== action);
  }
}
