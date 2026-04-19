import express, { Request, Response } from 'express';
import multer from 'multer';
import { authMiddleware, getSessionUser } from './auth-middleware';
import { BrainRepository, BrainDocument } from '../brain/brain-repository';
import { extractPdfText } from '../brain/pdf-extractor';
import { Logger } from '../utils/logger';

const router = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

const MAX_TEXT_CHARS = 80_000;

router.use(authMiddleware);

// POST /crm/api/brain — upload a PDF
router.post('/', upload.single('file'), async (req: Request, res: Response) => {
  try {
    if (!req.file) { res.status(400).json({ error: 'No file uploaded' }); return; }
    const filename = req.file.originalname;
    if (!filename.toLowerCase().endsWith('.pdf')) {
      res.status(400).json({ error: 'Only .pdf files accepted' });
      return;
    }

    const title = (req.body?.title || filename).toString().trim().slice(0, 200) || filename;
    const notes = req.body?.notes ? String(req.body.notes).trim().slice(0, 2000) : null;

    const text = await extractPdfText(req.file.buffer);
    if (!text) {
      res.status(400).json({ error: 'Could not extract any text from PDF' });
      return;
    }
    if (text.length > MAX_TEXT_CHARS) {
      res.status(400).json({ error: `Extracted text too large (${text.length} chars, max ${MAX_TEXT_CHARS})` });
      return;
    }

    const doc: BrainDocument = {
      title,
      filename,
      uploaded_at: new Date(),
      uploaded_by: getSessionUser(req) || 'unknown',
      active: true,
      raw_text: text,
      char_count: text.length,
      notes,
    };
    const id = await new BrainRepository().insert(doc);
    res.json({ id, title, filename, char_count: text.length, active: true });
  } catch (err) {
    Logger.error('brain upload failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /crm/api/brain — list all
router.get('/', async (_req: Request, res: Response) => {
  try {
    const repo = new BrainRepository();
    const docs = await repo.listAll();
    const totalActive = await repo.totalActiveChars();
    const stripped = docs.map((d) => ({
      _id: d._id,
      title: d.title,
      filename: d.filename,
      uploaded_at: d.uploaded_at,
      uploaded_by: d.uploaded_by,
      active: d.active,
      char_count: d.char_count,
      notes: d.notes,
      preview: (d.raw_text || '').slice(0, 300),
    }));
    res.json({ documents: stripped, total_active_chars: totalActive });
  } catch (err) {
    Logger.error('brain list failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// GET /crm/api/brain/:id/text — fetch full extracted text
router.get('/:id/text', async (req: Request, res: Response) => {
  try {
    const doc = await new BrainRepository().getById(req.params.id);
    if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ raw_text: doc.raw_text });
  } catch (err) {
    Logger.error('brain text fetch failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// PATCH /crm/api/brain/:id — toggle active / edit title / notes
router.patch('/:id', express.json(), async (req: Request, res: Response) => {
  try {
    const body = req.body || {};
    const updates: Partial<Pick<BrainDocument, 'active' | 'title' | 'notes'>> = {};
    if (typeof body.active === 'boolean') updates.active = body.active;
    if (typeof body.title === 'string') updates.title = body.title.trim().slice(0, 200);
    if (typeof body.notes === 'string' || body.notes === null) {
      updates.notes = body.notes === null ? null : String(body.notes).trim().slice(0, 2000);
    }
    if (Object.keys(updates).length === 0) { res.status(400).json({ error: 'Nothing to update' }); return; }

    const ok = await new BrainRepository().update(req.params.id, updates);
    if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ success: true });
  } catch (err) {
    Logger.error('brain patch failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

// DELETE /crm/api/brain/:id
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const ok = await new BrainRepository().remove(req.params.id);
    if (!ok) { res.status(404).json({ error: 'Not found' }); return; }
    res.json({ success: true });
  } catch (err) {
    Logger.error('brain delete failed', err as Error);
    res.status(500).json({ error: (err as Error).message });
  }
});

export default router;
