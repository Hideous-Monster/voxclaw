import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import OpenAI from 'openai';

interface BakeConfig {
  provider: string;
  model: string;
  voice: string;
  instructions?: string;
}

interface ManifestEntry {
  phrase: string;
  filename: string;
}

interface Manifest {
  configHash: string;
  entries: Record<string, ManifestEntry[]>;
}

const REPO_ROOT = path.dirname(path.dirname(__filename));
const BAKED_DIR = path.join(REPO_ROOT, 'phrases', 'baked');
const MANIFEST_PATH = path.join(BAKED_DIR, 'manifest.json');

// Load config — actual plugin config from ~/.openclaw/openclaw.json,
// falling back to schema defaults in openclaw.plugin.json
function loadConfig(): BakeConfig {
  // Try actual runtime config first
  const runtimeConfigPath = path.join(process.env.HOME || '~', '.openclaw', 'openclaw.json');
  try {
    const runtime = JSON.parse(fs.readFileSync(runtimeConfigPath, 'utf-8'));
    const tts = runtime?.plugins?.entries?.['openclaw-discord-voice']?.config?.tts;
    if (tts?.model && tts?.voice) {
      return {
        provider: tts.provider || 'openai',
        model: tts.model,
        voice: tts.voice,
        instructions: tts.instructions || '',
      };
    }
  } catch { /* fall through to schema defaults */ }

  // Fall back to schema defaults
  const pluginConfigPath = path.join(REPO_ROOT, 'openclaw.plugin.json');
  const pluginConfig = JSON.parse(fs.readFileSync(pluginConfigPath, 'utf-8'));
  const ttsConfig = pluginConfig.configSchema?.properties?.tts?.properties ?? {};
  return {
    provider: ttsConfig.provider?.default || 'openai',
    model: ttsConfig.model?.default || 'gpt-4o-mini-tts',
    voice: ttsConfig.voice?.default || 'nova',
    instructions: '',
  };
}

// Compute SHA256 hash of phrase and return first 12 chars
function hashPhrase(phrase: string): string {
  return crypto
    .createHash('sha256')
    .update(phrase)
    .digest('hex')
    .slice(0, 12);
}

// Compute config hash from TTS settings
function computeConfigHash(config: BakeConfig): string {
  const configStr = JSON.stringify({
    provider: config.provider,
    model: config.model,
    voice: config.voice,
    instructions: config.instructions,
  });
  return crypto
    .createHash('sha256')
    .update(configStr)
    .digest('hex')
    .slice(0, 12);
}

// Read phrase file, split by newline, filter empty lines
function readPhrases(filePath: string): string[] {
  const content = fs.readFileSync(filePath, 'utf-8');
  return content
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

// Load existing manifest
function loadManifest(): Manifest | null {
  if (!fs.existsSync(MANIFEST_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf-8'));
}

// Check if phrase file already baked with matching config
function isPhraseBaked(label: string, phrase: string, configHash: string, manifest: Manifest | null): boolean {
  if (!manifest || manifest.configHash !== configHash) {
    return false;
  }
  const entries = manifest.entries[label] || [];
  return entries.some((e) => e.phrase === phrase);
}

// Get filename from manifest or compute it
function getPhraseFilename(label: string, phrase: string, manifest: Manifest | null): string {
  if (manifest) {
    const entries = manifest.entries[label] || [];
    const entry = entries.find((e) => e.phrase === phrase);
    if (entry) {
      return entry.filename;
    }
  }
  const hash = hashPhrase(phrase);
  return `${label}-${hash}.ogg`;
}

// Call OpenAI TTS API
async function synthesizePhrase(client: OpenAI, config: BakeConfig, phrase: string): Promise<Buffer> {
  const response = await client.audio.speech.create({
    model: config.model as any,
    voice: config.voice as any,
    input: phrase,
    response_format: 'opus',
  });

  // Convert response to buffer
  const buffer = await response.arrayBuffer();
  return Buffer.from(buffer);
}

// Process phrases with concurrency limit
async function processPhrases(
  client: OpenAI,
  config: BakeConfig,
  label: string,
  phrases: string[],
  configHash: string,
  manifest: Manifest | null
): Promise<Manifest> {
  const results = manifest || {
    configHash,
    entries: {},
  };

  results.entries[label] = results.entries[label] || [];

  console.log(`Baking ${label} (${phrases.length})...`);

  const concurrencyLimit = 5;
  let completed = 0;

  for (let i = 0; i < phrases.length; i += concurrencyLimit) {
    const batch = phrases.slice(i, i + concurrencyLimit);

    const promises = batch.map(async (phrase) => {
      // Check if already baked
      if (isPhraseBaked(label, phrase, configHash, results)) {
        completed++;
        return { phrase, skipped: true };
      }

      try {
        const filename = getPhraseFilename(label, phrase, results);
        const buffer = await synthesizePhrase(client, config, phrase);

        // Ensure baked directory exists
        if (!fs.existsSync(BAKED_DIR)) {
          fs.mkdirSync(BAKED_DIR, { recursive: true });
        }

        const filePath = path.join(BAKED_DIR, filename);
        fs.writeFileSync(filePath, buffer);

        // Add to manifest
        const existingIndex = results.entries[label].findIndex((e) => e.phrase === phrase);
        if (existingIndex >= 0) {
          results.entries[label][existingIndex] = { phrase, filename };
        } else {
          results.entries[label].push({ phrase, filename });
        }

        completed++;
        console.log(`[${completed}/${phrases.length}] saved ${filename}`);
        return { phrase, skipped: false };
      } catch (error) {
        completed++;
        console.warn(`[${completed}/${phrases.length}] failed to synthesize phrase: ${phrase}`);
        console.warn(`  Error: ${error instanceof Error ? error.message : String(error)}`);
        return { phrase, skipped: false, error: true };
      }
    });

    await Promise.all(promises);
  }

  return results;
}

async function main() {
  // Check for OPENAI_API_KEY
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.error('Error: OPENAI_API_KEY environment variable is not set.');
    process.exit(1);
  }

  try {
    const config = loadConfig();
    console.log(`Loaded TTS config: ${config.provider} ${config.model} (${config.voice})`);

    const configHash = computeConfigHash(config);
    const existingManifest = loadManifest();

    const client = new OpenAI({ apiKey });

    // Read phrases
    const greetings = readPhrases(path.join(REPO_ROOT, 'phrases', 'greetings.txt'));
    const checkIns = readPhrases(path.join(REPO_ROOT, 'phrases', 'check-ins.txt'));

    // Process greetings
    let manifest = await processPhrases(client, config, 'greetings', greetings, configHash, existingManifest);

    // Process check-ins
    manifest = await processPhrases(client, config, 'check-ins', checkIns, configHash, manifest);

    // Update manifest configHash (final save)
    manifest.configHash = configHash;

    // Write manifest
    if (!fs.existsSync(BAKED_DIR)) {
      fs.mkdirSync(BAKED_DIR, { recursive: true });
    }
    fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));

    const greetingCount = manifest.entries.greetings?.length || 0;
    const checkInCount = manifest.entries['check-ins']?.length || 0;
    console.log(`Done. ${greetingCount} greetings + ${checkInCount} check-ins baked.`);
  } catch (error) {
    console.error('Error during baking:', error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}

main();
