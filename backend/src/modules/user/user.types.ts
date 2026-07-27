/**
 * `UserRole` is both a value (`UserRole.admin`) and a type
 * (`'admin' | 'moderator' | 'guest'`). This const-object pattern is the
 * idiomatic TypeScript replacement for `enum`.
 */
export const UserRole = {
  admin: 'admin',
  moderator: 'moderator',
  guest: 'guest',
} as const;
export type UserRole = (typeof UserRole)[keyof typeof UserRole];

/** A user as it exists in the database and flows through the app. */
export interface User {
  id: string;
  email: string;
  country: string;
  postalCode: string;
  street: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

/** Fields callers supply when creating a user. */
export interface CreateUserInput {
  email: string;
  country: string;
  postalCode: string;
  street: string;
}

export interface UserFilters {
  country?: string;
  postalCode?: string;
  street?: string;
}
