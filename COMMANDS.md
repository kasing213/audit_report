# Audit Sales System - Commands Reference

## 🚀 System Control

### Start the System
```bash
./start-bot.sh
```
**What it does:**
- Kills any existing processes
- Checks environment configuration
- Starts Telegram bot + API server + Daily scheduler
- Shows system status

### Stop the System
```bash
# Press Ctrl+C in the terminal where bot is running
# OR kill the process manually:
pkill -f "ts-node src/index.ts"
```

### Check System Status
```bash
# Check if processes are running
ps aux | grep -i "audit-sales\|ts-node"

# Check API health
curl http://localhost:3001/health
```

---

## 📊 Report Generation

### Daily JPG Reports
```bash
# Via API (manual generation)
curl "http://localhost:3001/reports/daily/jpg?date=2025-01-16" --output daily-report.jpg

# Via browser
open http://localhost:3001/reports/daily/jpg?date=2025-01-16
```

### Monthly Excel Reports
```bash
# Via API (manual download)
curl "http://localhost:3001/reports/monthly/excel?month=2025-01" --output monthly-report.xlsx

# Via browser
open http://localhost:3001/reports/monthly/excel?month=2025-01
```

### Report API Endpoints
- **Daily JPG**: `GET /reports/daily/jpg?date=YYYY-MM-DD`
- **Monthly Excel**: `GET /reports/monthly/excel?month=YYYY-MM`
- **Health Check**: `GET /reports/health`

---

## 🔧 Development & Maintenance

### Build & Development
```bash
# Install dependencies
npm install

# Type checking
npm run typecheck

# Build project
npm run build

# Run in development mode (auto-reload)
npm run dev

# Run production build
npm start
```

### Database Operations
```bash
# Check MongoDB connection (requires mongo shell)
mongosh "mongodb+srv://..." --eval "db.adminCommand('ping')"

# View collections
mongosh "mongodb+srv://..." --eval "show collections"
```

### Log Management
```bash
# View real-time logs
tail -f audit-sales.log

# Search logs for errors
grep -i error audit-sales.log

# Filter logs by date
grep "2025-01-16" audit-sales.log
```

---

## 🤖 Telegram Bot Commands

### Get Chat ID (for setup)
1. Add bot to your group/chat
2. Send any message
3. Check: `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`
4. Find the chat ID in the response

### Test Bot Connectivity
```bash
# Test bot token
curl "https://api.telegram.org/bot<BOT_TOKEN>/getMe"

# Check webhook status
curl "https://api.telegram.org/bot<BOT_TOKEN>/getWebhookInfo"
```

---

## ⚙️ Configuration

### Environment Variables (.env)
```env
DATABASE_URL=mongodb+srv://...           # MongoDB connection
TELEGRAM_BOT_TOKEN=123456:ABC...         # Telegram bot token
OPENAI_API_KEY=sk-proj-...              # OpenAI API key (optional)
OPENAI_MODEL=gpt-4o-mini                # AI model for parsing
REPORT_CHAT_ID=-1002345678901           # Chat ID for daily reports
TIMEZONE=Asia/Kuala_Lumpur              # Timezone for scheduling
```

### Update Configuration
```bash
# Edit environment file
nano .env

# Restart system to apply changes
pkill -f "ts-node src/index.ts"
./start-bot.sh
```

---

## 🛠️ Troubleshooting

### Common Issues

**Bot Not Starting:**
```bash
# Check dependencies
npm install

# Check environment
cat .env

# Check TypeScript
npm run typecheck
```

**Database Connection Issues:**
```bash
# Test MongoDB connection
curl -I "your-mongodb-url"

# Check network connectivity
ping cluster0.lhrrzre.mongodb.net
```

**Report Generation Errors:**
```bash
# Check API server
curl http://localhost:3001/health

# Test report endpoints
curl "http://localhost:3001/reports/daily/jpg?date=$(date +%Y-%m-%d)"
```

**Telegram Issues:**
```bash
# Verify bot token
curl "https://api.telegram.org/bot<TOKEN>/getMe"

# Check chat permissions
# Ensure bot is added to the target chat/group
```

### Log Debugging
```bash
# Enable debug mode (add to .env)
NODE_ENV=development

# View specific component logs
grep -i "telegram" audit-sales.log
grep -i "mongodb" audit-sales.log
grep -i "report" audit-sales.log
```

---

## 📅 Scheduled Operations

### Daily Report Schedule
- **Time**: 11:59 PM daily
- **Timezone**: Set via `TIMEZONE` env var
- **Target**: Chat specified in `REPORT_CHAT_ID`
- **Content**: Previous day's sales cases as JPG

### Manual Report Trigger
```bash
# Reports are automatically generated
# Manual triggers available via API endpoints above
```

---

## 🔄 System Updates

### Update Dependencies
```bash
npm update
npm audit fix
npm run typecheck
npm run build
```

### Deploy Changes
```bash
# After code changes
npm run typecheck
npm run build
pkill -f "ts-node src/index.ts"
./start-bot.sh
```

### Backup Data
```bash
# MongoDB backup (if needed)
mongodump --uri="your-mongodb-url"

# Environment backup
cp .env .env.backup
```

---

## 📱 Quick Reference

| Command | Purpose |
|---------|---------|
| `./start-bot.sh` | Start entire system |
| `Ctrl+C` | Stop system |
| `curl localhost:3001/health` | Check API status |
| `npm run typecheck` | Verify code |
| `grep -i error *.log` | Check for errors |

---

**System Status URL**: http://localhost:3001/health
**Daily Report API**: http://localhost:3001/reports/daily/jpg?date=YYYY-MM-DD
**Monthly Report API**: http://localhost:3001/reports/monthly/excel?month=YYYY-MM

For support, check logs and ensure all environment variables are properly configured.