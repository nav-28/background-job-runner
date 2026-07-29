/** A user as it exists in the database and flows through the app. */
export interface User {
  id: string;
  email: string;
  name: string;
  /**
   * NULL means the account has no password and cannot log in interactively — a real
   * state for an API-key-only account, not a missing value waiting to be backfilled.
   * Never crosses the wire: `toUserResponse` does not carry it.
   */
  passwordHash: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields callers supply when creating a user. */
export interface CreateUserInput {
  email: string;
  name: string;
  passwordHash?: string | null;
}
