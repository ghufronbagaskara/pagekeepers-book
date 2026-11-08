# Admin page and light/dark theme

## Why

Accounts were managed only through `bun run account`. The owner wants to manage readers from the browser and see who signed in and what changed. The site was also dark-only.

## Decided by the owner

- Two roles: `admin` and `user`. Admins also read books.
- `ghufronbagaskara08@gmail.com` is the first admin.
- Admins land on the library like everyone else. An "Admin" link in the masthead, shown only to admins, opens `/admin/`.
- The admin types the initial password (12 to 128 characters) when creating a user or resetting a password. No email service is involved.
- Scope: user management, audit log, overview.

## Admin page

- **Overview**: user totals (all, active, admins), book count, reading minutes in the last 7 days, and the latest audit entries.
- **Users**: email, name, role, status, created date, last read. Actions: create, disable/enable (disable also ends sessions), end sessions, reset password (also ends sessions), change role, delete permanently. Deleting requires typing the email and removes progress, bookmarks, and reading sessions.
- **Audit log**: sign-in success/failure, sign-out, and every admin action, with actor, target, IP, and time. Filter by action, paged 50 at a time. Entries older than 180 days are pruned.

## Rules

- Every `/api/admin/*` request checks the role in D1. Hiding the link in the UI is not the protection.
- An admin cannot disable, delete, or change the role of their own account. Since the acting admin always remains, at least one admin always exists.
- Mutations keep the existing same-origin check.

## Theme

- A sun/moon button in the masthead (library, admin) and on the sign-in card.
- The default follows the device setting. The choice is stored per device in `localStorage` (`reader-theme`) and applied before first paint.
- The reader stays dark. It has its own eye modes (normal, warm, night).

## Builder's calls

- The role is a column on `accounts` with values `user` and `admin`. The migration promotes the admin email if that account exists. Otherwise run `bun run account <stage> role <email> admin` after creating the account.
- The loopback preview account is an admin, so the admin page can be tested locally.
