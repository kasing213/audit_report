#!/bin/bash

echo "🔄 Starting Audit Sales Bot..."
echo "================================"

# Kill any existing bot processes
echo "🛑 Stopping existing bot processes..."
pkill -f "ts-node src/index.ts" 2>/dev/null || true
pkill -f "node.*audit-sales" 2>/dev/null || true

# Wait for processes to terminate
sleep 3

echo "✅ Previous processes stopped"

# Check environment variables
echo ""
echo "🔍 Checking configuration..."

# Load .env file if it exists
if [ -f ".env" ]; then
    export $(cat .env | grep -v '^#' | xargs)
fi

if [ -n "$DATABASE_URL" ]; then
    echo "✅ MongoDB connection configured"
else
    echo "❌ DATABASE_URL not found"
    exit 1
fi

if [ -n "$TELEGRAM_BOT_TOKEN" ]; then
    echo "✅ Telegram Bot Token configured"
else
    echo "❌ TELEGRAM_BOT_TOKEN not found"
    exit 1
fi

if [ -n "$OPENAI_API_KEY" ]; then
    echo "✅ OpenAI API Key configured"
else
    echo "⚠️  OpenAI API Key not found (optional)"
fi

echo ""
echo "🚀 Starting bot..."
echo "================================"

# Start the bot
npm run dev