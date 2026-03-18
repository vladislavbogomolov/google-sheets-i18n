import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2);
const flags = new Set(args.filter(arg => arg.startsWith('--')));
const commands = args.filter(arg => !arg.startsWith('--'));

const CLI_NAME = 'google-sheets-i18n';
const PROJECT_ROOT = path.resolve(process.cwd(), process.env.TRANSLATIONS_PROJECT_ROOT || '.');
const INITIAL_ENV_KEYS = new Set(Object.keys(process.env));

function parseEnvValue(rawValue) {
  const trimmed = rawValue.trim();
  if (!trimmed) return '';

  const quote = trimmed[0];
  if ((quote === '"' || quote === '\'') && trimmed.endsWith(quote)) {
    const unquoted = trimmed.slice(1, -1);
    return quote === '"'
      ? unquoted
        .replace(/\\n/g, '\n')
        .replace(/\\r/g, '\r')
        .replace(/\\t/g, '\t')
      : unquoted;
  }

  const commentIndex = trimmed.search(/\s#/);
  if (commentIndex >= 0) {
    return trimmed.slice(0, commentIndex).trim();
  }

  return trimmed;
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;

  const content = fs.readFileSync(filePath, 'utf8');
  for (const line of content.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const normalized = trimmed.startsWith('export ') ? trimmed.slice(7).trim() : trimmed;
    const match = normalized.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (INITIAL_ENV_KEYS.has(key)) continue;

    process.env[key] = parseEnvValue(rawValue);
  }
}

function loadEnvFiles() {
  loadEnvFile(path.join(PROJECT_ROOT, '.env'));
  loadEnvFile(path.join(PROJECT_ROOT, '.env.local'));
}

loadEnvFiles();

const config = {
  sheetTitle: process.env.GOOGLE_SHEET_TITLE || '',
  sheetId: process.env.GOOGLE_SHEET_ID || '',
  credentialsPath: process.env.GOOGLE_APPLICATION_CREDENTIALS
    ? path.resolve(PROJECT_ROOT, process.env.GOOGLE_APPLICATION_CREDENTIALS)
    : '',
  translationsDir: process.env.TRANSLATIONS_DIR
    ? path.resolve(PROJECT_ROOT, process.env.TRANSLATIONS_DIR)
    : '',
  defaultLanguage: process.env.DEFAULT_LANGUAGE || '',
  sourceDir: process.env.TRANSLATIONS_SOURCE_DIR
    ? path.resolve(PROJECT_ROOT, process.env.TRANSLATIONS_SOURCE_DIR)
    : '',
  dryRun: flags.has('--dry-run'),
  fillEmpty: flags.has('--fill-empty') || flags.has('--update-existing'),
  updateExisting: flags.has('--update-existing'),
  verbose: flags.has('--verbose'),
};

const SUPPORTED_COMMANDS = new Set(['download', 'upload', 'find-new', 'help', '--help', '-h']);
const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx']);
const SCOPES = ['https://www.googleapis.com/auth/spreadsheets'];

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === '[object Object]';
}

function normalizeCellValue(value) {
  if (value === null || value === undefined) return '';
  return String(value);
}

function normalizeKey(value) {
  return normalizeCellValue(value).trim();
}

function uniq(values) {
  return [...new Set(values)];
}

function hasInlineServiceAccountCredentials() {
  return Boolean(process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL && process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY);
}

function getMissingEnvVars() {
  const missing = [];

  if (!config.sheetTitle) missing.push('GOOGLE_SHEET_TITLE');
  if (!config.sheetId) missing.push('GOOGLE_SHEET_ID');
  if (!config.translationsDir) missing.push('TRANSLATIONS_DIR');
  if (!config.sourceDir) missing.push('TRANSLATIONS_SOURCE_DIR');
  if (!config.defaultLanguage) missing.push('DEFAULT_LANGUAGE');

  if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !config.credentialsPath && !hasInlineServiceAccountCredentials()) {
    missing.push(
      'GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'
    );
  }

  return missing;
}

