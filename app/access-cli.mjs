import { randomUUID } from 'node:crypto';
import { lstat, open, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { AccessStore, freshCredentials, isToken } from './access.mjs';
import { DraftStore } from './drafts.mjs';

const APP_DIR = fileURLToPath(new URL('./', import.meta.url));
const DEFAULT_DATA_DIR = path.join(APP_DIR, 'data');
const REPO_DIR = path.resolve(APP_DIR, '..');
// A plaintext card may live outside this repository or in the ignored data
// folder only. Served, vendored and Git folders are refused everywhere.
const DENIED_DIRS = [path.join(APP_DIR, 'public'), path.join(APP_DIR, 'node_modules')];
const CARD_FORMAT = 'rehere-owner-recovery-card';
const DEFAULT_PORT = 4317;
const USAGE = 'Usage: node app/access-cli.mjs init --credentials-file <new file outside this repository or in app/data> --name <label> [--resume]';

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { resume: false };
  for (let index = 0; index < rest.length; index++) {
    const flag = rest[index];
    if (flag === '--resume') options.resume = true;
    else if ((flag === '--credentials-file' || flag === '--name') && index + 1 < rest.length) options[flag.slice(2)] = rest[++index];
    else return null;
  }
  if (command !== 'init' || !options['credentials-file'] || options.name === undefined) return null;
  return options;
}

// Compares whole path components, so a name such as "..card.json" stays inside.
const inside = (file, dir) => {
  const relative = path.relative(dir, file);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};

const real = (dir) => realpath(dir).catch(() => dir);

async function allowedDestination(file) {
  const resolved = await realpath(path.dirname(file)).then((dir) => path.join(dir, path.basename(file)), () => file);
  const candidates = [file, resolved];
  if (candidates.some((candidate) => candidate.split(path.sep).includes('.git'))) return null;
  const denied = [...DENIED_DIRS, ...(await Promise.all(DENIED_DIRS.map(real)))];
  if (candidates.some((candidate) => denied.some((dir) => inside(candidate, dir)))) return null;
  const repos = [REPO_DIR, await real(REPO_DIR)];
  const data = [DEFAULT_DATA_DIR, await real(DEFAULT_DATA_DIR)];
  const permitted = (candidate) => !repos.some((dir) => inside(candidate, dir)) || data.some((dir) => inside(candidate, dir) && candidate !== dir);
  return candidates.every(permitted) ? resolved : null;
}

function cardText(card) {
  return `${JSON.stringify({
    format: CARD_FORMAT,
    note: 'Owner access and recovery keys for one local Rehere workspace. Keep this file private; anyone holding it can sign in as the owner.',
    ...card,
  }, null, 2)}\n`;
}

async function readCard(file) {
  const info = await lstat(file);
  if (!info.isFile()) throw new Error('not a regular file');
  const card = JSON.parse(await readFile(file, 'utf8'));
  // origin and createdAt are informational and absent from cards made before
  // they were added; resume never rewrites the stored card.
  const optional = (value) => value === undefined || typeof value === 'string';
  const valid = card?.format === CARD_FORMAT && typeof card.workspace === 'string' && typeof card.requestId === 'string'
    && optional(card.origin) && optional(card.createdAt)
    && typeof card.displayName === 'string' && isToken(card.accessKey, 'access') && isToken(card.recoveryKey, 'recovery');
  if (!valid) throw new Error('not a Rehere owner card');
  return { workspace: card.workspace, requestId: card.requestId, displayName: card.displayName, accessKey: card.accessKey, recoveryKey: card.recoveryKey };
}

// Creates the single workspace owner from this machine's file system only.
// The card is written (exclusive create, mode 0600) before the owner is
// saved, so a failed save can be retried with --resume and the same keys.
// Keys are never printed. A resumed card only confirms its own setup request:
// once recovery has replaced the owner keys, its keys no longer sign in.
export async function runCli(argv, { dataDir = DEFAULT_DATA_DIR, env = process.env, out = console.log, err = console.error } = {}) {
  const options = parseArgs(argv);
  if (!options) {
    err(USAGE);
    return 2;
  }
  const name = options.name.trim();
  if (!options.resume && (!name || [...name].length > 80 || /\p{Cc}/u.test(name))) {
    err('The name must be 1 to 80 characters without control characters.');
    return 2;
  }
  const file = path.resolve(options['credentials-file']);
  // Checks the resolved folder too, so a symlinked parent cannot lead into a refused one.
  const target = await allowedDestination(file);
  if (!target) {
    err('The credentials file must be outside this repository or inside app/data, and never in app/public, app/node_modules or a .git folder.');
    return 2;
  }
  const workspace = path.resolve(dataDir);
  const access = new AccessStore({ dataDir: workspace });
  let card;
  if (options.resume) {
    try {
      card = await readCard(file);
    } catch {
      err('The credentials file could not be read as an owner card from an earlier setup. Nothing was changed.');
      return 1;
    }
    if (card.workspace !== workspace) {
      err('This card was made for a different workspace data folder. Nothing was changed.');
      return 1;
    }
  } else {
    let initialized;
    try {
      ({ initialized } = await access.state());
    } catch {
      err('The workspace access state could not be read. No card was written and nothing was changed.');
      return 1;
    }
    if (initialized) {
      err('This workspace already has an owner. No card was written and nothing was changed.');
      return 1;
    }
    // The address the server listens on with the same PORT setting.
    const port = Number(env.PORT ?? DEFAULT_PORT);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      err('PORT must be a whole number from 1 to 65535. Nothing was changed.');
      return 2;
    }
    card = {
      origin: `http://127.0.0.1:${port}`,
      createdAt: new Date().toISOString(),
      workspace,
      requestId: randomUUID(),
      displayName: name,
      ...freshCredentials(),
    };
    let handle;
    try {
      handle = await open(target, 'wx', 0o600);
      await handle.writeFile(cardText(card));
    } catch (error) {
      err(error?.code === 'EEXIST'
        ? 'The credentials file already exists. Choose a new path, or use --resume with the card from an earlier setup. Nothing was changed.'
        : `The credentials file could not be written completely. The workspace was not set up; remove any partial file at ${file} before trying again.`);
      return 1;
    } finally {
      await handle?.close();
    }
  }
  try {
    const { requestId, displayName, accessKey, recoveryKey } = card;
    await access.bootstrap({ requestId, displayName, accessKey, recoveryKey });
  } catch (error) {
    err(error?.status === 409
      ? 'The workspace owner could not be set up: it already has a different owner or this card does not match. The card file was kept.'
      : `The card is saved at ${file}, but the workspace owner could not be saved. Run the same command with --resume to finish.`);
    return 1;
  }
  // The owner is already saved; a failed count must not hide that.
  const drafts = await new DraftStore(dataDir).list().then((items) => items.length, () => null);
  out(`Owner card: ${file}`);
  out(options.resume
    ? 'The owner setup recorded on this card is in place. If the owner keys were later replaced by recovery, the keys on this card no longer sign in.'
    : 'Workspace owner is set up.');
  out(drafts === null
    ? 'Existing local memories could not be counted; all of them are readable only after owner sign-in.'
    : `Existing local memories now readable only after owner sign-in: ${drafts}.`);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = await runCli(process.argv.slice(2));
}
