export class IntegrationError extends Error {
  readonly code: string;
  readonly httpStatus: number | undefined;
  readonly outcomeUnknown: boolean;
  readonly safeToRetry: boolean;
  readonly retryAfterSeconds: number | undefined;
  constructor(code: string, message: string, options: {
    httpStatus?: number;
    outcomeUnknown?: boolean;
    safeToRetry?: boolean;
    retryAfterSeconds?: number;
  } = {}) {
    super(message);
    this.name = 'IntegrationError';
    this.code = code;
    this.httpStatus = options.httpStatus;
    this.outcomeUnknown = options.outcomeUnknown ?? false;
    this.safeToRetry = options.safeToRetry ?? false;
    this.retryAfterSeconds = options.retryAfterSeconds;
  }
}
export function invariant(value: unknown, code: string, message: string): asserts value {
  if (!value) throw new IntegrationError(code, message);
}
export function unknownWriteOutcome(): IntegrationError {
  return new IntegrationError('MUTATION_OUTCOME_UNKNOWN',
    'Assinafy may have accepted the request. Check the workspace before replaying this step. Automatic replay can duplicate a document or invitation.',
    { outcomeUnknown: true });
}
