import { getRequestId } from '#src/plugins/request-context.ts';

/**
 * Base class for errors that map to an HTTP response.
 * The error handler (src/plugins/error-handler.ts) reads `statusCode` and `error`
 * off these and serializes them; anything else becomes a 500.
 */
export abstract class AppError extends Error {
  abstract readonly statusCode: number;
  abstract readonly error: string;

  readonly correlationId: string;
  override readonly cause?: Error;

  /** `cause` is logged but never sent to the client. */
  constructor(message: string, cause?: Error) {
    super(message);
    this.name = new.target.name;
    this.cause = cause;
    this.correlationId = getRequestId();
  }
}

/** 400 — the caller sent something invalid that route schemas didn't catch. */
export class BadRequestError extends AppError {
  readonly statusCode = 400;
  readonly error = 'Bad Request';
}

/** 404 */
export class NotFoundError extends AppError {
  readonly statusCode = 404;
  readonly error = 'Not Found';
}

/** 409 — e.g. a unique constraint was violated. */
export class ConflictError extends AppError {
  readonly statusCode = 409;
  readonly error = 'Conflict';
}

/** 500 — a query failed for a reason we don't map to anything friendlier. */
export class DatabaseError extends AppError {
  readonly statusCode = 500;
  readonly error = 'Internal Server Error';
}
