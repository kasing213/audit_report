# Railway Deployment Guide

## Prerequisites
- Railway account (https://railway.app)
- GitHub repository pushed to remote

## Deployment Steps

### 1. Create a New Project on Railway
1. Go to https://railway.app
2. Click "New Project"
3. Select "Deploy from GitHub repo"
4. Choose your repository: `kasing213/audit_report`

### 2. Configure Environment Variables
In Railway dashboard, go to Variables tab and add:

```
DATABASE_URL=mongodb+srv://...
TELEGRAM_BOT_TOKEN=your_bot_token
OPENAI_API_KEY=your_openai_key
OPENAI_MODEL=gpt-3.5-turbo-0125
REPORT_CHAT_ID=-1002345678901
TIMEZONE=Asia/Kuala_Lumpur
```

**IMPORTANT:** Do not copy values from `.env` file directly. Use your production credentials.

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
Ensure the REPORT_CHAT_ID is set correctly and the bot can send reports.

## API Endpoints

Once deployed, you can access:
- Health check: `GET https://your-app.railway.app/health`
- Daily report: `GET https://your-app.railway.app/reports/daily/jpg?date=YYYY-MM-DD`
- Monthly report: `GET https://your-app.railway.app/reports/monthly/excel?month=YYYY-MM`

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
- Verify DATABASE_URL is correct
- Check MongoDB Atlas network access (allow Railway IPs or use 0.0.0.0/0)
- Ensure database user has correct permissions

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
