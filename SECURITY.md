# Security Notes

- Use strong `SESSION_SECRET` in production; store in environment.
- Serve over HTTPS; set session cookie `{ secure: true, sameSite: 'none' }` in prod.
- Do not commit secrets. Use `.env` and add `.env` to `.gitignore`.
- Rate-limit auth endpoints if exposed publicly (use a proxy or middleware).
- Validate and sanitize input; prepared statements are used via oracledb bind params.
- Restrict admin-only endpoints (`requireAdmin`); verify session on all API calls.
- Keep dependencies updated; run `npm audit` regularly. 