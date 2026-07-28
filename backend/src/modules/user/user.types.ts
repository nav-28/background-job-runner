/** A user as it exists in the database and flows through the app. */
export interface User {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields callers supply when creating a user. */
export interface CreateUserInput {
  email: string;
  name: string;
}

export interface UserFilters {
  email?: string;
}
