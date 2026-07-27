import { randomUUID } from 'node:crypto';
import { NotFoundError } from '#src/lib/errors.ts';
import { type Paginated, paginationParams } from '#src/lib/http.ts';
import * as userRepository from '#src/modules/user/user.repository.ts';
import type { FindUsersQuery } from '#src/modules/user/user.schema.ts';
import { type CreateUserInput, type User, UserRole } from '#src/modules/user/user.types.ts';

/**
 * Business logic for users. Plain async functions — call them from routes, from
 * other modules, or from tests. Nothing here touches HTTP or SQL directly.
 */

export async function createUser(input: CreateUserInput): Promise<string> {
  const now = new Date();
  const user: User = {
    id: randomUUID(),
    createdAt: now,
    updatedAt: now,
    ...input,
    role: UserRole.guest,
  };

  // The repository translates a unique-email violation into a ConflictError (409).
  await userRepository.insert(user);
  return user.id;
}

export async function findUsers(query: FindUsersQuery): Promise<Paginated<User>> {
  const { limit, page, offset } = paginationParams(query);
  return userRepository.findAllPaginated(
    { limit, page, offset },
    { country: query.country, postalCode: query.postalCode, street: query.street },
  );
}

export async function deleteUser(id: string): Promise<void> {
  const deleted = await userRepository.deleteById(id);
  if (!deleted) {
    throw new NotFoundError(`User with id ${id} not found`);
  }
}