function ensureEnvConfig() {
  const missing = getMissingEnvVars();
  if (missing.length === 0) return;

  throw new Error(
    `Missing required environment variables: ${missing.join(', ')}. Copy .env.example to .env and fill in the values.`
  );
}

function compareStrings(a, b) {
  return a.localeCompare(b, 'en');
}

function getScriptKind(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.tsx') return ts.ScriptKind.TSX;
  if (ext === '.ts') return ts.ScriptKind.TS;
  if (ext === '.jsx') return ts.ScriptKind.JSX;
  return ts.ScriptKind.JS;
}

function getCalleeName(expression) {
  if (ts.isIdentifier(expression)) return expression.text;
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  return null;
}

function getStaticText(expression) {
  if (!expression) return '';
  if (ts.isStringLiteral(expression) || ts.isNoSubstitutionTemplateLiteral(expression)) {
    return expression.text;
  }
  if (ts.isTemplateExpression(expression)) {
    if (expression.templateSpans.length === 0) return expression.head.text;
    return null;
  }
  return null;
}

function unwrapExpression(expression) {
  let current = expression;
  while (
    current &&
    (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isAwaitExpression(current)
    )
  ) {
    current = current.expression;
  }
  return current;
}

function sortObjectDeep(value) {
  if (!isPlainObject(value)) return value;

  const out = {};
  for (const key of Object.keys(value).sort(compareStrings)) {
    out[key] = sortObjectDeep(value[key]);
  }
  return out;
}

function flattenMessages(value, prefix = '', out = {}) {
  if (!isPlainObject(value)) {
    throw new Error(`Expected nested object at "${prefix || '<root>'}".`);
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;
    if (isPlainObject(nestedValue)) {
      flattenMessages(nestedValue, nextKey, out);
      continue;
    }

    out[nextKey] = normalizeCellValue(nestedValue);
  }

  return out;
}

function unflattenMessages(flatObject) {
  const root = {};

  for (const key of Object.keys(flatObject).sort(compareStrings)) {
    const value = flatObject[key];
    const parts = key.split('.');
    let cursor = root;

    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i];
      const isLeaf = i === parts.length - 1;

      if (isLeaf) {
        cursor[part] = value;
        continue;
      }

      if (!isPlainObject(cursor[part])) {
        cursor[part] = {};
      }

      cursor = cursor[part];
    }
  }

  return sortObjectDeep(root);
}

async function readJsonFile(filePath) {
  const raw = await fsp.readFile(filePath, 'utf8');
  return JSON.parse(raw);
}

async function writeJsonFileIfChanged(filePath, data) {
  const nextContent = `${JSON.stringify(sortObjectDeep(data), null, 2)}\n`;
  let currentContent = null;

  try {
    currentContent = await fsp.readFile(filePath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  if (currentContent === nextContent) {
    return false;
  }

  if (!config.dryRun) {
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, nextContent, 'utf8');
  }

  return true;
}

async function ensureDirectoryExists(dirPath) {
  let stat;

  try {
    stat = await fsp.stat(dirPath);
  } catch (error) {
    if (error.code === 'ENOENT') {
      throw new Error(`Directory not found: ${dirPath}`);
    }
    throw error;
  }

  if (!stat.isDirectory()) {
    throw new Error(`Expected directory, got file: ${dirPath}`);
  }
}

async function listLocalLanguageFiles() {
  await ensureDirectoryExists(config.translationsDir);
  const entries = await fsp.readdir(config.translationsDir, { withFileTypes: true });

  return entries
    .filter(entry => entry.isFile() && entry.name.toLowerCase().endsWith('.json'))
    .map(entry => entry.name)
    .sort(compareStrings);
}

async function getLocalMessagesByLanguage() {
  const files = await listLocalLanguageFiles();
  const byLanguage = {};
  const allKeys = new Set();

  for (const fileName of files) {
    const language = path.basename(fileName, '.json');
    const fullPath = path.join(config.translationsDir, fileName);
    const nestedMessages = await readJsonFile(fullPath);
    const flatMessages = flattenMessages(nestedMessages);
    byLanguage[language] = flatMessages;

    for (const key of Object.keys(flatMessages)) {
      allKeys.add(key);
    }
  }

  return {
    byLanguage,
    languages: Object.keys(byLanguage).sort(compareStrings),
    keys: [...allKeys].sort(compareStrings),
  };
}

async function walkSourceFiles(dirPath) {
  const entries = await fsp.readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries.sort((a, b) => compareStrings(a.name, b.name))) {
    if (entry.name === 'node_modules' || entry.name === '.next' || entry.name === '.git') {
      continue;
    }

    const fullPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...await walkSourceFiles(fullPath));
      continue;
    }

    const ext = path.extname(entry.name).toLowerCase();
    if (!SOURCE_EXTENSIONS.has(ext) || entry.name.endsWith('.d.ts')) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

