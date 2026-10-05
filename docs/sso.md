# Single sign-on setup

Northstar supports Google OIDC, GitHub OAuth, generic OIDC Authorization Code sign-in with PKCE,
and SAML 2.0 service-provider-initiated sign-in. Multiple providers can be configured at once. Local sign-in remains available for recovery.

## Configure Northstar

### From the hamburger menu

Sign in as an admin and open **Menu → Single sign-on**. Enter Northstar's public URL, choose a provider
from the list, and select **Add provider**. Enter its client credentials or OIDC/SAML settings, then register the callback
URL shown on the page in your identity provider. Select **Save SSO settings** to apply the changes.
You can configure several providers, edit their labels and settings, or remove them from this page.

Saved client secrets and SP private keys are never returned to the browser. Leave those fields blank
to preserve a saved value, enter a replacement to rotate it, or select the removal checkbox to clear
it. Google and GitHub require a client secret; replace it or remove the provider. Clearing a generic OIDC secret also requires selecting public-client authentication; clearing an SP
private key removes its paired public signing certificate. SAML IdP and SP public certificates can be
viewed and edited. Provider IDs stay fixed in the form after saving because they identify persisted
accounts and callback URLs.

Settings are stored in the configured Northstar database and take precedence over environment/file
configuration. Protect the database volume because it includes the saved provider credentials.
Portfolio JSON exports do not include SSO configuration. Changes take effect immediately without
restarting, invalidate pending sign-in requests, and preserve existing Northstar sessions and local
sign-in. If another admin saves settings while your page is open, reload before saving your changes.

### From deployment configuration

Environment/file configuration remains available for deployments that have not saved settings through
the menu. Once settings are saved through the menu, deployment environment changes do not override
them; use the menu for subsequent changes.

1. Create the initial local admin account before allowing SSO sign-in.
2. Serve Northstar through HTTPS and set `PUBLIC_URL` to its external origin, such as
   `https://northstar.example.com`. Callback URLs use this setting, never incoming Host headers.
3. Set `SSO_CONFIG_FILE` to a server-side JSON file containing an array of providers. Alternatively,
   set `SSO_PROVIDERS` to the JSON array itself. If both are set, the file takes precedence.
4. Register the callback URLs and configure the applications in your identity providers.
5. Set `SIGNUP_ALLOWED=true` to allow new accounts, or enable **Allow signup** in the admin settings.
   It defaults to `false` and governs local signup and new identities from every provider. Existing
   users, initial admin setup, and admin-created accounts remain available.
6. Restart Northstar after environment or file configuration changes.

Configuration is validated on startup. Provider IDs must be unique lowercase names up to 32
characters, beginning with a letter and containing letters, numbers, or hyphens. Keep an ID stable:
it forms part of the callback URL and persisted identity mapping. Only provider IDs, names, and
protocol types are sent to the browser.

Example environment:

```sh
PUBLIC_URL=https://northstar.example.com
SSO_CONFIG_FILE=/run/secrets/northstar-sso.json
SIGNUP_ALLOWED=true
COGNITO_CLIENT_SECRET=<app-client-secret>
```

Keep configuration containing secrets and certificates outside `public/` and source control. Secret
and certificate file paths refer to the server/container filesystem. HTTP `PUBLIC_URL` is allowed
only on localhost for OIDC development. OIDC issuer URLs always require HTTPS; SAML also requires
HTTPS on Northstar because its cross-site POST callback uses a Secure, SameSite=None correlation
cookie. The HTTPS reverse proxy must forward the callback routes, including SAML form POST bodies.

## Google and GitHub

In **Menu → Single sign-on**, choose **Google** or **GitHub**, then enter the client ID and
client secret. Google uses its fixed issuer and GitHub uses its fixed OAuth and user API endpoints.
Register the displayed callback address with the provider. With the default provider IDs these are:

- Google: `https://northstar.example.com/api/auth/sso/google/callback`
- GitHub: `https://northstar.example.com/api/auth/sso/github/callback`

