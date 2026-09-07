import { createHash, randomBytes } from "node:crypto";

export type TokenKind = "omni_enroll" | "omni_host";

/** Mint a URL-safe opaque token; only its hash is ever stored. */
export function mintToken(kind: TokenKind): string {
  return `${kind}_${randomBytes(32).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}
