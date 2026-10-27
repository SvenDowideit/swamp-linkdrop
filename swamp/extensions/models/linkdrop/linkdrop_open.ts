/**
 * No-auth webhook handler for LinkDrop.
 *
 * `swamp serve` requires a non-empty `secret` in every webhook route, but an
 * extension handler decides whether to use it. This handler accepts every
 * request, so the route needs only the literal placeholder `secret: "unused"`.
 * Protect the route at the network/Caddy layer if access control is needed.
 *
 * @module
 */

/** Open webhook handler for the LinkDrop receiver. */
export const webhook = {
  type: "@svendowideit/linkdrop-open",
  name: "LinkDrop open webhook",
  description:
    "Accepts LinkDrop shares without authentication. Protect the route at the " +
    "network or Caddy layer.",
  createHandler: (_config: Record<string, unknown>) => ({
    signatureHeader: "x-linkdrop-unused",
    requiredHeaders: [] as string[],
    verify: (
      _body: Uint8Array,
      _headers: Headers,
      _secret: string,
    ) => true,
  }),
};
