import { hashPassword } from "../lib/auth/accounts";

/**
 * Prints the scrypt hash of a password, for an account in VERIBOOK_USERS:
 *
 *   npm run auth:hash -- 'a long password'
 *
 * Paste the output as that account's "passwordHash". The password itself is never stored.
 */
async function main() {
  const password = process.argv[2];
  if (!password) {
    console.error("usage: npm run auth:hash -- '<password>'   (at least 8 characters)");
    process.exit(2);
  }
  console.log(await hashPassword(password));
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
