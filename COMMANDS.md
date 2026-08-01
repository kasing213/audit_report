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

# Run in watch mode
npm run watch

# Run production build
npm start
```

### Testing & QA
```bash
# Type checking (no emit)
npm run typecheck

# Lint source
npm run lint
```

Manual smoke test (Telegram):
- Send a strict header (see "Sales Entry Flow" below)
- Choose a reason code (A–J) and optional note
- Verify the record shows in daily JPG or monthly Excel reports

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

### User Commands (Send in Telegram Chat)

#### `/help` - Complete Documentation & Guide
Get comprehensive help documentation with examples and chat configuration info.

**Usage:**
```
/help
```

**Features:**
- Complete HDR format examples with validation rules
- All available commands and their usage
- Chat ID configuration (Audit vs Summary channels)
- Reason codes (A-J) with translations
- System information and automated report schedules
- Troubleshooting guidance

**Available in:** All chats

---

#### `/report [YYYY-MM]` - Generate Monthly Excel Reports
Generate and download monthly Excel reports on-demand.

**Usage:**
```
/report           # Current month
/report 2025-01   # Specific month
/report 2024-12   # Previous months
```

**Features:**
- Two Excel sheets: Customer Cases Summary + Event History
- Complete audit trail with all interactions
- Phone-based customer aggregation
- Source tracking (Telegram message IDs, AI models)
- Automatic filename generation
- Progress indicator during generation

**Restrictions:**
- Cannot request future months
- Large reports may take time to generate

**Available in:** All chats

---

#### `/customers` - Customer List by Follower + Month
Get a customer list for a specific follower and month.

**Usage:**
```
/customers
```

**Bot prompts:**
- `Which follower? (example: Srey Sros)`
- `Which month? (YYYY-MM or type "current")`

**Rate Limit:** 1 request per user every 2 minutes

**IMPORTANT:** Only works in Summary Chat (configured via SUMMARY_CHAT_ID)

---

#### Sales Entry Flow (Strict Header)
Send a strict header form. The bot validates it, then forces A–J reason selection.

**Header format (required):**
```
HDR
DATE: 2025-01-16
NAME: Heng Chita
PHONE: 093724678
PAGE: Sun TV
FOLLOWER: Srey Sros
```

**Flow:**
1) Header accepted → bot sends A–J options (mandatory)
2) User selects ONE reason (A–J only)
3) Bot asks for optional note (reply `-` to skip)

**Bot Response:**
- Invalid header → shows the required format
- Invalid reason → `សូមជ្រើសរើសតែមួយ (A–J) ប៉ុណ្ណោះ`

---

### Setup Commands (Admin)

#### Get Chat ID (for setup)
1. Add bot to your group/chat
2. Send any message
3. Check: `https://api.telegram.org/bot<BOT_TOKEN>/getUpdates`
4. Find the chat ID in the response

#### Test Bot Connectivity
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
# Core Configuration
DATABASE_URL=mongodb+srv://...           # MongoDB connection
TELEGRAM_BOT_TOKEN=123456:ABC...         # Telegram bot token
OPENAI_API_KEY=sk-proj-...              # OpenAI API key (optional)
OPENAI_MODEL=gpt-4o-mini                # AI model for parsing
TIMEZONE=Asia/Phnom_Penh                # Timezone for scheduling (Cambodia)

# Chat Configuration (Required)
AUDIT_CHAT_ID=-1002345678901            # Automated reports destination
SUMMARY_CHAT_ID=-1002345678902          # User interaction chat

# Feature Toggles (Optional)
ENABLE_HELP_COMMAND=true                # Enable /help command
ENABLE_MONTHLY_REPORTS=true             # Enable monthly automation

# Backwards Compatibility
REPORT_CHAT_ID=-1002345678901           # Fallback for AUDIT_CHAT_ID
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
- **Target**: Chat specified in `AUDIT_CHAT_ID`
- **Content**: Previous day's sales cases as JPG
- **Format**: Image with summary statistics

### Monthly Report Schedule (NEW)
- **Time**: 1st day of month at 12:01 AM
- **Timezone**: Set via `TIMEZONE` env var
- **Target**: Chat specified in `AUDIT_CHAT_ID`
- **Content**: Previous month's complete data as Excel
- **Format**: Two sheets (Cases Summary + Event History)
- **Toggle**: Can be disabled with `ENABLE_MONTHLY_REPORTS=false`

### Manual Report Triggers
```bash
# Via Telegram commands (recommended)
/report           # Current month Excel
/report 2025-01   # Specific month Excel

# Via API endpoints
curl "http://localhost:3001/reports/daily/jpg?date=YYYY-MM-DD"
curl "http://localhost:3001/reports/monthly/excel?month=YYYY-MM"
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
| `/help` (Telegram) | Show bot documentation |
| `/report` (Telegram) | Generate monthly Excel |
| `/customers` (Telegram) | Get customer lists |

---

**System Status URL**: http://localhost:3001/health
**Daily Report API**: http://localhost:3001/reports/daily/jpg?date=YYYY-MM-DD
**Monthly Report API**: http://localhost:3001/reports/monthly/excel?month=YYYY-MM

## 🆕 New Features Summary

### Enhanced Telegram Bot Commands
- **`/help`** - In-chat comprehensive documentation
- **`/report [YYYY-MM]`** - On-demand monthly Excel generation
- **Improved `/customers`** - Now restricted to Summary Chat

### Automated Monthly Reports
- **Schedule**: 1st day of month at 12:01 AM
- **Format**: Excel with 2 sheets (Cases + Events)
- **Delivery**: AUDIT_CHAT_ID via Telegram
- **Toggle**: ENABLE_MONTHLY_REPORTS environment variable

### Chat Separation
- **AUDIT_CHAT_ID**: Automated daily JPG + monthly Excel reports
- **SUMMARY_CHAT_ID**: User interactions, /customers command only

For support, check logs, use `/help` command, and ensure all environment variables are properly configured.
