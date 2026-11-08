# calendar

[![CI](https://github.com/openasy/calendar/actions/workflows/ci.yml/badge.svg)](https://github.com/openasy/calendar/actions/workflows/ci.yml)
[![Node.js 26 LTS](https://img.shields.io/badge/node-26%20LTS-339933?logo=nodedotjs&logoColor=white)](./.nvmrc)
[![License: AGPL-3.0](https://img.shields.io/badge/license-AGPL--3.0-blue)](./LICENSE)

The [OpenAsy](https://github.com/openasy) Calendar product: calendars and contacts on your company's own mail server.
Day, week, month and agenda views, invitations and answers, free and busy, rooms that book themselves, team calendars,
sharing, subscription links, and contacts with groups, on [Stalwart](https://stalw.art), the open-source mail server
that OpenAsy Mail already runs. Stalwart stores every calendar and address book and serves them over CalDAV and
CardDAV, so the phone's own calendar, Thunderbird and Outlook (with a CalDAV add-in) work as they are.

```
calendar.yaml ──▶ calendar ── JMAP (management) ──▶ Stalwart ◀── CalDAV, CardDAV ── phones, Thunderbird, Outlook
                    │  ▲                               ▲    ▲
       the pages ───┘  └── JMAP, as the person ────────┘    └── iTIP by email ── guests at Gmail, Outlook.com, ...
```

Calendar keeps no calendar data. It talks to Stalwart over JMAP (RFC 8620, JMAP for Calendars and Contacts): with its
own service account to keep the server in step with the file, and as the signed-in person, by impersonation, for their
calendars and contacts. People never give Calendar a password, and only calendar and contacts methods are passed on
from the pages: never mail, never Stalwart's management. CalDAV is used only to export a calendar as one `.ics` file.

Calendar needs Mail: it runs on Mail's Stalwart, and the people with a calendar are the mailboxes of Mail's domains
file. It uses only what Stalwart's open-source edition offers (tested against 0.16.27): JMAP for Calendars and
Contacts, CalDAV and CardDAV, scheduling (iTIP inside the server, iMIP by email outside it), availability, sharing,
group accounts and alarms by email.

## What it does

- **Views**: day, week, month and a 30-day agenda, in the time zone each person picks; an event keeps its own zone, so
  a meeting set in Istanbul shows at the right time in New York. Calendars can be shown and hidden, each in its colour.
- **Events**: repeating by day, weekday, week (any days), month (a date or the second Tuesday), year, or every n units,
  until a date or for a number of times. A change or deletion applies to one time, to that time and the later ones, or
  to all of them. Reminders as a notification on the person's devices or as an email from Stalwart.
- **Invitations**: guests from the directory or any address. Colleagues get the invitation in their calendar at once,
  others by email in the standard format (iMIP), with Stalwart's links to answer from any mail client. Answers come
  back the same way. Invitations still to answer are listed beside the calendar.
- **Free and busy**: colleagues see when someone is busy, never what it is. Calendar asks each person's own account for
  their busy times, so nothing has to be shared for it. "Find a time" shows everyone's busy times for the day and
  offers the first time all are free.
- **Rooms and equipment**, set in the file: booked by inviting them. A room accepts when it is free at every time of the
  event, from someone who may book it and within how far ahead it takes bookings, and declines otherwise; the answer
  goes back to the organizer like any guest's. The Rooms page shows the day's bookings, private ones only as busy.
- **Team calendars**, set in the file: a calendar and an address book every member sees and edits, on their phone too.
- **Sharing**: a person shares a calendar with a colleague to see free and busy, details, or to edit it.
- **Subscription links**: a secret address any calendar app subscribes to, with all details or free and busy only.
- **Import and export**: `.ics` and `.vcf` files from the old provider are read by Stalwart and saved; a calendar or an
  address book exports as one file.
- **Contacts**: the company directory (everyone with a mailbox, or Identity's people when it is set up), a personal
  address book, team address books, groups, and the next meeting together with each contact.
- **Calendar apps**: the CalDAV and CardDAV addresses, steps for iPhone, Mac, Android (DAVx5), Thunderbird and Outlook,
  and device passwords, made in Stalwart and shown once.
- **Leaving**: when Mail disables someone's mailbox, an admin sees the meetings they still organize and hands them to
  someone else (made again in that person's calendar, the guests invited again and the old one cancelled) or cancels
  them.

## Teams and rooms

List them in the calendar file, `/config/calendar.yaml` (`CALENDAR_CONFIG`):

```yaml
teams:
  - { address: sales-team@example.com, name: Sales team, members: [jane@example.com, ali@example.com] }
rooms:
  - { address: lisbon@rooms.example.com, name: Lisbon, seats: 6, location: 3rd floor, features: [Screen] }
  - { address: projector@rooms.example.com, name: Projector, kind: equipment, bookers: [jane@example.com], bookAhead: 30 }
```

The file is the only way in: no screen and no API route adds, changes or removes a team or a room, so the list can live
in git and be reviewed like code. It is read at start and again within a minute of a change, and applied whole or not
at all. A file with a mistake leaves the last good version in place, and the log and the Settings page say which entry
and field to fix. Without a file, Calendar runs with no teams and rooms.

| Field | | |
| --- | --- | --- |
| `teams[].address` | required | The team's own account on the mail server |
| `teams[].name` | required | Shown as the calendar's and address book's name |
| `teams[].members` | | Mailboxes that see and edit the team's calendar and contacts |
| `rooms[].address` | required | The address people invite to book it |
| `rooms[].name` | required | |
| `rooms[].kind` | `room` | `room` or `equipment` |
| `rooms[].seats`, `location`, `features` | | Shown on the Rooms page |
| `rooms[].bookers` | everyone | Mailboxes that may book it |
| `rooms[].bookAhead` | `180` | Days ahead it accepts a booking |

After every change, and every five minutes, Calendar brings Stalwart in step: a team is a group account whose members
are the listed mailboxes, and a room is an account with Calendar's own role, which may receive invitations and answer
them but has no password and never sends mail. Calendar marks the accounts it makes and touches only those, and only
the team memberships it gave. A room taken out of the file stops taking invitations and a team loses its members;
neither is deleted, so bookings and calendars stay until an admin deletes them in Stalwart.

Mail leaves both alone: it manages only accounts of type User with the User role, and a team is a group while a room
has Calendar's role. Still, give rooms a domain of their own, such as `rooms.example.com`, that is not in Mail's
domains file, and use team addresses Mail does not use. An address Stalwart already has for something Calendar did
not make is refused, with the entry named.

## Run

Calendar joins an install where Mail runs (see Mail's README for Stalwart's first start). `compose.yaml` shows the
three together.

```bash
openssl rand -hex 32 > openasy-kek
printf '%s' "$(openssl rand -hex 24)" > calendar-stalwart-password
$EDITOR config/calendar.yaml   # your teams and rooms
docker compose up -d calendar
docker compose exec -e "$(cat stalwart.env)" calendar node server/stalwart-setup.ts
docker compose logs calendar | grep 'no owner yet'
```

`server/stalwart-setup.ts` makes the account Calendar uses, `openasy-calendar`, with the password in
`calendar-stalwart-password` and the administrator role, which holds the `impersonate` permission. It refuses to run
before Mail's first start, and is safe to run again. Stalwart must serve HTTPS under the mail server's name for calendar
apps (port 443 in `compose.yaml`); `CALENDAR_DAV_URL` is that address.

Open the link from the log once to create the owner account; there is no default password (ADR 0013). Calendar is on
http://localhost:8081 in `compose.yaml`; put it behind TLS. Everyone with a mailbox signs in with the same address:
through your identity provider with `OPENASY_OIDC_DEFAULT_ROLE=user`, or invited as members with the user role.

| Variable | Default | |
| --- | --- | --- |
| `PORT` | `8080` | HTTP port |
| `CALENDAR_PUBLIC_URL` | `http://localhost:8080` | The address people open, with `https://` behind your TLS proxy; subscription links use it |
| `CALENDAR_DAV_URL` | `https://mail.example.com` | Where calendar apps reach Stalwart's CalDAV and CardDAV |
| `CALENDAR_CONFIG` | `/config/calendar.yaml` | The calendar file |
| `CALENDAR_STALWART_URL` | `http://stalwart:8080` | Where Calendar reaches Stalwart's HTTP listener |
| `CALENDAR_STALWART_USER` | `openasy-calendar` | The service account; it needs the `impersonate` permission |
| `CALENDAR_STALWART_PASSWORD_FILE` | `/run/secrets/calendar-stalwart-password` | Its password, or `CALENDAR_STALWART_PASSWORD` |
| `CALENDAR_IDENTITY_URL` | | OpenAsy Identity, for the company directory's names and groups |
| `CALENDAR_IDENTITY_TOKEN_FILE` | `/run/secrets/identity-token` | An Identity API token with the viewer role, or `CALENDAR_IDENTITY_TOKEN` |
| `OPENASY_PRODUCTS` | | The install's other OpenAsy products, for the product switcher |
| `CALENDAR_SECRETS_KEY_FILE` | `/run/secrets/openasy-kek` | 32-byte key-encryption key (ADR 0021) |
| `CALENDAR_DB` | `/data/calendar.db` | SQLite file (WAL), on the `/data` volume |
| `CALENDAR_METRICS_PORT` | | Serve `/metrics` on this port only (ADR 0026) |
| `CALENDAR_HEADLESS` | `false` | `true` serves only the API |
| `CALENDAR_PASSWORD_SIGN_IN`, `OPENASY_OIDC_*` | | Sign-in, as in every OpenAsy product ([@openasy/auth](https://github.com/openasy/auth)) |

The container runs as non-root with a read-only root filesystem, no capabilities and `no-new-privileges`. Its database
holds sign-in, the history of syncs, what rooms answered (90 days) and the hashes of subscription links; the calendars
are in Stalwart's volume, which is the one to back up.

## Roles

Users plan their own day: their calendars, contacts, sharing, links and device passwords. Viewers also see the file
and the syncs; admins also sync on request, hand over the meetings of people who left, and manage members and API
tokens (ADR 0003). API tokens never read anyone's calendar.

## Notes on Stalwart

- A moved or changed time of a repeating event is written with the whole event in it, not only what changed, so
  every calendar app and every guest sees it in full; Stalwart 0.16 keeps a bare change as it is.
- Stalwart refuses an invitation to an address it cannot schedule for, such as one under `.example`; the page shows
  its reason.
- Free and busy inside calendar apps (Thunderbird's own "find a time") sees only calendars shared with free and busy
  rights; the pages see everyone's.

## Not yet

Meet links (Meet is not built yet), leave from HR shown as busy, Exchange ActiveSync, read-only team members, and
subscribing to calendars published elsewhere.

## Develop

```bash
npm install
npm test        # the file, the sync, rooms' answers, iCalendar files, time zones and repeating, and every API response against openapi.json
npm run dev     # the UI, with the API on :8080
```

Tests run against a mail server in memory (`server/fake-stalwart.ts`) that answers the JMAP, CalDAV and CardDAV calls
Calendar makes.

`npm run e2e` (`e2e/run.sh`, also in CI) starts the Stalwart that `compose.yaml` pins, does its first start as Mail
does and then Calendar's own, and runs Calendar's server against it: the file applied, a weekly meeting across time
zones with a moved and a skipped time, an invitation answered inside the company and one sent by email outside it,
rooms accepting and declining, free and busy without details, exports and subscription links, an `.ics` import,
contacts with a group, a device password over CalDAV, the pages kept to calendars and contacts, the meetings of
someone who left handed over, and a team and a room taken out of the file, each checked in Stalwart itself.

## Licence

AGPL-3.0 (ADR 0008). Stalwart is AGPL-3.0 too; Calendar uses only its open-source edition.
