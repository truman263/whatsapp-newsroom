export type WordPressDraftErrorCode =
  | 'AUTHENTICATION_FAILURE'
  | 'CONTRACT_FAILURE'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'UNCERTAIN_OUTCOME'
  | 'WORDPRESS_UNAVAILABLE'
  | 'UNEXPECTED_RESPONSE';

export class WordPressDraftError extends Error {
  constructor(
    public readonly code: WordPressDraftErrorCode,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'WordPressDraftError';
  }
}
