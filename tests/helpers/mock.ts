// Simple mock helper compatible with node:test (no mock.fn available in some runners)
export function createMock<T extends (...args: any[]) => any>(impl: T): T & { calls: Array<{ arguments: any[] }> } {
  const calls: Array<{ arguments: any[] }> = [];
  const fn = ((...args: any[]) => {
    calls.push({ arguments: args });
    return impl(...args);
  }) as T & { calls: Array<{ arguments: any[] }> };
  fn.calls = calls;
  return fn;
}
