# WhatsApp WordPress Newsroom

Foundation for a production-grade newsroom publishing system. The repository is a pnpm workspace containing a modular NestJS monolith, reserved web and shared-package boundaries, Prisma connectivity infrastructure, and architecture documentation.

This round intentionally contains no newsroom workflows or domain persistence models.

## Prerequisites

- Node.js 22 or newer
- pnpm 10 or newer
- PostgreSQL (required when database connectivity is exercised)

## Setup

```bash
pnpm install
cp .env.example .env
pnpm prisma:generate
pnpm dev
```

The API listens on `PORT` and exposes `GET /health`. See `docs/` for architectural constraints and the staged roadmap.
