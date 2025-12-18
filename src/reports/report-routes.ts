import express, { Request, Response } from 'express';
import { JpgReportGenerator } from './jpg-report';
import { ExcelReportGenerator } from './excel-report';
import { Logger } from '../utils/logger';

const router = express.Router();

function getJpgGenerator(): JpgReportGenerator {
  return new JpgReportGenerator();
}

function getExcelGenerator(): ExcelReportGenerator {
  return new ExcelReportGenerator();
}

// GET /reports/daily/jpg?date=2025-01-16
router.get('/daily/jpg', async (req: Request, res: Response) => {
  try {
    const { date } = req.query;

    if (!date || typeof date !== 'string') {
      res.status(400).json({
        error: 'Date parameter is required in YYYY-MM-DD format'
      });
      return;
    }

    // Validate date format
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      res.status(400).json({
        error: 'Invalid date format. Use YYYY-MM-DD'
      });
      return;
    }

    Logger.info(`API request for daily JPG report: ${date}`);

    const jpgGenerator = getJpgGenerator();
    const screenshot = await jpgGenerator.generateDailyReport(date);

    res.set({
      'Content-Type': 'image/jpeg',
      'Content-Disposition': `attachment; filename="daily-report-${date}.jpg"`
    });

    res.send(screenshot);

  } catch (error) {
    Logger.error('Error generating daily JPG report', error as Error);
    res.status(500).json({
      error: 'Failed to generate daily report',
      message: (error as Error).message
    });
  }
});

// GET /reports/monthly/excel?month=2025-01
router.get('/monthly/excel', async (req: Request, res: Response) => {
  try {
    const { month } = req.query;

    if (!month || typeof month !== 'string') {
      res.status(400).json({
        error: 'Month parameter is required in YYYY-MM format'
      });
      return;
    }

    // Validate month format
    if (!/^\d{4}-\d{2}$/.test(month)) {
      res.status(400).json({
        error: 'Invalid month format. Use YYYY-MM'
      });
      return;
    }

    Logger.info(`API request for monthly Excel report: ${month}`);

    const excelGenerator = getExcelGenerator();
    const excelBuffer = await excelGenerator.generateMonthlyReportByString(month);

    res.set({
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="monthly-report-${month}.xlsx"`
    });

    res.send(excelBuffer);

  } catch (error) {
    Logger.error('Error generating monthly Excel report', error as Error);
    res.status(500).json({
      error: 'Failed to generate monthly report',
      message: (error as Error).message
    });
  }
});

// GET /reports/health - Health check endpoint
router.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'reports',
    timestamp: new Date().toISOString()
  });
});

export default router;