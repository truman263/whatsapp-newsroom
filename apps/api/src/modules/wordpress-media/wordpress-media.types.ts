export interface CreateMediaInput {
  mediaKey: string;
  filename: string;
  mimeType: string;
  body: Buffer;
}

export interface MediaReference {
  mediaKey: string;
  attachmentId: number;
  status: 'attachment';
}

export interface MediaReserved {
  mediaKey: string;
  attachmentId: null;
  status: 'reserved';
}

export interface CreateMediaResult {
  mediaKey: string;
  attachmentId: number;
  status: 'attachment';
  outcome: 'CREATED' | 'REPLAYED' | 'RECOVERED';
}

export interface WordPressMediaClientOptions {
  baseUrl: string;
  keyId: string;
  secret: string;
  requestTimeoutMs: number;
  reconciliationAttempts: number;
  reconciliationDelayMs: number;
  maxBytes: number;
}
