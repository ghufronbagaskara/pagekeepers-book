# Pagekeepers

A private PDF library with a Zaya reader. Cloudflare Workers serves the Astro site, D1 stores accounts, sessions, catalog metadata, and reading progress, and a private R2 bucket stores catalog PDFs and covers. Readers download a book when they choose to read it. The browser keeps downloaded books and personal PDFs on that device. Files in `book/` stay out of the website build.

## Local preview

Install Bun and Node.js. To publish PDFs, also install Poppler and make sure `pdfinfo` and `pdftoppm` are on your PATH.

```powershell
bun install --frozen-lockfile
bun run check
bun test
bun run build
bun run preview
```

Open [the local preview](http://127.0.0.1:4321/login/). The preview account is `reader@example.test` with password `local-preview-only`. It works only on the loopback preview.

`bun run preview` uses local D1 and R2. Rebuild after code changes. `bun run dev` starts Alchemy in the staging stage and requires a Cloudflare connection.

The preview command applies local migrations. Stop the preview before loading books so Wrangler can write to local storage on Windows:

```powershell
bun run catalog local 'book/Pasta Kacang Merah.pdf' 'book/Bandung Menjelang Pagi.pdf'
bun run preview
```

Download and open a book before testing offline. Close the tab, stop the preview server, then reopen the same reader URL in the same browser profile. An expired session still requires an internet connection to sign in again.

## Deploy to Cloudflare

1. Enable R2 on the Cloudflare account. R2 Standard has a free allowance; usage above it can incur charges. See [R2 pricing](https://developers.cloudflare.com/r2/pricing/).
2. Connect the Cloudflare profile once. You can reuse the Renoir profile if it points to the intended account. With OAuth, leave Cloudflare API token variables unset.

```powershell
bun install --frozen-lockfile
# Skip this if Cloudflare is already connected.
bun run alchemy profile edit --add Cloudflare
bun run alchemy deploy --stage staging
```

Alchemy provisions the Worker, D1 database, and private R2 bucket, applies the migrations, and prints the Worker URL. It generates a separate session secret for each stage and reuses it on subsequent deployments. The interactive deploy needs no stage env file.

If planning reports that R2 must be enabled, complete the [R2 activation checkout](https://developers.cloudflare.com/r2/get-started/) in the same Cloudflare account that Alchemy uses. If D1 reports an authentication error, check the account selected in your Alchemy profile. To reconnect with the right account and permissions, run `bun run alchemy profile edit --reconfigure Cloudflare` and select OAuth. The Basic Scopes preset includes D1 and R2 write access in the pinned Alchemy version.

3. Create a staging account and publish a small sample catalog. For D1, run `bun wrangler login` once or set a scoped `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID`. For R2 uploads, set `CLOUDFLARE_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, and `R2_SECRET_ACCESS_KEY` in your environment. Use `.env.example` as a template for these data commands. Scope the R2 credentials to the target bucket.

```powershell
$env:PAGEKEEPERS_NEW_PASSWORD = Read-Host 'New reader password' -MaskInput
try {
  bun run account staging create reader@example.com
} finally {
  Remove-Item Env:PAGEKEEPERS_NEW_PASSWORD
}
bun run catalog staging 'book/Pasta Kacang Merah.pdf' 'book/Bandung Menjelang Pagi.pdf'
```

Use a fresh password of 12 to 128 characters. The account command prints an account ID. There is no public sign-up form. Admins manage accounts at `/admin/`. Sign-in uses [Better Auth with the D1 binding](https://better-auth.com/docs/concepts/database) and sessions last seven days from sign-in.

4. Sign in on staging. Check that downloading, offline reading, and progress sync work on your devices. Check for Cloudflare error 1102 during sign-in. Password verification must fit the [Workers Free CPU limit](https://developers.cloudflare.com/workers/platform/limits/), which local preview does not enforce. Once staging passes, deploy production, create its account, and publish the full catalog.

```powershell
bun run alchemy deploy --stage prod

$env:PAGEKEEPERS_NEW_PASSWORD = Read-Host 'New reader password' -MaskInput
try {
  bun run account prod create reader@example.com
} finally {
  Remove-Item Env:PAGEKEEPERS_NEW_PASSWORD
}

bun run catalog prod
```

The catalog command verifies the remote PDF and cover before updating D1. Running it again for the same PDF updates the same catalog entry.

## Account maintenance

To retain progress for an account created before the auth change, pass its existing D1 account ID as the final argument to `account ... create`. Use the ID from the matching stage and confirm that it belongs to the reader. Create a new password; the previous provider's password and sessions do not carry over. If you already use this site, sign in again on the same browser to recover books saved under the same account ID.

```powershell
bun run account prod disable ACCOUNT_ID
bun run account prod enable ACCOUNT_ID
bun run account prod revoke ACCOUNT_ID
```

To make an account an admin (or a regular user again), pass its email or account ID:

```powershell
bun run account prod role ghufronbagaskara08@gmail.com admin
```

Migration `0005_admin.sql` already promotes `ghufronbagaskara08@gmail.com` if that account existed when it ran. Admins see an **Admin** link in the library header. The admin page creates, disables, deletes and resets accounts, changes roles, ends sessions, and shows the audit log of sign-ins and admin actions. Audit entries are kept for 180 days.

`disable` blocks access and revokes sessions. `enable` allows sign-in again. `revoke` ends active sessions without disabling the account. A device that is fully offline can continue using its last valid local session until it reconnects or the session expires.

## GitHub Actions

The Pagekeepers workflow runs type checks, tests, and the build for pull requests and pushes to `main`. To deploy, create GitHub environments named `staging` and `prod`. For each environment, set the variable `CLOUDFLARE_ACCOUNT_ID` and the secret `CLOUDFLARE_API_TOKEN`. See [Alchemy's CI guide](https://alchemy.run/environments/ci/) for Cloudflare token setup.

In **Actions → Pagekeepers → Run workflow**, choose the stage. Production deployments run only from `main`. The workflow deploys code and migrations through Alchemy. Account creation and catalog publication remain separate commands.
