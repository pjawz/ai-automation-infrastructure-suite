#!/bin/bash
# Exit immediately if a command exits with a non-zero status.
set -e

# --- Configuration & Checks ---

# Check if .env file exists
if [ ! -f ".env" ]; then
    echo "Error: .env file not found. Please create it with your PORKBUN_API_KEY, PORKBUN_SECRET_API_KEY, DOMAIN, and other necessary variables." >&2
    exit 1
fi

# Check if node and npm are installed
if ! command -v node &> /dev/null || ! command -v npm &> /dev/null; then
    echo "Error: Node.js and npm are required. Please install them." >&2
    exit 1
fi

# Check if docker is installed and running
if ! command -v docker &> /dev/null || ! docker info &> /dev/null; then
   echo "Error: Docker is not installed or the Docker daemon is not running." >&2
   exit 1
fi

# Check if docker compose command exists (supports both v1 and v2 syntax)
if command -v docker-compose &> /dev/null; then
    COMPOSE_CMD="docker-compose"
elif docker compose version &> /dev/null; then
    COMPOSE_CMD="docker compose"
else
    echo "Error: Neither 'docker-compose' (v1) nor 'docker compose' (v2) command found." >&2
    exit 1
fi

# --- Script Execution ---

echo "--- Step 1: Installing Node.js dependencies ---"
if [ -d "node_modules" ]; then
  echo "node_modules directory exists, running 'npm install' to ensure dependencies are up to date..."
else
  echo "node_modules directory not found, running 'npm install'..."
fi
npm install

echo "\n--- Step 2: Running DNS Management Script ---"
node manage-dns.js

# Check the exit code of the Node script
if [ $? -ne 0 ]; then
    echo "Error: DNS Management script failed. Aborting Docker Compose startup." >&2
    exit 1
fi

echo "\n--- Step 3: Starting Docker Compose Services ---"
$COMPOSE_CMD up -d

echo "\n--- All services started successfully! ---"

exit 0 