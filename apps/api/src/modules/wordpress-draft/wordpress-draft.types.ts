export interface CreateWordPressDraftInput {
  wordpressDraftKey: string;
  headline: string;
  body: string;
  excerpt?: string;
  wordpressCategoryIds: number[];
}

export interface WordPressDraftReference {
  wordpressDraftKey: string;
  wordpressPostId: number;
  status: 'draft';
}

export interface CreateWordPressDraftResult extends WordPressDraftReference {
  outcome: 'CREATED' | 'REPLAYED' | 'RECOVERED';
}

export interface WordPressDraftClientOptions {
  baseUrl: string;
  keyId: string;
  secret: string;
  requestTimeoutMs: number;
  reconciliationAttempts: number;
  reconciliationDelayMs: number;
}
