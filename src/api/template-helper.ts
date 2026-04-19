import * as handlebars from 'handlebars';
import * as fs from 'fs/promises';
import * as path from 'path';

const TEMPLATES_DIR = path.join(__dirname, '..', 'reports', 'templates');
const PARTIALS_DIR = path.join(TEMPLATES_DIR, 'partials');

const compileCache = new Map<string, HandlebarsTemplateDelegate>();
let partialsReady: Promise<void> | null = null;

async function registerPartialsOnce(): Promise<void> {
  if (partialsReady) return partialsReady;
  partialsReady = (async () => {
    const files = ['head.hbs', 'nav.hbs', 'footer.hbs'];
    for (const file of files) {
      const name = path.basename(file, '.hbs');
      const content = await fs.readFile(path.join(PARTIALS_DIR, file), 'utf-8');
      handlebars.registerPartial(name, content);
    }
    handlebars.registerHelper('eq', (a: unknown, b: unknown) => a === b);
  })();
  return partialsReady;
}

export async function renderPage(templateName: string, data: Record<string, unknown>): Promise<string> {
  await registerPartialsOnce();
  let compiled = compileCache.get(templateName);
  if (!compiled) {
    const filePath = path.join(TEMPLATES_DIR, `${templateName}.hbs`);
    const source = await fs.readFile(filePath, 'utf-8');
    compiled = handlebars.compile(source);
    compileCache.set(templateName, compiled);
  }
  return compiled(data);
}
