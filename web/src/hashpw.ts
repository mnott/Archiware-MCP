// Prints a password hash for secrets.json (auth.hash). Reads the password from stdin or argv[2].
import { randomBytes, scryptSync } from "node:crypto";
import { createInterface } from "node:readline";

async function main() {
  let pw = process.argv[2];
  if (!pw) {
    const rl = createInterface({ input: process.stdin });
    pw = await new Promise<string>((res) => rl.once("line", res));
    rl.close();
  }
  const salt = randomBytes(16);
  const N = 16384;
  console.log(`scrypt$${N}$${salt.toString("hex")}$${scryptSync(pw, salt, 32, { N }).toString("hex")}`);
}
main();
