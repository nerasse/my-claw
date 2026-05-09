export function formatError(context: string, rawError: unknown): string {
  const msg = rawError instanceof Error ? rawError.message : String(rawError);

  if (msg.includes("ENOENT") || msg.includes("no such file")) {
    return `${context}: file or directory not found. Check the path exists.`;
  }
  if (msg.includes("EACCES") || msg.includes("permission denied")) {
    return `${context}: permission denied. Check file permissions or use a different path.`;
  }
  if (msg.includes("ENOTDIR") || msg.includes("not a directory")) {
    return `${context}: path is a file, not a directory. Use a directory path.`;
  }
  if (msg.includes("EISDIR") || msg.includes("is a directory")) {
    return `${context}: path is a directory, not a file. Use a file path.`;
  }
  if (msg.includes("EEXIST")) {
    return `${context}: already exists.`;
  }
  if (msg.includes("ENOTEMPTY")) {
    return `${context}: directory not empty.`;
  }
  if (msg.includes("ETIMEDOUT") || msg.includes("timeout")) {
    return `${context}: operation timed out.`;
  }
  if (msg.includes("ECONNREFUSED")) {
    return `${context}: connection refused. Check the server is running.`;
  }
  if (msg.includes("ECONNRESET")) {
    return `${context}: connection reset. Retry or check network.`;
  }
  if (msg.includes("ENOTFOUND")) {
    return `${context}: host not found. Check the URL or hostname.`;
  }

  return `${context}: ${msg}`;
}
