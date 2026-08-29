# Operating the portal

Things the code does not tell you and the UI does not explain, written down the first time
each one cost somebody a round trip.

## Ask the agent instead of clicking

`bin/qpc-portal` in the quantumpc management repo administers all of this through Homarr's
own tRPC API. Sergio, 2026-08-29: *"no estoy nunca delante del teclado."*

```sh
qpc-portal status                              # who the server thinks we are
qpc-portal boards | groups | users
qpc-portal permissions dashboard
qpc-portal grant dashboard everyone view       # and --dry-run before it
qpc-portal revoke dashboard everyone
qpc-portal call board.getAllBoards             # anything else the API exposes
```

It signs in as `quantumpc-agent@…`, which the portal admits through
`AUTH_IAP_SERVICE_ACCOUNTS` (see `packages/auth/providers/iap/service-accounts.ts`). The
account appears in the user list like any other, which is deliberate: an administrator that
does not show up in the members list is one nobody audits.

**One sharp edge it handles so you do not have to.** `saveGroupBoardPermissions` deletes
every group permission on the board and re-inserts what it is given. Calling it with only
the group you are changing silently revokes everybody else — which looks like it worked.
`qpc-portal grant` reads the current set and merges.

The UI below still works and is still the right answer for a human at a keyboard. Both write
the same rows.

## A new board is invisible to members until you say otherwise

**Symptom.** An administrator builds a board, sees it perfectly, and every ordinary member
signs in to an empty portal — or to a "create your first board" screen. Nothing is broken
and nothing is logged, because from Homarr's point of view nothing went wrong.

**Cause.** `constructBoardPermissions` (`packages/auth/permissions/board-permissions.ts`)
grants view access on five conditions, and a fresh board satisfies none of them for an
ordinary member:

| Condition | A board created by the installer |
|---|---|
| you are the creator | `creator_id` is `NULL` — nobody created it |
| you have a per-user permission | none exist |
| one of your groups has a per-board permission | none exist |
| the board is public | `is_public` is `false` |
| your group has `board-view-all` | `everyone` has no permissions at all |

An administrator passes on the last one, because `admin` resolves through
`board-full-all` → `board-modify-all` → `board-view-all`. **That is the whole trap: the
person checking is the one person who cannot reproduce it.** Measured on 2026-08-29, with
`boardGroupPermission` and `boardUserPermission` both holding zero rows.

**Fix — three clicks, and this is the supported route.** Open the board, go to its settings
(`/boards/<board>/settings`), section **Access control**, add the group `everyone` with
**View board**, save.

That grants viewing and nothing else: `hasChangeAccess` requires the `modify` or `full`
permission specifically, so members can read the board and cannot touch it. Which is the
arrangement the association wants — administrators curate, members consume.

**Repeat it for every new board.** Homarr's model is per-board by design and there is no
"visible by default" setting. The global alternative is granting the `everyone` group
`board-view-all`, which publishes *every* board including half-finished ones — deliberately
not done here.

## `everyone` needs no maintenance

`addUserToEveryoneGroupIfNotMemberAsync` in `packages/auth/events.ts` adds every user to the
`everyone` group on every sign-in, whatever provider they came in through. So there is no
enrolment step for a new member: they sign in with Google, IAP proves who they are, the
account is created and joins `everyone` in the same request.

`everyone` also carries a `home_board_id`. Once the group can view a board, that is where
members land — not merely a board they *can* reach, but the one they open on.

Two ordering notes, from `getHomeIdBoardAsync` (`packages/api/src/router/board.ts`):

- A user's own `home_board_id` **wins** over the group's. Creating a board sets it
  automatically for its creator, so anyone who has ever made a board is pinned to it until
  they change it.
- The group consulted is the lowest-position group *other than* `everyone` first, and
  `everyone` only after. Giving a new group a home board silently moves everybody in it.

## The board name is not the title you see

`board.name` is the slug in the URL and the thing every query matches on. `page_title` and
`meta_title` are what the browser shows. Renaming the portal in settings changes the second
pair and leaves the first alone, so the default board answers to `dashboard` long after it
stopped saying so on screen. Look boards up by `id`, or expect to be confused.

## Members cannot create boards, and the button may suggest otherwise

`createBoard` is behind `requiresPermission("board-create")`, and the `everyone` group holds
no permissions. So an ordinary member cannot create a board even where the UI offers it.
If that is ever meant to change it is a deliberate grant, not an oversight to correct.

## Reading the database

Diagnosis only — the supported way to *change* any of the above is the UI, which writes the
same rows with none of the risk.

```sh
URI=$(gcloud secrets versions access latest --secret=mt-portal-db-url --project=multitecweb)
export URI
docker run --rm -i -e URI postgres:17-alpine sh -c 'exec psql "$URI" "$@"' -- -c '<query>'
```

`-e URI` with no `=value` passes the variable by name, so the connection string never enters
`argv` and never reaches `ps`. Same doctrine as `bin/qpc-portal-db-backup` in the management
repo. Do not paste the URI into a command line, and do not print it.

Two naming quirks that will waste your first few queries: **tables are camelCase and quoted**
(`"boardGroupPermission"`, `"groupMember"`, `"group"`, `"user"`), while **columns are
snake_case** (`is_public`, `home_board_id`, `creator_id`). Drizzle is configured that way;
the schema file spells the table names out literally.
