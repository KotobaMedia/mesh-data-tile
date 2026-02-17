import { TileErrorCode, TileErrorOptions } from './types.js';

export class TileFormatError extends Error {
  readonly code: TileErrorCode;

  constructor(options: TileErrorOptions) {
    const message =
      options.message ?? `mesh tile decode/encode failed with code ${options.code}`;
    super(message);
    this.name = 'TileFormatError';
    this.code = options.code;
    if (options.cause !== undefined) {
      this.cause = options.cause;
    }
  }
}

export function createError(code: TileErrorCode, message?: string, cause?: unknown): TileFormatError {
  return new TileFormatError({ code, message, cause });
}
