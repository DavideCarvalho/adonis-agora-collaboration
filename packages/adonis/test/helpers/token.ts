import { signCollabToken } from '../../src/auth/token.js';

/**
 * A signing key for tests, and the tokens it produces.
 *
 * Shared because the alternative kept showing up as the same three lines in
 * every spec that opens a socket — and because the *shape* of a valid
 * credential is now a fact of the library, not a detail a test may improvise.
 * A spec that hand-rolls `base64({ userId })` is testing the hole that was
 * closed, and it would fail; one that hand-rolls a signature would be
 * asserting on the algorithm instead of on the behaviour.
 *
 * The secret is passed explicitly to every driver and manager these tests
 * build. There is no app around them, so nothing would resolve an `appKey`,
 * and that is deliberate: a driver with no key refuses every handshake, which
 * is what makes "we forgot to configure it" a loud failure instead of an
 * unsigned token.
 */
export const TEST_TOKEN_SECRET = 'test-token-secret-32-chars-minimum!';

/** A valid token for `docName`, signed with {@link TEST_TOKEN_SECRET}. */
export function testToken(
  docName: string,
  userId = 'user-1',
  options: { name?: string; expiresInSeconds?: number; secret?: string } = {},
): string {
  return signCollabToken(
    { userId, docName, ...(options.name ? { user: { name: options.name } } : {}) },
    options.secret ?? TEST_TOKEN_SECRET,
    options.expiresInSeconds,
  );
}
