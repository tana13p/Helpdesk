# API

Base URL: `http://localhost:3000`

Auth/session
- `GET /api/me` → `{ userId, username, role_id }`
- `POST /api/signin` → `{ success, message, role_id, username }`

Tickets
- `POST /tickets` create ticket
- `GET /tickets/:userId` tickets created by user
- `GET /assigned-tickets/:userId` tickets assigned to agent

Settings (admin)
- `GET/POST/PUT/DELETE /api/settings/categories`
- `GET/POST/PUT/DELETE /api/settings/subcategories`
- `GET/POST/PUT/DELETE /api/settings/sla`
- `GET/POST/PUT/DELETE /api/settings/roles`

Reports (global)
- `GET /api/reports/summary` → `{ totalTickets, openTickets, resolvedTickets, slaBreaches }`
- `GET /api/reports/agents` → list of agents with KPIs for table

Reports (agent)
- `GET /api/reports/agent/:id/summary` → `{ totalTickets, openTickets, resolvedTickets, slaCompliance, avgResponseTime, avgResolutionTime, csat }`
- `GET /api/reports/agent/:id/charts` →
```json
{
  "ticketVolume": [{ "MONTH": "Jan", "COUNT": 120 }],
  "statusDist": [{ "STATUS_ID": 1, "COUNT": 30 }],
  "priorityDist": [{ "PRIORITY_ID": 2, "COUNT": 40 }],
  "slaCompliance": { "labels": ["Jan"], "data": [91] },
  "categoryDist": [{ "CATEGORY": "Hardware", "COUNT": 20 }],
  "csat": 4.6
}
```

PDF
- `GET /api/reports/agent/:id/pdf` → binary PDF download (agent report)
- `POST /api/reports/dashboard-pdf` body:
```json
{
  "summary": [{ "title": "Total Tickets", "value": "1249", "color": "#2d7be5" }],
  "charts": [{ "title": "Ticket Volume", "image": "data:image/png;base64,..." }]
}
```
Response: `application/pdf` stream

## Notes
- All authenticated endpoints rely on session cookies.
- Admin-only: most settings & reports endpoints.
- Oracle: some KPIs depend on timestamps (SYSDATE) and columns: CREATED_AT, UPDATED_AT, RESPONSE_DUE, RESOLUTION_DUE. 