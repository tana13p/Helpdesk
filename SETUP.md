# Setup

## Prerequisites
- Node.js 18+
- Oracle Database reachable from your machine

## Install
```bash
npm install
```

## Environment
Create `.env` from `.env.example` and set:
```
PORT=3000
SESSION_SECRET=change_me
ORACLE_USER=admin
ORACLE_PASSWORD=your_password
ORACLE_CONNECT_STRING=localhost/XEPDB1
```

Ensure the Oracle user has privileges to create/select/insert on your schema tables.

## Run
```bash
npm run dev
```
Open `http://localhost:3000`.

## Database Notes
- Create required tables (users, tickets, categories, subcategories, sla_levels, ticket_status, ticket_comments, calendar_unavailability, etc.).
- Ensure sequences for ID columns as needed.
- For `CALENDAR_UNAVAILABILITY`, use a sequence for `ID` and consider a compound trigger for reassignment logic to avoid mutating table errors.

## Troubleshooting
- CORS/cookies: in dev `sameSite=lax`, for HTTPS use `secure=true` and `sameSite=none`.
- Oracle ORA- errors: verify `ORACLE_CONNECT_STRING` and privileges.
- PDF export: ensure `pdfkit` is installed and chart canvases are present before export. 