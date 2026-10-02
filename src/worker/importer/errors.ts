export type ImportErrorKind =
  | "config" // 401/403: bad or revoked key, needs the owner
  | "not_found" // 404: account gone or reconnected under a new id
  | "rate_limited"
  | "server"
  | "network"
  | "timeout"
  | "invalid_response"
  | "precision" // amount has more decimals than its currency allows
  | "budget"; // statement or subrequest budget exceeded

/**
 * The only error type the importer stores or logs. The message is our own fixed text,
 * never provider text, so it is safe to persist.
 */
export class ImportError extends Error {
  constructor(
    readonly kind: ImportErrorKind,
    readonly httpStatus: number | null = null,
  ) {
    super(kind);
    this.name = "ImportError";
  }
}
