/** An API key row. `keyHash` never leaves the repository/service boundary. */
export interface ApiKey {
  id: string;
  userId: string;
  name: string;
  keyHash: string;
  prefix: string;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
  createdAt: Date;
}

/** What a verified API key resolves to. */
export interface ApiKeyIdentity {
  keyId: string;
  userId: string;
}

/** A freshly minted key. `plaintext` exists only in this object, exactly once. */
export interface CreatedApiKey {
  apiKey: ApiKey;
  plaintext: string;
}
