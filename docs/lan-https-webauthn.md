# HTTPS and WebAuthn for LAN (phone) access

This document records the investigation into making student passkey features work
on a phone connected to the K12 router's Wi-Fi, and explains why no application
code was added for it.

It extends [`lan-mode.md`](lan-mode.md), which covers plain-HTTP LAN mode. Read
that first for the traffic paths and the configuration switches.

---

## Outcome

**A warning-free, zero-touch passkey flow for ordinary student phones is not
achievable with the current hardware and constraints.** This is a browser and PKI
constraint, not a bug in this project and not something configuration can fix.

What *is* achievable, given some one-time infrastructure work, is a fully trusted
HTTPS origin on the LAN. That work is DNS and certificate issuance plus a router
capability — none of it belongs in this repository, and none of it can be done or
verified from here. The prerequisites are listed in
[What LAN WebAuthn actually requires](#what-lan-webauthn-actually-requires).

Everything that is not a passkey ceremony already works from a phone over plain
HTTP on the LAN today: admin, lecturer, student registration, attendance marking,
attendance history and course registration. Those flows authenticate with the
session cookie, not with WebAuthn.

---

## The four requirements

Passkeys on a phone need all four of these at once. Missing any one of them stops
the ceremony, and each is enforced by the browser or the operating system rather
than by this application.

### 1. The page must be a secure context

WebAuthn is only exposed in a secure context. Browsers treat `http://localhost` as
trustworthy because it cannot name another machine, but a plain-HTTP origin on a
private address such as `http://192.168.0.244:4173` is not a secure context. On
such a page `navigator.credentials` and `PublicKeyCredential` are unavailable, and
`frontend/src/lib/webauthn.ts` correctly reports the browser as unsupported.

**Consequence:** the app must be served over HTTPS. There is no flag that makes a
private-address HTTP page a secure context.

### 2. The certificate must actually be trusted

The most counter-intuitive requirement. A self-signed certificate does produce a
page where `window.isSecureContext` is `true`, but Chrome does not stop there:

> Since Chrome 110, WebAuthn is disabled for webpages served with an untrusted or
> otherwise broken TLS certificate, even when launched with
> `--ignore-certificate-errors`. The `AllowWebAuthnWithBrokenTlsCerts` enterprise
> policy exists for managed deployments.
> — [Chromium issue 40140414](https://issues.chromium.org/issues/40140414)

**Consequence:** "self-signed plus *Advanced → Proceed*" does not restore
passkeys. The warning-bypass route is not a workaround, and neither is the browser
flag.

### 3. The RP ID must be a real, registrable domain

The Relying Party ID is what scopes a passkey, and the browser will only accept a
claim that is a *registrable domain suffix of, or equal to*, the origin's effective
domain. Chromium's public header for the check states this directly:

> It's valid for the requested RP ID to be a registrable domain suffix of, or be
> equal to, the origin's effective domain.
> — `content/public/browser/webauthn_security_utils.h`,
> `OriginIsAllowedToClaimRelyingPartyId()`

Two consequences are routinely missed:

* **An IP address is not a valid RP ID.** The WebAuthn specification defines the RP
  ID as a valid domain string, and IP addresses and public suffixes are not
  valid. `192.168.0.244` cannot be the RP ID regardless of how the certificate is
  issued.
* **A `.local` name is not a valid RP ID either.** `.local` is reserved for mDNS by
  [RFC 6762](https://www.iana.org/assignments/special-use-domain-names/special-use-domain-names.xhtml)
  and has no Public Suffix List entry, so `attendance.local` has no registrable
  domain and the claim is rejected. The same reasoning applies to other
  non-registry names such as `.lan` or `.internal`. mDNS solving the *name* does
  not make the name a *registrable domain*.

**Consequence:** the LAN needs a real domain name, not an IP address and not a
made-up suffix.

### 4. That name must resolve to the LAN PC

A certificate is issued for a name, and the phone must reach the machine serving
it. The name has to resolve to the PC's LAN address on the K12 network — while the
same name must not send the public Internet to an internal machine. That is
split-horizon (split-DNS), and it is a router or local-DNS capability.

**Consequence:** the K12 router, or a DNS server on the LAN, must be able to answer
for that name locally. Whether the available router supports this is unknown and
must be checked by hand.

---

## The options, evaluated

### A. HTTPS on the LAN with a publicly trusted certificate — recommended

Serve the app at `https://<lan-name>:4173`, where `<lan-name>` is a real domain
the university controls and whose certificate chains to a public CA.

* Works on every phone with no setup at all, on any platform, with no warnings.
* Needs a real name (requirement 3) and split-horizon DNS (requirement 4).
* **Needs no public IP address and no port forwarding.** An ACME `DNS-01`
  challenge is validated by writing a DNS TXT record, not by connecting to the
  server, so a certificate can be issued for a machine that is not reachable from
  the Internet. The K12 clients have no Internet, which does not affect issuance.
* This is the only option that satisfies "an ordinary student's phone, with no
  prior setup".

Use a **dedicated** name for the LAN, not the production hostname. If the
production name already resolves to the real public server, reusing it on the LAN
sends students off-site and defeats the purpose. Something like
`attendance-lan.oou.edu.ng` keeps the two deployments separate while remaining a
valid RP ID.

> Confirm the candidate name is a registrable domain before relying on it. The
> production configuration already uses `attendance.oou.edu.ng`; a name under the
> same zone is the natural candidate, but verify the specific label against the
> current [Public Suffix List](https://publicsuffix.org/) rather than assuming.

### B. HTTPS on the LAN with a private certificate authority

Same as A, but the certificate chains to a private CA whose root must be installed
on every phone.

* The RP ID must still be a real registrable domain (requirement 3). A private CA
  does not relax this, and it cannot issue a WebAuthn-usable certificate for an IP
  address.
* **Android:** Chrome trusts user-installed CAs, so installing the root as a *user*
  credential is enough. This also sidesteps certificate-transparency requirements,
  which apply to publicly issued certificates.
* **iOS:** installing a configuration profile is not enough on its own. It must
  also be enabled by hand under **Settings → General → About → Certificate Trust
  Settings**. That is a per-device, per-phone step that cannot be automated
  without MDM, which is not available here.
* Reasonable for a small, known set of devices the university controls. Poor fit
  for an open cohort of student phones, and it has to be repeated for every new
  phone.

### C. Keep passkeys on the production deployment only

Leave the LAN deployment on plain HTTP, where it supports every non-passkey flow,
and direct students who need a passkey to the production site.

* Zero extra infrastructure, and the LAN keeps working exactly as documented in
  [`lan-mode.md`](lan-mode.md).
* Students on the LAN cannot enrol a device, log in with a passkey, or verify
  attendance with a device. They use the password and session-cookie flows.
* This is the current state of the system. Nothing needs to change.

### D. Public exposure or a tunnel — rejected

* A tunnel terminates TLS at a third party and requires the K12 clients to have
  Internet access. They will not: the K12 network has no SIM and no Internet
  path.
* Exposing a session-cookie attendance and authentication system on the public
  Internet — even behind a tunnel — puts student records and an authentication
  endpoint on an untrusted network.
* Port forwarding the K12 router is not permitted and would be the wrong shape of
  fix regardless.

### Not viable, for the record

* Self-signed certificate plus "Proceed anyway" — blocked by requirement 2.
* `--ignore-certificate-errors` or `NODE_TLS_REJECT_UNAUTHORIZED=0` — blocked by
  requirement 2, and both are process- or machine-wide settings that weaken
  everything else.
* The `AllowWebAuthnWithBrokenTlsCerts` enterprise policy — a managed-deployment
  feature, and it would still require a real registrable RP ID.
* Using the PC's LAN IP as the RP ID — blocked by requirement 3.
* Using a `.local` / mDNS name as the RP ID — blocked by requirement 3.
* Switching the passkey ceremonies to a relaxed server-side verifier, or adding a
  "skip origin check" or "accept any RP ID" branch — these would remove the
  phishing protection that makes a passkey better than a password, and are
  refused outright.

---

## What LAN WebAuthn actually requires

If option A is pursued, these are the prerequisites. None are application code.

1. **A dedicated LAN hostname** under a domain the university controls, chosen so
   it does not collide with the production deployment.
2. **A certificate for that hostname** that chains to a public CA. `DNS-01` is the
   practical ACME challenge here, because it needs no public IP address and no
   inbound port. A `HTTP-01` challenge will not work: it requires the name to
   resolve to the server from the public Internet.
3. **Split-horizon DNS** so that the hostname resolves to the PC's LAN address on
   the K12 network only.
4. **A TLS terminator in front of the app.** The cheapest option that matches the
   current architecture is for the Vite dev server to terminate TLS itself
   (`server.https` takes a Node `https.ServerOptions` value, so a certificate and
   key are all that is required) and keep proxying `/api` to Express over loopback
   HTTP. Because every browser request is same-origin, this needs no CORS policy
   and no change to the authentication model. The Vite dev server is a development
   tool, though: a hardened deployment should serve the built assets from a real
   server behind the same TLS and WebAuthn configuration.
5. **The matching WebAuthn configuration**, which is a two-line change to existing
   environment variables once the name is fixed:

   ```ini
   WEBAUTHN_RP_ID=<lan-hostname>
   WEBAUTHN_ORIGIN=https://<lan-hostname>:4173
   ```

   `WEBAUTHN_RP_ID` must be the same registrable domain the certificate covers and
   the same name the phone opened. Do not point these at the LAN IP.

6. **`AUTH_COOKIE_SECURE=true`** if the LAN deployment is served over HTTPS
   without `NODE_ENV=production`. This variable already exists; see
   [Session cookies over LAN HTTPS](#session-cookies-over-lan-https).

---

## Session cookies over LAN HTTPS

`Secure` on a session cookie is the one attribute whose correct value depends on
how the app is served. A browser drops a `Secure` cookie from a plain-HTTP page,
so the dev server must not set it; production must set it.

`backend/src/config/auth.ts` now resolves it explicitly:

| `NODE_ENV` | `AUTH_COOKIE_SECURE` | Result |
| --- | --- | --- |
| `production` | unset | `Secure` set (unchanged default) |
| `production` | `true` | `Secure` set |
| `production` | `false` | **startup error** |
| anything else | unset | no `Secure` (unchanged default) |
| anything else | `true` | `Secure` set |
| anything else | `false` | no `Secure` |
| anything | invalid value | **startup error** |

The override is one-directional on purpose: `AUTH_COOKIE_SECURE=false` is rejected
under `NODE_ENV=production`, so a stray environment variable cannot weaken the
production session cookie. `HttpOnly`, `SameSite=Lax` and the host-only (no
`Domain`) cookie are unchanged, and the clear-cookie options still mirror the
cookie they clear.

---

## What was deliberately not done

* No HTTPS, certificate or LAN-hostname configuration was added. The groundwork is
  worthless until a real name and a trusted certificate exist, and adding knobs
  that cannot be exercised end to end invites misconfiguration.
* `WEBAUTHN_RP_ID` and `WEBAUTHN_ORIGIN` are still required when
  `NODE_ENV=production`, and are still strict.
* No `allowedHosts` widening, no wildcard CORS, and no acceptance of arbitrary
  `Host` headers.
* No certificate material, private key, or certificate-transparency bypass in the
  repository.
* No insecure-origin browser flag is required or recommended.
* No Windows, router or DNS configuration was changed or attempted.
* PostgreSQL was not touched: no migration, seed, reset or cleanup.

---

## How to verify a candidate setup

Once a name and certificate exist, check these in order on a phone that has never
been configured. Each one isolates a single requirement.

1. **DNS** — the hostname resolves to the PC's LAN address, from the phone, on the
   K12 Wi-Fi.
2. **Trust** — the page loads with **no** certificate warning. If a warning
   appears, stop: passkeys will not work (requirement 2) regardless of anything
   else.
3. **Secure context** — in the browser console, `window.isSecureContext` is `true`
   and `window.PublicKeyCredential` is defined. If it is not, the origin is still
   being served over plain HTTP (requirement 1).
4. **RP ID** — enrolling a passkey succeeds instead of failing with a `SecurityError`
   about the relying party ID (requirement 3).
5. **Cookie** — the session cookie is present with `Secure` and `HttpOnly`.

Steps 2 and 3 distinguish the two failures that look identical from the app's
point of view: a "browser not supported" message from
`frontend/src/lib/webauthn.ts` means an insecure origin, whereas a passkey prompt
that never appears despite `PublicKeyCredential` being present means the origin is
not trusted.

---

## References

* [Chromium issue 40140414 — WebAuthn disabled for untrusted/broken TLS certificates](https://issues.chromium.org/issues/40140414)
* [Chromium issue 520117546 — RP ID validation and eTLD+1 on both sides](https://issues.chromium.org/issues/520117546)
* [WebAuthn Level 3 — Relying Party ID](https://www.w3.org/TR/webauthn-3/#rp-id)
* [RP ID deep dive — web.dev](https://web.dev/articles/webauthn-rp-id)
* [IANA special-use domain names (`.local` is reserved for mDNS)](https://www.iana.org/assignments/special-use-domain-names/special-use-domain-names.xhtml)
* [Public Suffix List](https://publicsuffix.org/)
* [Android network security configuration — user-added CA trust](https://developer.android.com/privacy-and-security/security-config#custom-trust-anchors)
* [Apple Support — install a configuration profile and trust a certificate](https://support.apple.com/en-my/102390)
* [Vite `server.https` and `server.allowedHosts`](https://vite.dev/config/server-options)
