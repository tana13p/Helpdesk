# Helpdesk

A role-based helpdesk web app with admin/agent/customer dashboards, ticketing, knowledge base, and reporting. Backend: Node.js/Express + OracleDB. Frontend: static HTML/CSS/JS.

## Features
- Authentication with sessions
- Role-based UI (Admin, Agent, Customer)
- Tickets with categories, subcategories, SLA
- Knowledge base CRUD (admin)
- Team calendar with unavailability + reassignment trigger
- Reports dashboard with summary KPIs and charts
- PDF exports (agent report, dashboard-style report)

## Requirements
- Node.js 18+
- Oracle Database (XE or higher) reachable from server
- OracleDB node driver (thin mode works out-of-the-box)

## Setup
1. Install deps
```bash
npm install
```
2. Create `.env` from template
```bash
cp .env.example .env
```
3. Configure Oracle connection and session secret in `.env`.
4. Start dev server
```bash
npm run dev
```
Server runs on http://localhost:3000.

## Scripts
```json
{
  "start": "node server.js",
  "dev": "node server.js",
  "lint": "echo 'add eslint if needed'"
}
```

## Environment
See `.env.example` for variables.

## Roles
- Admin: all dashboards, settings, reports, templates, tools, users
- Agent: tickets, templates, knowledge base, categories, team, tools, settings
- Customer: tickets, knowledge base, categories, settings

## Key Endpoints
- Auth/session: `GET /api/me`, `POST /api/signin`
- Tickets: `POST /tickets`, `GET /tickets/:userId`, `GET /assigned-tickets/:userId`
- Settings: categories/subcategories/SLA/roles CRUD under `/api/settings/*`
- Reports (global): `GET /api/reports/summary`, `GET /api/reports/agents`
- Reports (agent): `GET /api/reports/agent/:id/summary`, `GET /api/reports/agent/:id/charts`, `GET /api/reports/agent/:id/pdf`
- Reports (PDF): `POST /api/reports/dashboard-pdf`

## Database Notes
- Ensure sequences/triggers for tables requiring IDs (e.g., `CALENDAR_UNAVAILABILITY` uses sequence and compound trigger for reassignment logic).
- Provide seed data for users (roles: 1=Admin, 2=Agent, 3=Customer), categories, subcategories, SLA.

## Security
- Session cookie: sameSite=lax (dev), set secure+sameSite=none in HTTPS
- Store secrets in `.env`, not in VCS

## License
See LICENSE. 