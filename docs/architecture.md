# Architecture (Implementation Start)

## Implemented in this first cut

- Monorepo with workspaces
- Realtime Socket.IO server
- In-memory room registry (temporary)
- Create room / join room / rejoin room flows
- Start hand flow with strict guards
- Host-only blind updates
- Action submission validation hooks
- Static web client served directly by the backend
- Browser session persistence for rejoin after refresh

## Next

- Replace in-memory store with Postgres + Redis
- Add magic-link auth with persistent session identity
- Add room recovery TTL and event log projection
- Add complete betting-round logic and side-pot handling
- Build mobile-first frontend
