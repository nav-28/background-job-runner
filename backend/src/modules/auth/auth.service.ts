import { UnauthorizedError } from '#src/lib/errors.ts';
import { hashPassword, verifyPassword } from '#src/lib/password.ts';
import * as userService from '#src/modules/user/user.service.ts';
import type { User } from '#src/modules/user/user.types.ts';

/**
 * Credential logic. No HTTP objects in here — signing tokens and setting cookies is
 * the route's job, because those are transport concerns.
 */

/**
 * One message for every failure mode. An unknown email, a wrong password and an
 * account with no password set must be indistinguishable, or the endpoint becomes
 * an oracle for "does this person have an account here".
 */
const INVALID_CREDENTIALS = 'Invalid email or password';

/**
 * Hashing this on the miss path costs the same as hashing a real password, so the
 * response time does not reveal whether the email exists. Computed once, lazily,
 * so it is not on the boot path.
 */
let decoyHash: Promise<string> | null = null;
function getDecoyHash(): Promise<string> {
  decoyHash ??= hashPassword('decoy-for-constant-time-login');
  return decoyHash;
}

export async function signup(input: {
  email: string;
  name: string;
  password: string;
}): Promise<User> {
  const passwordHash = await hashPassword(input.password);
  // createUser surfaces a duplicate email as a 409 — signup is the one place where
  // telling the caller "that email is taken" is unavoidable.
  return userService.createUser({
    email: input.email,
    name: input.name,
    passwordHash,
  });
}

export async function login(email: string, password: string): Promise<User> {
  const user = await userService.findUserByEmail(email);

  // An unknown email and an account with a null passwordHash both land here: they
  // burn one scrypt against the decoy so the response time matches the real path,
  // and the decoy's own result is discarded — matching it must never authenticate.
  if (!user?.passwordHash) {
    await verifyPassword(password, await getDecoyHash());
    throw new UnauthorizedError(INVALID_CREDENTIALS);
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    throw new UnauthorizedError(INVALID_CREDENTIALS);
  }

  return user;
}

/** Resolves the user behind an authenticated request; 401 if the row has since gone. */
export async function currentUser(userId: string): Promise<User> {
  const user = await userService.findUserById(userId);
  if (!user) {
    throw new UnauthorizedError('Authentication required');
  }
  return user;
}