function createWarning(sourceFile, node, message) {
  const position = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  return {
    filePath: sourceFile.fileName,
    line: position.line + 1,
    message,
  };
}

function extractTranslationKeysFromSource(sourceText, filePath) {
  const sourceFile = ts.createSourceFile(
    filePath,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
    getScriptKind(filePath)
  );

  const keys = new Set();
  const warnings = [];
  const scopes = [new Map()];

  function pushScope() {
    scopes.push(new Map());
  }

  function popScope() {
    scopes.pop();
  }

  function setBinding(name, namespace) {
    scopes[scopes.length - 1].set(name, namespace);
  }

  function getBinding(name) {
    for (let i = scopes.length - 1; i >= 0; i -= 1) {
      if (scopes[i].has(name)) {
        return scopes[i].get(name);
      }
    }
    return undefined;
  }

  function getTranslatorNamespace(initializer) {
    const unwrapped = unwrapExpression(initializer);
    if (!unwrapped || !ts.isCallExpression(unwrapped)) return undefined;

    const calleeName = getCalleeName(unwrapped.expression);
    if (calleeName !== 'useTranslations' && calleeName !== 'getTranslations') {
      return undefined;
    }

    if (unwrapped.arguments.length === 0) return '';

    const namespace = getStaticText(unwrapped.arguments[0]);
    if (namespace === null) {
      warnings.push(createWarning(sourceFile, unwrapped.arguments[0], 'Skipped dynamic translation namespace.'));
      return undefined;
    }

    return namespace;
  }

  function addKey(namespace, key) {
    const normalized = namespace ? `${namespace}.${key}` : key;
    keys.add(normalized);
  }

  function visit(node) {
    const startsScope =
      node !== sourceFile &&
      (
        ts.isBlock(node) ||
        ts.isModuleBlock(node) ||
        ts.isSourceFile(node) ||
        ts.isFunctionLike(node) ||
        ts.isCaseClause(node) ||
        ts.isDefaultClause(node) ||
        ts.isCatchClause(node)
      );

    if (startsScope) pushScope();

    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const namespace = getTranslatorNamespace(node.initializer);
      if (namespace !== undefined) {
        setBinding(node.name.text, namespace);
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const namespace = getBinding(node.expression.text);
      if (namespace !== undefined) {
        const firstArg = node.arguments[0];
        const key = getStaticText(firstArg);
        if (key === null) {
          warnings.push(createWarning(sourceFile, firstArg, `Skipped dynamic translation key for "${node.expression.text}(...)"`));
        } else if (key) {
          addKey(namespace, key);
        }
      }
    }

    ts.forEachChild(node, visit);

    if (startsScope) popScope();
  }

  visit(sourceFile);

  return {
    keys: [...keys].sort(compareStrings),
    warnings,
  };
}

async function collectSourceTranslationKeys() {
  await ensureDirectoryExists(config.sourceDir);
  const files = await walkSourceFiles(config.sourceDir);
  const keys = new Set();
  const warnings = [];

  for (const filePath of files) {
    const sourceText = await fsp.readFile(filePath, 'utf8');
    const result = extractTranslationKeysFromSource(sourceText, filePath);

    for (const key of result.keys) {
      keys.add(key);
    }

    warnings.push(...result.warnings);
  }

  return {
    keys: [...keys].sort(compareStrings),
    warnings,
  };
}