For Google, create a web application OAuth client and register an authorized redirect URI.
For GitHub, create an OAuth app and register its authorization callback URL. Both flows use
PKCE and browser-bound, single-use state. See the [Google OIDC documentation](https://developers.google.com/identity/openid-connect/openid-connect)
and [GitHub OAuth documentation](https://docs.github.com/en/apps/oauth-apps/building-oauth-apps/authorizing-oauth-apps).

Environment/file configuration can include these entries alongside the other providers:

```json
[
  { "id": "google", "name": "Google", "type": "google", "clientId": "your-google-client-id", "clientSecretEnv": "GOOGLE_CLIENT_SECRET" },
  { "id": "github", "name": "GitHub", "type": "github", "clientId": "your-github-client-id", "clientSecretEnv": "GITHUB_CLIENT_SECRET" }
]
```

Set the referenced secret environment variables on the server. New accounts require signup to be
allowed. When enabled, local users see **Create an account** on the login page, which uses
`POST /api/auth/signup`; requested roles are ignored and new accounts always receive read-only access.
Saved admin settings take precedence over `SIGNUP_ALLOWED`, just as they do over the provider list.

## OIDC

Example `/run/secrets/northstar-sso.json`:

```json
[
  {
    "id": "cognito",
    "name": "Company sign-in",
    "type": "oidc",
    "issuer": "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_EXAMPLE",
    "clientId": "your-app-client-id",
    "clientSecretEnv": "COGNITO_CLIENT_SECRET",
    "tokenEndpointAuthMethod": "client_secret_basic",
    "scopes": "profile email"
  }
]
```

Register this exact sign-in redirect URI in the provider:

```text
https://northstar.example.com/api/auth/sso/cognito/callback
```

Select a web application with Authorization Code enabled and permit the `openid`, `profile`, and
`email` scopes used above. Northstar always includes `openid`; `scopes` defaults to `profile email`.
It sends an S256 PKCE challenge, state, and nonce and requests a query-string authorization-code
response. ID-token signatures are checked against the provider's discovered JWKS, alongside issuer,
audience, expiry, and nonce validation. Access and refresh tokens are not retained or exposed to the
browser; Northstar creates its own session after successful authentication.

`clientSecretEnv` reads the secret from the named environment variable. A `clientSecret` value can
also be supplied directly in a protected configuration file. The default client authentication method
is `client_secret_basic` when a secret is present, otherwise `none`. Set `tokenEndpointAuthMethod`
to `client_secret_post` if required by your provider, or `none` for a public client using PKCE.

### AWS Cognito

Configure a user pool app client with Authorization Code and a managed-login domain. Use the **issuer
from the user pool discovery document**, not the managed-login domain. The example above shows a
traditional user pool issuer; deployments with updated issuer formats must use their actual issuer.
Register the callback URI and enable the required scopes and identity providers on the app client.
Cognito supports Basic client authentication at its token endpoint.

Cognito acts as Northstar's OIDC provider. If your enterprise users authenticate through SAML to
Cognito, configure that upstream federation in the user pool; Northstar still connects to Cognito
over OIDC. See AWS's [federation endpoints](https://docs.aws.amazon.com/cognito/latest/developerguide/federation-endpoints.html)
and [token endpoint](https://docs.aws.amazon.com/cognito/latest/developerguide/token-endpoint.html).

### Okta and PingOne

Create an OIDC web application, assign the intended users, and register
`https://northstar.example.com/api/auth/sso/<provider-id>/callback`. Set the issuer to the exact value
published in that application's authorization server discovery document:

- Okta: commonly `https://your-org.okta.com` for the org authorization server, or
  `https://your-org.okta.com/oauth2/default` for a custom authorization server. See
  [Okta authorization servers](https://developer.okta.com/docs/concepts/auth-servers/).
- PingOne: commonly `https://auth.pingone.com/<environment-id>/as`; regional or custom domains can
  differ. See [PingOne token claims](https://developer.pingidentity.com/pingone-api/foundations/authentication-concepts/access-tokens-and-id-tokens/token-claims.html).

Configure `clientId`, the client secret, and the client authentication method required by the app.

## SAML 2.0

Example provider, which can be included in the same configuration array as OIDC providers:

```json
{
  "id": "okta-saml",
  "name": "Okta",
  "type": "saml",
  "entryPoint": "https://your-org.okta.com/app/your-app/sso/saml",
  "idpIssuer": "http://www.okta.com/your-idp-id",
  "entityId": "https://northstar.example.com/saml/okta-saml",
  "idpCertFile": "/run/secrets/okta-signing-cert.pem"
}
```

Use the IdP's SSO endpoint, issuer/entity ID, and signing certificate from its metadata. `idpIssuer`
is an identifier and may be an HTTP URI; it is not a fetched endpoint. Northstar checks it against
the signed assertion issuer. Configure the IdP application using:

| Setting | Value |
| --- | --- |
| ACS / single sign-on URL | `https://northstar.example.com/api/auth/sso/okta-saml/callback` |
| SP entity ID / audience | The configured `entityId` |
| SP metadata URL | `https://northstar.example.com/api/auth/sso/okta-saml/metadata` |
| Response binding | HTTP-POST |
| Assertion signature | Required, using SHA-256 or stronger |
| NameID | Persistent, stable, unique per person |

Northstar sends AuthnRequests through HTTP-Redirect. Both Okta and PingOne can be configured using
the same standard fields. Assertion signatures are required; response signatures are optional unless
`wantAuthnResponseSigned` is `true`. Audience, signed assertion issuer, recipient, timestamps, and
`InResponseTo` are checked. Unsolicited IdP-initiated responses are rejected. To launch from an IdP
dashboard, use a bookmark pointing at Northstar's `/api/auth/sso/<provider-id>/login` URL.

Optional settings:

- `idpCert`: PEM certificate text, or an array of PEM certificates for IdP signing-key rotation.
  `idpCertFile` loads a single PEM certificate from a file.
- `privateKeyFile` and `publicCertFile`: paired SP signing key and certificate if your IdP requires
  signed AuthnRequests. Inline `privateKey` and `publicCert` are also supported. Requests use SHA-256,
  and the public certificate is included in SP metadata.
- `identifierFormat`: requested NameID format. It defaults to persistent; an email-address format
  can be configured if required by the IdP. Transient NameIDs are rejected.
- `wantAuthnResponseSigned`: set to `true` if the IdP signs both response and assertion.

Encrypted SAML assertions and federated single logout are not implemented. Signing out clears only
the Northstar session; the identity provider session can remain active.

## Accounts, roles, and access removal

When signup is allowed, the first successful provider sign-in creates a **read-only** account.
When signup is disabled, only previously mapped provider accounts can sign in. Identity mappings use provider ID,
issuer, and stable OIDC `sub`, GitHub numeric user ID, or SAML NameID; email and username do not link to local accounts.
IdP role/group claims do not grant admin access. An existing admin can rename the generated
`sso-<provider-id>-<identity-hash>` username or promote the account in **Menu → Users**. Renaming it
does not change its identity mapping. SSO account passwords remain managed by the provider.

Only assign the IdP application to users who should have Northstar access. To revoke access, remove
the IdP application assignment and delete the Northstar account to invalidate its active sessions.
Deleting an account alone permits a new read-only account on its next successful IdP sign-in
if signup remains enabled.
Northstar sessions last seven days and are not continuously revalidated against the IdP.

Login requests expire after ten minutes, are bound to the initiating browser, and can be consumed
only once. They are stored in the configured database and survive a process restart. This deployment still uses one
Northstar database; independent replicas with separate databases cannot share SSO requests
or sessions. Environment/file configuration changes require a restart; menu changes apply immediately.
Keep a local admin for recovery.

## Docker Compose

Mount a protected configuration file and any certificates/keys into the container. For example,
merge this into the existing service configuration:

```yaml
services:
  northstar:
    environment:
      PUBLIC_URL: https://northstar.example.com
      SSO_CONFIG_FILE: /run/secrets/northstar-sso.json
      COGNITO_CLIENT_SECRET: ${COGNITO_CLIENT_SECRET}
    volumes:
      - ./private/northstar-sso.json:/run/secrets/northstar-sso.json:ro
      - ./private/okta-signing-cert.pem:/run/secrets/okta-signing-cert.pem:ro
```

Ensure mounted files are readable by the container's non-root user. Terminate HTTPS at your reverse
proxy and route traffic to Northstar's port 3000.

## Verification

Run `pnpm check`. Automated tests use a mock OIDC server with signed ID tokens and real signed SAML
assertions. They cover successful sign-in, callback replay, browser binding, request expiry, bad nonce,
invalid signatures, audience mismatch, incorrect SAML issuer/recipient, and role isolation. The PEM
files under `support/fixtures/sso-test-*` are public test credentials, never deployment secrets.

Before enabling access in production, exercise sign-in and logout with a test user in your actual
IdP tenant. Tenant-specific policies, assignments, domains, and certificate rotation must be
configured there; they are not provisioned by Northstar.
