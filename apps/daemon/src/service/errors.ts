// The two errors the service layer throws. They live here, not in domain.ts, so that modules domain.ts imports
// (pool → deadlines) can throw them without importing domain.ts back. domain.ts re-exports both.
export class NotFound extends Error {
  code = "NOT_FOUND";
}
export class DomainError extends Error {
  constructor(public code: string, message?: string) {
    super(message ?? code);
  }
}
