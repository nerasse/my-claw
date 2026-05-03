export class AuthGuard {
  constructor(private whitelist: string[]) {}

  isAuthorized(userId: string): boolean {
    return this.whitelist.includes(userId);
  }
}
