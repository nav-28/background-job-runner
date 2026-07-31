import { randomUUID } from 'node:crypto';
import * as userRepository from '#src/modules/user/user.repository.ts';
import type { CreateUserInput, User } from '#src/modules/user/user.types.ts';

/**
 * Business logic for users. Plain async functions — call them from routes, from
 * other modules, or from tests. Nothing here touches HTTP or SQL directly.
 *
 * There are no user routes: the auth module owns the HTTP surface (signup, login,
 * /me) and calls in here. This file is the data layer behind it.
 */

/** Email is the login identifier, so it is compared case-insensitively everywhere. */
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export async function createUser(input: CreateUserInput): Promise<User> {
  const now = new Date();
  const user: User = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    email: normalizeEmail(input.email),
    name: input.name,
    // Explicit null rather than undefined: postgres.js rejects undefined values,
    // and "no password" is a state we store, not a field we omit.
    passwordHash: input.passwordHash ?? null,
  };

  // The repository translates a unique-email violation into a ConflictError (409).
  await userRepository.insert(user);
  return user;
}

export async function findUserByEmail(email: string): Promise<User | null> {
  return userRepository.findByEmail(normalizeEmail(email));
}

export async function findUserById(id: string): Promise<User | null> {
  return userRepository.findById(id);
}
