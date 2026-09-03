import { NextResponse } from 'next/server';
import { promises as fs } from 'fs';
import path from 'path';

/**
 * POST /api/settings/keys
 *
 * Saves API key credentials to .env.local so the project runs on any machine.
 * This is a development-only convenience endpoint for hackathon judges.
 */
export async function POST(req: Request) {
  try {
    const body = await req.json();
    const {
      GEMINI_API_KEY,
      RAZORPAY_KEY_ID,
      RAZORPAY_KEY_SECRET,
      SUPABASE_URL,
      SUPABASE_ANON_KEY,
      SUPABASE_SERVICE_ROLE_KEY,
    } = body;

    // Build .env.local content
    const envContent = `# FinanceOS — API Credentials
# Auto-generated via Settings → API Keys & Credentials

# Supabase Database Configuration
SUPABASE_URL=${SUPABASE_URL || ''}
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY || ''}
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY || ''}

# Razorpay Test / Live API Credentials
RAZORPAY_KEY_ID=${RAZORPAY_KEY_ID || ''}
RAZORPAY_KEY_SECRET=${RAZORPAY_KEY_SECRET || ''}

# AI Model Provider Credentials
GEMINI_API_KEY=${GEMINI_API_KEY || ''}

# Credential Encryption Key for At-Rest Secret Vault
CREDENTIAL_ENCRYPTION_KEY=9f8e7d6c5b4a3928170e9f8e7d6c5b4a3928170e9f8e7d6c5b4a3928170e9f8e

# Operational Settings
LOG_LEVEL=info
NODE_ENV=development
`;

    // Write to .env.local at project root
    const projectRoot = process.cwd();
    const envPath = path.join(projectRoot, '.env.local');
    await fs.writeFile(envPath, envContent, 'utf-8');

    return NextResponse.json({
      success: true,
      message: 'API keys saved to .env.local. Restart the dev server (npm run dev) for changes to take effect.',
      savedAt: new Date().toISOString(),
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Failed to save keys';
    console.error('Save keys error:', err);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

/**
 * GET /api/settings/keys
 *
 * Returns masked versions of currently configured keys (for display in UI).
 * Never returns full keys for security.
 */
export async function GET() {
  const mask = (val: string | undefined): string => {
    if (!val || val.length < 8) return val ? '••••' : '(not set)';
    return val.slice(0, 6) + '••••' + val.slice(-4);
  };

  return NextResponse.json({
    GEMINI_API_KEY: mask(process.env.GEMINI_API_KEY),
    RAZORPAY_KEY_ID: mask(process.env.RAZORPAY_KEY_ID),
    RAZORPAY_KEY_SECRET: mask(process.env.RAZORPAY_KEY_SECRET),
    SUPABASE_URL: mask(process.env.SUPABASE_URL),
    SUPABASE_ANON_KEY: mask(process.env.SUPABASE_ANON_KEY),
    SUPABASE_SERVICE_ROLE_KEY: mask(process.env.SUPABASE_SERVICE_ROLE_KEY),
  });
}