function loadCredentials() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) {
    return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  }

  if (hasInlineServiceAccountCredentials()) {
    return {
      client_email: process.env.GOOGLE_SERVICE_ACCOUNT_EMAIL,
      private_key: process.env.GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY.replace(/\\n/g, '\n'),
    };
  }

  if (!config.credentialsPath || !fs.existsSync(config.credentialsPath)) {
    throw new Error(
      `Google credentials not found. Set GOOGLE_APPLICATION_CREDENTIALS, GOOGLE_SERVICE_ACCOUNT_JSON, or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY. Checked: ${config.credentialsPath || '<empty>'}`
    );
  }

  return JSON.parse(fs.readFileSync(config.credentialsPath, 'utf8'));
}

function createDoc() {
  const credentials = loadCredentials();
  const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: SCOPES,
  });

  return new GoogleSpreadsheet(config.sheetId, auth);
}

async function withRetry(fn, { retries = 3, baseMs = 400 } = {}) {
  let lastError;

  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt >= retries) break;

      const timeout = baseMs * (2 ** attempt);
      if (config.verbose) {
        console.warn(`Retry ${attempt + 1}/${retries} after ${timeout}ms: ${error.message}`);
      }
      await new Promise(resolve => setTimeout(resolve, timeout));
    }
  }

  throw lastError;
}

async function getSheet() {
  console.log(`Loading spreadsheet "${config.sheetTitle}"...`);
  const doc = createDoc();
  await withRetry(() => doc.loadInfo());

  const sheet = doc.sheetsByTitle[config.sheetTitle];
  if (!sheet) {
    throw new Error(`Sheet "${config.sheetTitle}" not found.`);
  }

  return sheet;
}

async function getSheetLanguages(sheet) {
  await withRetry(() => sheet.loadHeaderRow());
  return (sheet.headerValues || []).filter(header => header && header !== 'key');
}

async function ensureSheetLanguages(sheet, languages) {
  await withRetry(() => sheet.loadHeaderRow());
  const currentHeaders = (sheet.headerValues || []).filter(Boolean);
  const currentLanguages = currentHeaders.filter(header => header !== 'key');
  const missingLanguages = languages.filter(language => !currentLanguages.includes(language));

  if (missingLanguages.length === 0) {
    return {
      languages: currentLanguages,
      addedLanguages: [],
    };
  }

  const nextHeaders = uniq(['key', ...currentLanguages, ...missingLanguages]);

  if (config.dryRun) {
    console.log(`[dry-run] Would add languages to sheet: ${missingLanguages.join(', ')}`);
    return {
      languages: nextHeaders.filter(header => header !== 'key'),
      addedLanguages: missingLanguages,
    };
  }

  if (sheet.columnCount < nextHeaders.length) {
    await withRetry(() => sheet.resize({ rowCount: sheet.rowCount, columnCount: nextHeaders.length }));
  }

  await withRetry(() => sheet.setHeaderRow(nextHeaders));
  await withRetry(() => sheet.loadHeaderRow());

  console.log(`Added languages to sheet: ${missingLanguages.join(', ')}`);

  return {
    languages: nextHeaders.filter(header => header !== 'key'),
    addedLanguages: missingLanguages,
  };
}

function indexRowsByKey(rows) {
  const rowsByKey = new Map();
  const duplicateKeys = new Set();

  for (const row of rows) {
    const key = normalizeKey(row.get('key'));
    if (!key) continue;

    if (rowsByKey.has(key)) {
      duplicateKeys.add(key);
    }
    rowsByKey.set(key, row);
  }

  return {
    rowsByKey,
    duplicateKeys: [...duplicateKeys].sort(compareStrings),
  };
}

function buildRowFromLocal(key, languages, localByLanguage) {
  const row = { key };

  for (const language of languages) {
    row[language] = localByLanguage[language]?.[key] ?? '';
  }

  return row;
}

