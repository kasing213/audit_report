import express, { Request, Response } from 'express';
import { createSessionCookie } from './auth-middleware';

export const loginRouter = express.Router();

// GET /login — show login page
loginRouter.get('/login', (_req: Request, res: Response) => {
  const error = _req.query.error ? 'Invalid password. Please try again.' : '';
  res.send(buildLoginPage(error));
});

// POST /login — authenticate
loginRouter.post('/login', express.urlencoded({ extended: true }), (req: Request, res: Response) => {
  const token = process.env.DASHBOARD_TOKEN;
  const { password } = req.body;

  if (!token) {
    res.status(500).send('DASHBOARD_TOKEN not configured on server.');
    return;
  }

  if (password === token) {
    const cookie = createSessionCookie(token);
    res.setHeader('Set-Cookie', `audit_session=${encodeURIComponent(cookie)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${7 * 24 * 60 * 60}`);
    // Redirect to CRM dashboard after login
    res.redirect('/crm');
  } else {
    res.redirect('/login?error=1');
  }
});

// GET /logout — clear session
loginRouter.get('/logout', (_req: Request, res: Response) => {
  res.setHeader('Set-Cookie', 'audit_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
  res.redirect('/login');
});

function buildLoginPage(error: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — Audit Sales</title>
  <link href="https://fonts.googleapis.com/css2?family=Outfit:wght@400;500;600;700&display=swap" rel="stylesheet">
  <style>
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    :root {
      --bg: #0c0c0f;
      --surface: #16161a;
      --border: #2a2a32;
      --text: #e8e6e3;
      --text-muted: #72717a;
      --accent: #00d4aa;
      --accent-dim: #00d4aa22;
      --red: #ff4d6a;
    }
    body {
      font-family: 'Outfit', sans-serif;
      background: var(--bg);
      color: var(--text);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      -webkit-font-smoothing: antialiased;
    }
    .login-card {
      background: var(--surface);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 2.5rem 2rem;
      width: 100%;
      max-width: 380px;
      margin: 1rem;
    }
    .logo {
      display: flex;
      align-items: center;
      gap: 0.65rem;
      margin-bottom: 2rem;
      justify-content: center;
    }
    .logo-mark {
      width: 36px; height: 36px;
      background: var(--accent);
      border-radius: 8px;
      display: flex; align-items: center; justify-content: center;
      font-size: 0.85rem; font-weight: 700; color: var(--bg);
    }
    .logo-text {
      font-size: 1.35rem;
      font-weight: 700;
      letter-spacing: -0.02em;
    }
    label {
      display: block;
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.08em;
      color: var(--text-muted);
      font-weight: 500;
      margin-bottom: 0.4rem;
    }
    input[type="password"] {
      width: 100%;
      font-family: 'Outfit', sans-serif;
      background: var(--bg);
      border: 1px solid var(--border);
      color: var(--text);
      padding: 0.7rem 0.85rem;
      border-radius: 8px;
      font-size: 1rem;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type="password"]:focus {
      border-color: var(--accent);
      box-shadow: 0 0 0 3px var(--accent-dim);
    }
    .btn {
      width: 100%;
      margin-top: 1.25rem;
      font-family: 'Outfit', sans-serif;
      font-size: 0.95rem;
      font-weight: 600;
      padding: 0.7rem;
      border-radius: 8px;
      border: none;
      cursor: pointer;
      background: var(--accent);
      color: var(--bg);
      transition: opacity 0.15s;
    }
    .btn:hover { opacity: 0.85; }
    .error {
      background: #ff4d6a15;
      border: 1px solid #ff4d6a40;
      color: var(--red);
      padding: 0.5rem 0.75rem;
      border-radius: 6px;
      font-size: 0.85rem;
      margin-bottom: 1rem;
      text-align: center;
    }
    .footer {
      text-align: center;
      margin-top: 1.5rem;
      font-size: 0.75rem;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="logo">
      <div class="logo-mark">AS</div>
      <span class="logo-text">Audit Sales</span>
    </div>
    ${error ? `<div class="error">${error}</div>` : ''}
    <form method="POST">
      <label for="password">Password</label>
      <input type="password" id="password" name="password" placeholder="Enter admin password" autofocus required>
      <button type="submit" class="btn">Sign In</button>
    </form>
    <div class="footer">Secured access only</div>
  </div>
</body>
</html>`;
}
