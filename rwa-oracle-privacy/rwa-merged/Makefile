# ============================================================
#  RWA Oracle — Production Makefile
# ============================================================

.PHONY: help setup build start stop restart logs db-migrate db-seed db-studio \
        docker-build docker-up docker-down docker-logs typecheck

help:
	@echo "RWA Oracle — Available Commands"
	@echo ""
	@echo "  Development:"
	@echo "    make setup          First-time setup (install, migrate, seed, build)"
	@echo "    make dev            Run feeder + admin server in dev mode"
	@echo "    make typecheck      TypeScript type check (no emit)"
	@echo ""
	@echo "  Production (local):"
	@echo "    make build          Compile TypeScript"
	@echo "    make start          Start feeder + admin server"
	@echo "    make start-server   Start admin server only"
	@echo "    make start-feeder   Start feeder only"
	@echo ""
	@echo "  Database:"
	@echo "    make db-migrate     Run pending migrations"
	@echo "    make db-seed        Seed admin user + assets"
	@echo "    make db-studio      Open Prisma Studio"
	@echo "    make db-reset       Reset DB and re-seed (DESTRUCTIVE)"
	@echo ""
	@echo "  Docker:"
	@echo "    make docker-build   Build Docker images"
	@echo "    make docker-up      Start all services in Docker"
	@echo "    make docker-down    Stop all Docker services"
	@echo "    make docker-logs    Tail Docker logs"

setup:
	bash scripts/setup.sh

build:
	npm run build

typecheck:
	npm run typecheck

dev:
	npm run dev:all

start:
	npm run start:all

start-server:
	npm run start:server

start-feeder:
	npm run start

db-migrate:
	npm run db:migrate

db-seed:
	npm run db:seed

db-studio:
	npm run db:studio

db-reset:
	@echo "WARNING: This will delete all data. Press Ctrl+C to cancel."
	@sleep 5
	npm run db:reset

docker-build:
	docker-compose build

docker-up:
	docker-compose up -d
	@echo "Services started. Admin API at http://localhost:4000"

docker-down:
	docker-compose down

docker-logs:
	docker-compose logs -f

docker-up-prod:
	docker-compose --profile prod up -d

restart:
	docker-compose restart
