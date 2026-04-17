# Railway Deployment Guide

## Prerequisites
- Railway account (https://railway.app)
- GitHub repository pushed to remote
- MongoDB Atlas account with database created

## IMPORTANT: MongoDB Atlas Network Access Setup

**BEFORE deploying to Railway**, you MUST whitelist Railway's IP addresses in MongoDB Atlas:

1. Go to MongoDB Atlas (https://cloud.mongodb.com)
2. Select your cluster
3. Click "Network Access" in the left sidebar
4. Click "Add IP Address"
5. Click "Allow Access from Anywhere"
6. Or manually add: `0.0.0.0/0` (CIDR)
7. Click "Confirm"

**Note:** `0.0.0.0/0` allows connections from any IP. For production, you may want to restrict this to Railway's specific IP ranges, but this requires Railway's NAT gateway feature on paid plans.

## Deployment Steps

### 1. Create a New Project on Railway
1. Go to https://railway.app
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your repository: `kasing213/audit_report`

### 2. Configure Environment Variables
In Railway dashboard, go to Variables tab and add:

```
# Core Configuration
DATABASE_URL=mongodb+srv://...
TELEGRAM_BOT_TOKEN=your_bot_token
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-4o-mini
TIMEZONE=Asia/Kuala_Lumpur

# Chat Configuration (Required)
AUDIT_CHAT_ID=-1002345678901
SUMMARY_CHAT_ID=-1002345678902

# Feature Toggles (Optional)
ENABLE_HELP_COMMAND=true
ENABLE_MONTHLY_REPORTS=true

# Backwards Compatibility (Fallback)
REPORT_CHAT_ID=-1002345678901

# Meta Lead Ads Integration (Optional)
# Ingress webhook at /webhooks/meta-leads — set on Meta app dashboard
META_APP_SECRET=your_meta_app_secret
META_VERIFY_TOKEN=your_chosen_verify_token
META_PAGE_ACCESS_TOKEN=your_page_access_token

# Meta Conversions API (CAPI) — outbound temperature sync
META_PIXEL_ID=1234567890
META_CAPI_TOKEN=your_capi_access_token
```

**IMPORTANT:**
- Do not copy values from `.env` file directly. Use your production credentials.
- `AUDIT_CHAT_ID`: Where daily JPG reports and monthly Excel reports are sent
- `SUMMARY_CHAT_ID`: Where `/customers` command works (user interaction chat)
- Both chat IDs are required for full functionality

### 3. Railway Will Automatically:
- Detect the `Dockerfile`
- Build the Docker image
- Deploy the application
- Assign a public URL
- Set up the PORT environment variable

### 4. Verify Deployment
- Check the deployment logs in Railway dashboard
- Visit: `https://your-app.railway.app/health`
- You should see a JSON response with status "ok"

## Post-Deployment

### Monitor Logs
```bash
# Install Railway CLI
npm i -g @railway/cli

# Login
railway login

# View logs
railway logs
```

### Verify Telegram Bot
Send a test message to your bot on Telegram to verify it's working.

### Check Daily Reports
Ensure the AUDIT_CHAT_ID is set correctly and the bot can send reports.

### Verify New Commands
Test the new Telegram commands:
- Send `/help` to see comprehensive documentation
- Send `/report` or `/report YYYY-MM` to generate monthly Excel reports
- Send `/customers` (only works in SUMMARY_CHAT_ID)

### Check Monthly Reports
Monthly Excel reports are automatically sent on the 1st day of each month at 12:01 AM to the AUDIT_CHAT_ID.

## API Endpoints

Once deployed, you can access:
- Health check: `GET https://your-app.railway.app/health`
- Daily report: `GET https://your-app.railway.app/reports/daily/jpg?date=YYYY-MM-DD`
- Monthly report: `GET https://your-app.railway.app/reports/monthly/excel?month=YYYY-MM`

## New Features Added

### Telegram Bot Commands
- **`/help`** - Complete documentation in English/Khmer with examples
- **`/report [YYYY-MM]`** - Generate monthly Excel reports on-demand
- **`/customers`** - Customer lists (restricted to SUMMARY_CHAT_ID)

### Automated Reports
- **Daily JPG Reports**: 11:59 PM → AUDIT_CHAT_ID
- **Monthly Excel Reports**: 1st day 12:01 AM → AUDIT_CHAT_ID (NEW)

### Environment Variables
- **`AUDIT_CHAT_ID`**: Primary chat for automated reports
- **`SUMMARY_CHAT_ID`**: Chat for user interactions (/customers command)
- **`ENABLE_HELP_COMMAND`**: Toggle help command (default: true)
- **`ENABLE_MONTHLY_REPORTS`**: Toggle monthly automation (default: true)

## Troubleshooting

### Build Fails
- Check Railway build logs for errors
- Ensure all dependencies are in `package.json`
- Verify Dockerfile syntax

### Bot Not Responding
- Check TELEGRAM_BOT_TOKEN is correct
- Verify bot is not running elsewhere (only one instance can run at a time)
- Check Railway logs for errors

### Database Connection Issues
- **MOST COMMON:** MongoDB Atlas blocking connection - add `0.0.0.0/0` to Network Access (see setup section above)
- Verify DATABASE_URL is correct and doesn't have any extra spaces
- Ensure database user has correct permissions (readWrite role)
- Check MongoDB Atlas cluster is running (not paused)

### Puppeteer Issues
- The Dockerfile includes all necessary Chromium dependencies
- If you see Chromium errors, check Railway logs
- Ensure sufficient memory allocation in Railway settings

## Scaling
Railway automatically handles:
- Automatic restarts on failure
- Memory and CPU allocation
- HTTPS certificates

## Cost
Railway offers:
- Free tier with $5 credit/month
- Usage-based pricing after free tier
- Monitor usage in Railway dashboard
