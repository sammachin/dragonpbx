#!/bin/bash
# Generate .env with a random API token if it doesn't exist
ENV_FILE="$(dirname "$0")/.env"

if [ ! -f "$ENV_FILE" ]; then
  API_TOKEN=$(openssl rand -hex 32)
  echo "API_TOKEN=${API_TOKEN}" > "$ENV_FILE"
  echo "Generated new API token in .env"
else
  echo "Using existing .env"
fi

exec docker compose -f "$(dirname "$0")/docker-compose.yml" up "$@"
