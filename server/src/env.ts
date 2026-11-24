import { config } from 'dotenv';
import { fileURLToPath } from 'node:url';

// npm workspaces runs server scripts from server/, while .env lives at repo root.
config({ path: fileURLToPath(new URL('../../.env', import.meta.url)) });
