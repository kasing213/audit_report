import { Document } from 'mongodb';

/**
 * Helper function to calculate month date range
 * @param month Format: "YYYY-MM" or "current"
 * @returns Object with startDate and endDate in YYYY-MM-DD format
 */
export function getMonthDateRange(month: string): { startDate: string; endDate: string } {
  let year: number;
  let monthNum: number;

  if (month === 'current') {
    const now = new Date();
    year = now.getFullYear();
    monthNum = now.getMonth() + 1;
  } else {
    const [yearStr, monthStr] = month.split('-');
    year = parseInt(yearStr, 10);
    monthNum = parseInt(monthStr, 10);
  }

  const startDate = `${year}-${String(monthNum).padStart(2, '0')}-01`;

  // Calculate last day of month
  const lastDay = new Date(year, monthNum, 0).getDate();
  const endDate = `${year}-${String(monthNum).padStart(2, '0')}-${String(lastDay).padStart(2, '0')}`;

  return { startDate, endDate };
}

/**
 * Build aggregation pipeline for cases by follower and month
 * Groups events by phone number to create customer case views
 * @param follower Staff member name
 * @param month Format: "YYYY-MM" or "current"
 * @returns MongoDB aggregation pipeline
 */
export function buildCasesByFollowerAndMonthPipeline(follower: string, month: string): Document[] {
  const { startDate, endDate } = getMonthDateRange(month);

  return [
    // Stage 1: Filter by follower + month
    {
      $match: {
        follower: follower,
        date: { $gte: startDate, $lte: endDate }
      }
    },

    // Stage 2: Sort by phone, then date/time (for $first/$last aggregation)
    {
      $sort: {
        'customer.phone': 1,
        date: 1,
        created_at: 1
      }
    },

    // Stage 3: Group by phone to create cases
    {
      $group: {
        _id: '$customer.phone',
        first_contact_date: { $first: '$date' },
        last_update_date: { $last: '$date' },
        current_name: { $last: '$customer.name' },
        current_page: { $last: '$page' },
        current_follower: { $last: '$follower' },
        current_reason_code: { $last: '$reason_code' },
        current_status_text: { $last: '$status_text' },
        history: {
          $push: {
            date: '$date',
            status: { $ifNull: ['$reason_code', '$status_text'] },
            reason_code: '$reason_code',
            note: '$note',
            created_at: '$created_at'
          }
        },
        total_events: { $sum: 1 }
      }
    },

    // Stage 4: Reshape output to match CustomerCase interface
    {
      $project: {
        _id: 0,
        phone: '$_id',
        name: '$current_name',
        page: '$current_page',
        follower: '$current_follower',
        first_contact_date: 1,
        last_update_date: 1,
        current_status: { $ifNull: ['$current_reason_code', '$current_status_text'] },
        current_reason_code: 1,
        history: 1,
        total_events: 1
      }
    },

    // Stage 5: Sort by last update (most recent first)
    {
      $sort: { last_update_date: -1 }
    }
  ];
}

/**
 * Build aggregation pipeline for monthly cases summary (all followers)
 * Used for Excel export "Cases Summary" sheet
 * @param year Year number (e.g., 2025)
 * @param month Month number (1-12)
 * @returns MongoDB aggregation pipeline
 */
export function buildMonthlyCasesSummaryPipeline(year: number, month: number): Document[] {
  const monthStr = `${year}-${String(month).padStart(2, '0')}`;
  const { startDate, endDate } = getMonthDateRange(monthStr);

  return [
    // Stage 1: Filter by month (all followers)
    {
      $match: {
        date: { $gte: startDate, $lte: endDate }
      }
    },

    // Stage 2: Sort by phone, then date/time
    {
      $sort: {
        'customer.phone': 1,
        date: 1,
        created_at: 1
      }
    },

    // Stage 3: Group by phone to create cases
    {
      $group: {
        _id: '$customer.phone',
        first_contact_date: { $first: '$date' },
        last_update_date: { $last: '$date' },
        current_name: { $last: '$customer.name' },
        current_page: { $last: '$page' },
        current_follower: { $last: '$follower' },
        current_reason_code: { $last: '$reason_code' },
        current_status_text: { $last: '$status_text' },
        history: {
          $push: {
            date: '$date',
            status: { $ifNull: ['$reason_code', '$status_text'] },
            reason_code: '$reason_code',
            note: '$note',
            created_at: '$created_at'
          }
        },
        total_events: { $sum: 1 }
      }
    },

    // Stage 4: Reshape output
    {
      $project: {
        _id: 0,
        phone: '$_id',
        name: '$current_name',
        page: '$current_page',
        follower: '$current_follower',
        first_contact_date: 1,
        last_update_date: 1,
        current_status: { $ifNull: ['$current_reason_code', '$current_status_text'] },
        current_reason_code: 1,
        history: 1,
        total_events: 1
      }
    },

    // Stage 5: Sort by last update (most recent first)
    {
      $sort: { last_update_date: -1 }
    }
  ];
}
