export type WordPressMediaErrorCode =
  | 'AUTHENTICATION_FAILURE'
  | 'CONTRACT_FAILURE'
  | 'CONFLICT'
  | 'NOT_FOUND'
  | 'IN_PROGRESS'
  | 'PAYLOAD_REJECTED'
  | 'UNCERTAIN_OUTCOME'
  | 'WORDPRESS_UNAVAILABLE'
  | 'UNEXPECTED_RESPONSE';

export class WordPressMediaError extends Error {
  constructor(
    public readonly code: WordPressMediaErrorCode,
    message: string,
    public readonly httpStatus?: number,
  ) {
    super(message);
    this.name = 'WordPressMediaError';
  }
}