function summarizeWarnings(warnings) {
  if (warnings.length === 0) return;

  console.warn(`Skipped ${warnings.length} dynamic translation usage(s) while scanning source files.`);
  const preview = config.verbose ? warnings : warnings.slice(0, 5);

  for (const warning of preview) {
    console.warn(`- ${path.relative(PROJECT_ROOT, warning.filePath)}:${warning.line} ${warning.message}`);
  }

  if (!config.verbose && warnings.length > preview.length) {
    console.warn(`- ...and ${warnings.length - preview.length} more. Re-run with --verbose to see all.`);
  }
}

async function downloadTranslations() {
  const sheet = await getSheet();
  const languages = await getSheetLanguages(sheet);
  const rows = await withRetry(() => sheet.getRows());
  const { duplicateKeys } = indexRowsByKey(rows);
  const byLanguage = Object.fromEntries(languages.map(language => [language, {}]));

  if (duplicateKeys.length > 0) {
    console.warn(`Duplicate keys found in sheet, last row wins: ${duplicateKeys.join(', ')}`);
  }

  for (const row of rows) {
    const key = normalizeKey(row.get('key'));
    if (!key) continue;

    for (const language of languages) {
      byLanguage[language][key] = normalizeCellValue(row.get(language));
    }
  }

  let changedFiles = 0;

  for (const language of languages) {
    const filePath = path.join(config.translationsDir, `${language}.json`);
    const nestedMessages = unflattenMessages(byLanguage[language]);
    const changed = await writeJsonFileIfChanged(filePath, nestedMessages);

    if (changed) {
      changedFiles += 1;
      const prefix = config.dryRun ? '[dry-run] Would write' : 'Wrote';
      console.log(`${prefix} ${path.relative(PROJECT_ROOT, filePath)}`);
    }
  }

  console.log(`Download complete. ${changedFiles}/${languages.length} file(s) changed.`);
}

async function uploadTranslations() {
  const local = await getLocalMessagesByLanguage();

  if (local.languages.length === 0) {
    throw new Error(`No translation files found in ${config.translationsDir}`);
  }

  if (!local.byLanguage[config.defaultLanguage]) {
    console.warn(`Default language "${config.defaultLanguage}" was not found locally. Continuing with union of all local keys.`);
  }

  const sheet = await getSheet();
  const { languages: sheetLanguages } = await ensureSheetLanguages(sheet, local.languages);
  const rows = await withRetry(() => sheet.getRows());
  const { rowsByKey, duplicateKeys } = indexRowsByKey(rows);
  const rowsToAdd = [];
  const rowsToSave = [];
  let updatedCellCount = 0;

  if (duplicateKeys.length > 0) {
    console.warn(`Duplicate keys found in sheet, last row wins during upload: ${duplicateKeys.join(', ')}`);
  }

  for (const key of local.keys) {
    const existingRow = rowsByKey.get(key);
    if (!existingRow) {
      rowsToAdd.push(buildRowFromLocal(key, sheetLanguages, local.byLanguage));
      continue;
    }

    let rowChanged = false;

    for (const language of sheetLanguages) {
      const localValue = local.byLanguage[language]?.[key];
      if (localValue === undefined) continue;

      const sheetValue = normalizeCellValue(existingRow.get(language));

      if (config.updateExisting) {
        if (sheetValue !== localValue) {
          existingRow.set(language, localValue);
          rowChanged = true;
          updatedCellCount += 1;
        }
        continue;
      }

      if (config.fillEmpty && sheetValue === '' && localValue !== '') {
        existingRow.set(language, localValue);
        rowChanged = true;
        updatedCellCount += 1;
      }
    }

    if (rowChanged) {
      rowsToSave.push(existingRow);
    }
  }

  if (rowsToAdd.length === 0 && rowsToSave.length === 0) {
    console.log('Upload complete. No sheet changes required.');
    return;
  }

  if (config.dryRun) {
    console.log(`[dry-run] Would add ${rowsToAdd.length} row(s).`);
    console.log(`[dry-run] Would update ${rowsToSave.length} existing row(s), ${updatedCellCount} cell(s).`);
    return;
  }

  if (rowsToAdd.length > 0) {
    await withRetry(() => sheet.addRows(rowsToAdd));
  }

  for (const row of rowsToSave) {
    await withRetry(() => row.save());
  }

  console.log(`Upload complete. Added ${rowsToAdd.length} row(s), updated ${rowsToSave.length} row(s), ${updatedCellCount} cell(s).`);
}

