import dotenv from 'dotenv';
import DatabaseConnection from '../src/database/connection';
dotenv.config();
async function main() {
  const db = DatabaseConnection.getInstance(); await db.connect();
  const raw = db.getDb();
  const counts = await raw.collection('outreach_proposals').aggregate([{ $group: { _id: '$status', c: { $sum: 1 } } }]).toArray();
  console.log('proposal counts:', JSON.stringify(counts));
  const mine = await raw.collection('outreach_proposals').find({ customer_phone: '+85570597666' }).sort({ created_at: -1 }).limit(5).toArray();
  console.log('+85570597666 recent:', mine.map((m:any)=>({ status:m.status, by:m.approved_by, sent:m.sent_at, fail:m.failed_reason })));
  const ws:any = await raw.collection('outreach_worker_state').findOne({});
  console.log('worker_state:', JSON.stringify({ claims_today: ws?.claims_today, day: ws?.claims_day ?? ws?.day, paused: ws?.paused, last_heartbeat: ws?.last_heartbeat }));
  await db.disconnect();
}
main().catch(e=>{console.error(e);process.exit(1);});
