/**
 * Structured engine errors with categorisation.
 *
 * Allows the fallback chain and retry logic to make intelligent decisions
 * instead of treating every failure the same way.
 */

export type ErrorCategory =
  | 'unavailable'       // CLI missing, binary not found
  | 'auth_expired'      // Invalid/expired credentials
  | 'rate_limited'      // 429 or equivalent
  | 'timeout'           // Request exceeded time limit
  | 'context_overflow'  // Token/context limit exceeded
  | 'transient'         // Temporary server error (5xx)
  | 'cancelled'         // User or system cancelled the operation
  | 'unknown';          // Unclassified

export class EngineError extends Error {
  readonly category: ErrorCategory;
  readonly retriable: boolean;
  readonly retryAfterMs: number | undefined;
  readonly httpStatus: number | undefined;

  constructor(
    message: string,
    category: ErrorCategory,
    options?: {
      retriable?: boolean;
      retryAfterMs?: number;
      httpStatus?: number;
      cause?: unknown;
    },
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = 'EngineError';
    this.category = category;
    this.retriable = options?.retriable ?? isRetriableByDefault(category);
    this.retryAfterMs = options?.retryAfterMs;
    this.httpStatus = options?.httpStatus;
  }
}

function isRetriableByDefault(category: ErrorCategory): boolean {
  switch (category) {
    case 'rate_limited':
    case 'transient':
    case 'timeout':
      return true;
    case 'unavailable':
    case 'auth_expired':
    case 'context_overflow':
    case 'cancelled':
    case 'unknown':
      return false;
  }
}

/**
 * Classify an HTTP status code into an error category.
 */
export function categorizeHttpStatus(status: number): ErrorCategory {
  if (status === 401 || status === 403) return 'auth_expired';
  if (status === 429) return 'rate_limited';
  if (status === 413) return 'context_overflow';
  if (status >= 500 && status < 600) return 'transient';
  return 'unknown';
}

/**
 * Extract Retry-After header value in milliseconds.
 */
export function parseRetryAfterMs(headerValue: string | null | undefined): number | undefined {
  if (!headerValue) return undefined;
  const seconds = Number(headerValue);
  if (Number.isFinite(seconds) && seconds > 0) {
    return Math.ceil(seconds * 1000);
  }
  return undefined;
}

/**
 * Wrap any error as an EngineError, preserving category if already classified.
 */
export function toEngineError(error: unknown, fallbackCategory: ErrorCategory = 'unknown'): EngineError {
  if (error instanceof EngineError) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new EngineError(message, fallbackCategory, { cause: error });
}