async function findNewKeys() {
  const local = await getLocalMessagesByLanguage();
  const source = await collectSourceTranslationKeys();
  summarizeWarnings(source.warnings);

  const sheet = await getSheet();
  const { languages: sheetLanguages } = await ensureSheetLanguages(sheet, local.languages);
  const rows = await withRetry(() => sheet.getRows());
  const { rowsByKey, duplicateKeys } = indexRowsByKey(rows);

  if (duplicateKeys.length > 0) {
    console.warn(`Duplicate keys found in sheet, last row wins while comparing source keys: ${duplicateKeys.join(', ')}`);
  }

  const newKeys = source.keys.filter(key => !rowsByKey.has(key));
  const missingLocally = newKeys.filter(key => !local.keys.includes(key));

  if (newKeys.length === 0) {
    console.log('No new translation keys found in source files.');
    return;
  }

  const rowsToAdd = newKeys.map(key => buildRowFromLocal(key, sheetLanguages, local.byLanguage));

  if (missingLocally.length > 0) {
    console.warn(`${missingLocally.length} new key(s) were not found in local JSON files and will be created empty in the sheet.`);
    if (config.verbose) {
      for (const key of missingLocally) {
        console.warn(`- ${key}`);
      }
    }
  }

  if (config.dryRun) {
    console.log(`[dry-run] Would add ${rowsToAdd.length} key(s) from source files.`);
    return;
  }

  await withRetry(() => sheet.addRows(rowsToAdd));
  console.log(`Added ${rowsToAdd.length} new key(s) from source files.`);
}

function printUsage() {
  console.log(`Usage:
  ${CLI_NAME} download [--dry-run]
  ${CLI_NAME} upload [--dry-run] [--fill-empty] [--update-existing]
  ${CLI_NAME} find-new [--dry-run] [--verbose]

Environment variables:
  GOOGLE_APPLICATION_CREDENTIALS=path/to/service-account.json
  GOOGLE_SERVICE_ACCOUNT_JSON='{"client_email":"...","private_key":"..."}'
  GOOGLE_SERVICE_ACCOUNT_EMAIL=service-account@project.iam.gserviceaccount.com
  GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY='-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n'
  GOOGLE_SHEET_ID=...
  GOOGLE_SHEET_TITLE=...
  TRANSLATIONS_DIR=src/messages
  TRANSLATIONS_SOURCE_DIR=src
  DEFAULT_LANGUAGE=it
  TRANSLATIONS_PROJECT_ROOT=/path/to/project # optional, shell env only, defaults to cwd

Setup:
  1. Copy .env.example to .env
  2. Fill in your project values
  3. Run one of the commands below

Examples:
  ${CLI_NAME} download
  ${CLI_NAME} upload --fill-empty
  ${CLI_NAME} upload --update-existing
  ${CLI_NAME} find-new --dry-run --verbose`);
}

export async function main() {
  try {
    if (commands.length === 0 || commands.some(command => !SUPPORTED_COMMANDS.has(command))) {
      printUsage();
      if (commands.length > 0) {
        process.exitCode = 1;
      }
      return;
    }

    const executableCommands = commands.filter(command => command !== 'help' && command !== '--help' && command !== '-h');
    if (executableCommands.length === 0) {
      printUsage();
      return;
    }

    ensureEnvConfig();

    for (const command of executableCommands) {
      if (command === 'download') {
        await downloadTranslations();
      } else if (command === 'upload') {
        await uploadTranslations();
      } else if (command === 'find-new') {
        await findNewKeys();
      }
    }
  } catch (error) {
    console.error('Error:', error && error.message ? error.message : error);
    process.exitCode = 1;
  }
}

export const __internal = {
  collectSourceTranslationKeys,
  extractTranslationKeysFromSource,
  flattenMessages,
  getLocalMessagesByLanguage,
  unflattenMessages,
};
