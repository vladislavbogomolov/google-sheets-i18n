import { GoogleSpreadsheet } from 'google-spreadsheet';
import { JWT } from 'google-auth-library';
import fs from 'node:fs';
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const args = process.argv.slice(2);
const optionArgs = args.filter(arg => arg.startsWith('--'));
const flags = new Set(optionArgs);
const commands = args.filter(arg => !arg.startsWith('--'));

const CLI_NAME = 'google-sheets-i18n';
const PROJECT_ROOT = path.resolve(process.cwd(), process.env.TRANSLATIONS_PROJECT_ROOT || '.');
const INITIAL_ENV_KEYS = new Set(Object.keys(process.env));
const DEFAULT_FRAMEWORK = 'next-intl';
const DEFAULT_KEY_SEPARATOR = '.';
const FRAMEWORK_ALIASES = new Map([
  ['nextintl', 'next-intl'],
  ['next_intl', 'next-intl'],
  ['i18next', 'react-i18next'],
  ['reacti18next', 'react-i18next'],
  ['react_i18next', 'react-i18next'],
]);
const DISABLED_KEY_SEPARATOR_VALUES = new Set(['false', 'none', 'off', 'no', 'flat', '0']);

function getOptionValues(name) {
  const prefix = `${name}=`;

  return optionArgs
    .filter(arg => arg.startsWith(prefix))
    .map(arg => arg.slice(prefix.length))
    .filter(Boolean);
}

function getLastOptionValue(name, fallback = '') {
  const values = getOptionValues(name);
  return values.length > 0 ? values[values.length - 1] : fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function parseListOption(name) {
  return uniq(
    getOptionValues(name)
      .flatMap(value => value.split(','))
      .map(value => value.trim())
      .filter(Boolean)
  );
}

function parseKeySeparator(rawValue) {
  const value = normalizeCellValue(rawValue).trim();
  if (!value) return null;

  return DISABLED_KEY_SEPARATOR_VALUES.has(value.toLowerCase()) ? null : value;
}

function parseFramework(rawValue) {
  const value = normalizeCellValue(rawValue).trim().toLowerCase();
  if (!value) return DEFAULT_FRAMEWORK;

  return FRAMEWORK_ALIASES.get(value) || value;
}

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
  framework: parseFramework(getLastOptionValue('--framework', process.env.TRANSLATIONS_FRAMEWORK || DEFAULT_FRAMEWORK)),
  keySeparator: parseKeySeparator(
    getLastOptionValue(
      '--key-separator',
      process.env.TRANSLATIONS_KEY_SEPARATOR === undefined
        ? DEFAULT_KEY_SEPARATOR
        : process.env.TRANSLATIONS_KEY_SEPARATOR
    )
  ),
  translationProvider: getLastOptionValue('--provider', process.env.TRANSLATION_PROVIDER || 'openai').toLowerCase(),
  translationBatchSize: parsePositiveInteger(
    getLastOptionValue('--batch-size', process.env.TRANSLATION_BATCH_SIZE || process.env.OPENAI_TRANSLATION_BATCH_SIZE || '25'),
    25
  ),
  openAiApiKey: process.env.OPENAI_API_KEY || '',
  openAiModel: getLastOptionValue('--model', process.env.OPENAI_TRANSLATION_MODEL || 'gpt-5-mini'),
  openAiBaseUrl: (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, ''),
  deeplApiKey: process.env.DEEPL_API_KEY || '',
  deeplApiUrl: (process.env.DEEPL_API_URL || 'https://api-free.deepl.com/v2').replace(/\/+$/, ''),
  deeplModelType: getLastOptionValue('--deepl-model-type', process.env.DEEPL_MODEL_TYPE || 'prefer_quality_optimized'),
  googleTranslateApiKey: process.env.GOOGLE_TRANSLATE_API_KEY || '',
  googleTranslateApiUrl: (process.env.GOOGLE_TRANSLATE_API_URL || 'https://translation.googleapis.com/language/translate/v2').replace(/\/+$/, ''),
  googleTranslateModel: process.env.GOOGLE_TRANSLATE_MODEL || 'nmt',
  targetLanguages: parseListOption('--language'),
  toSheet: flags.has('--to-sheet'),
  dryRun: flags.has('--dry-run'),
  fillEmpty: flags.has('--fill-empty') || flags.has('--update-existing'),
  updateExisting: flags.has('--update-existing'),
  verbose: flags.has('--verbose'),
};

const SUPPORTED_COMMANDS = new Set(['download', 'upload', 'find-new', 'translate-missing', 'help', '--help', '-h']);
const SUPPORTED_TRANSLATION_PROVIDERS = new Set(['openai', 'deepl', 'google']);
const SUPPORTED_FRAMEWORKS = new Set(['next-intl', 'react-i18next']);
const NEXT_INTL_TRANSLATOR_CALLEES = new Set(['useTranslations', 'getTranslations']);
const REACT_I18NEXT_TRANSLATOR_CALLEES = new Set(['useTranslation']);
const REACT_I18NEXT_FIXED_TRANSLATOR_CALLEES = new Set(['getFixedT']);
const I18N_INSTANCE_PATTERN = /^i18n(ext)?$/i;
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

function getMissingEnvVars(executableCommands) {
  const missing = new Set();
  const requiresLocalTranslations = executableCommands.length > 0;
  const requiresGoogleSheet = executableCommands.some(command => command === 'download' || command === 'upload' || command === 'find-new')
    || (executableCommands.includes('translate-missing') && config.toSheet);
  const requiresSourceScanning = executableCommands.includes('find-new');
  const requiresDefaultLanguage = executableCommands.some(
    command => command === 'upload' || command === 'find-new' || command === 'translate-missing'
  );
  const requiresMachineTranslation = executableCommands.includes('translate-missing');

  if (requiresLocalTranslations && !config.translationsDir) {
    missing.add('TRANSLATIONS_DIR');
  }

  if (requiresSourceScanning && !config.sourceDir) {
    missing.add('TRANSLATIONS_SOURCE_DIR');
  }

  if (requiresDefaultLanguage && !config.defaultLanguage) {
    missing.add('DEFAULT_LANGUAGE');
  }

  if (requiresGoogleSheet) {
    if (!config.sheetTitle) missing.add('GOOGLE_SHEET_TITLE');
    if (!config.sheetId) missing.add('GOOGLE_SHEET_ID');

    if (!process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !config.credentialsPath && !hasInlineServiceAccountCredentials()) {
      missing.add(
        'GOOGLE_APPLICATION_CREDENTIALS or GOOGLE_SERVICE_ACCOUNT_JSON or GOOGLE_SERVICE_ACCOUNT_EMAIL + GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY'
      );
    }
  }

  if (requiresMachineTranslation) {
    if (config.translationProvider === 'openai' && !config.openAiApiKey) {
      missing.add('OPENAI_API_KEY');
    } else if (config.translationProvider === 'deepl' && !config.deeplApiKey) {
      missing.add('DEEPL_API_KEY');
    } else if (config.translationProvider === 'google' && !config.googleTranslateApiKey) {
      missing.add('GOOGLE_TRANSLATE_API_KEY');
    }
  }

  return [...missing];
}

function ensureEnvConfig(executableCommands) {
  if (!SUPPORTED_FRAMEWORKS.has(config.framework)) {
    throw new Error(
      `Unsupported framework "${config.framework}". Use one of: ${[...SUPPORTED_FRAMEWORKS].join(', ')}.`
    );
  }

  if (executableCommands.includes('translate-missing') && !SUPPORTED_TRANSLATION_PROVIDERS.has(config.translationProvider)) {
    throw new Error(
      `Unsupported translation provider "${config.translationProvider}". Use one of: ${[...SUPPORTED_TRANSLATION_PROVIDERS].join(', ')}.`
    );
  }

  const missing = getMissingEnvVars(executableCommands);
  if (missing.length === 0) return;

  throw new Error(
    `Missing required environment variables: ${missing.join(', ')}. Copy .env.example to .env and fill in the values.`
  );
}

function compareStrings(a, b) {
  return a.localeCompare(b, 'en');
}

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function chunkValues(values, chunkSize) {
  const chunks = [];

  for (let index = 0; index < values.length; index += chunkSize) {
    chunks.push(values.slice(index, index + chunkSize));
  }

  return chunks;
}

function getLanguageDisplayName(language) {
  try {
    const displayNames = new Intl.DisplayNames(['en'], { type: 'language' });
    return displayNames.of(language) || language;
  } catch {
    return language;
  }
}

function normalizeLocaleCode(language) {
  return normalizeCellValue(language).trim().replace(/_/g, '-');
}

function normalizeDeepLLanguageCode(language) {
  return normalizeLocaleCode(language).toUpperCase();
}

function getTranslationProviderLabel(provider = config.translationProvider) {
  if (provider === 'deepl') return 'DeepL';
  if (provider === 'google') return 'Google Cloud Translation';
  return 'OpenAI';
}

function getTranslationProviderBatchSize() {
  if (config.translationProvider === 'deepl') {
    return Math.min(config.translationBatchSize, 50);
  }

  if (config.translationProvider === 'google') {
    return Math.min(config.translationBatchSize, 128);
  }

  return config.translationBatchSize;
}

function getTranslationProviderDetails() {
  if (config.translationProvider === 'openai') {
    return `${getTranslationProviderLabel()} (${config.openAiModel})`;
  }

  if (config.translationProvider === 'deepl') {
    return `${getTranslationProviderLabel()} (${config.deeplModelType})`;
  }

  if (config.translationProvider === 'google') {
    return `${getTranslationProviderLabel()} (${config.googleTranslateModel})`;
  }

  return getTranslationProviderLabel();
}

function countOccurrences(values) {
  const counts = new Map();

  for (const value of values) {
    counts.set(value, (counts.get(value) || 0) + 1);
  }

  return counts;
}

function getCountDifference(expected, actual) {
  const missing = [];

  for (const [value, expectedCount] of expected.entries()) {
    const actualCount = actual.get(value) || 0;
    const diff = expectedCount - actualCount;

    for (let index = 0; index < diff; index += 1) {
      missing.push(value);
    }
  }

  return missing.sort(compareStrings);
}

function extractPlaceholderTokens(value) {
  const tokens = [];
  let masked = value;

  function capture(pattern, mapMatch = match => match[0]) {
    const matches = [...masked.matchAll(pattern)];

    for (const match of matches) {
      tokens.push(mapMatch(match));
    }

    masked = masked.replace(pattern, match => ' '.repeat(match.length));
  }

  capture(/\{\{[^{}]+\}\}/g);
  capture(/\{[A-Za-z0-9_.-]+\}/g);
  capture(/%\d*\$?[sdifo]/g);
  capture(/<\/?([A-Za-z][A-Za-z0-9-]*)\b[^>]*>/g, match => `${match[0].startsWith('</') ? '</' : '<'}${match[1]}>`);

  return tokens.sort(compareStrings);
}

function validatePlaceholderTokens(sourceText, translatedText) {
  const expected = countOccurrences(extractPlaceholderTokens(sourceText));
  const actual = countOccurrences(extractPlaceholderTokens(translatedText));

  return {
    missing: getCountDifference(expected, actual),
    unexpected: getCountDifference(actual, expected),
  };
}

function getCellSyncId(language, key) {
  return `${language}\u0000${key}`;
}

function decodeHtmlEntities(value) {
  const namedEntities = {
    amp: '&',
    apos: '\'',
    gt: '>',
    lt: '<',
    nbsp: '\u00A0',
    quot: '"',
  };

  return value.replace(/&(#x?[0-9A-Fa-f]+|[A-Za-z]+);/g, (match, entity) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const codePoint = Number.parseInt(entity.slice(2), 16);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }

    if (entity.startsWith('#')) {
      const codePoint = Number.parseInt(entity.slice(1), 10);
      return Number.isNaN(codePoint) ? match : String.fromCodePoint(codePoint);
    }

    return hasOwn(namedEntities, entity) ? namedEntities[entity] : match;
  });
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

function flattenMessages(value, options = {}) {
  const { keySeparator = config.keySeparator } = options;
  const out = {};

  const walk = (current, prefix) => {
    if (!isPlainObject(current)) {
      throw new Error(`Expected nested object at "${prefix || '<root>'}".`);
    }

    for (const [key, nestedValue] of Object.entries(current)) {
      const nextKey = prefix ? `${prefix}${keySeparator}${key}` : key;

      if (isPlainObject(nestedValue)) {
        if (!keySeparator) {
          throw new Error(
            `Nested object at "${nextKey}" is not supported while key nesting is disabled (TRANSLATIONS_KEY_SEPARATOR=false).`
          );
        }

        walk(nestedValue, nextKey);
        continue;
      }

      out[nextKey] = normalizeCellValue(nestedValue);
    }
  };

  walk(value, '');

  return out;
}

function unflattenMessages(flatObject, options = {}) {
  const { keySeparator = config.keySeparator } = options;

  if (!keySeparator) {
    return sortObjectDeep({ ...flatObject });
  }

  const root = {};

  for (const key of Object.keys(flatObject).sort(compareStrings)) {
    const value = flatObject[key];
    const parts = key.split(keySeparator);
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
    const localMessages = await readJsonFile(fullPath);
    const flatMessages = flattenMessages(localMessages);
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

function buildLocalMessagesSnapshot(byLanguage) {
  const normalizedByLanguage = {};
  const allKeys = new Set();

  for (const language of Object.keys(byLanguage).sort(compareStrings)) {
    const messages = byLanguage[language] || {};
    normalizedByLanguage[language] = messages;

    for (const key of Object.keys(messages)) {
      allKeys.add(key);
    }
  }

  return {
    byLanguage: normalizedByLanguage,
    languages: Object.keys(normalizedByLanguage).sort(compareStrings),
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

function getBindingPropertyName(propertyName) {
  if (!propertyName) return null;
  if (ts.isIdentifier(propertyName) || ts.isStringLiteral(propertyName)) return propertyName.text;
  return null;
}

function getDestructuredTranslatorName(bindingName) {
  if (ts.isObjectBindingPattern(bindingName)) {
    for (const element of bindingName.elements) {
      if (!ts.isIdentifier(element.name)) continue;

      const propertyName = element.propertyName
        ? getBindingPropertyName(element.propertyName)
        : element.name.text;

      if (propertyName === 't') return element.name.text;
    }

    return null;
  }

  if (ts.isArrayBindingPattern(bindingName)) {
    const [first] = bindingName.elements;
    if (first && ts.isBindingElement(first) && ts.isIdentifier(first.name)) return first.name.text;
    return null;
  }

  return null;
}

function getInstanceName(expression) {
  const unwrapped = unwrapExpression(expression);
  if (!unwrapped) return null;
  if (ts.isIdentifier(unwrapped)) return unwrapped.text;
  if (ts.isPropertyAccessExpression(unwrapped)) return unwrapped.name.text;
  return null;
}

function extractTranslationKeysFromSource(sourceText, filePath, options = {}) {
  const { framework = config.framework, keySeparator = config.keySeparator } = options;
  const isReactI18next = framework === 'react-i18next';
  const namespaceSeparator = keySeparator || DEFAULT_KEY_SEPARATOR;
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

  // Resolves an expression that evaluates to the translator object holding `t`,
  // e.g. react-i18next's `useTranslation(...)`. Namespaces are intentionally not
  // part of the key here: this tool maps one JSON file per locale, so react-i18next
  // keys are stored bare, without the `namespace:` prefix.
  function getTranslatorObjectNamespace(expression) {
    const unwrapped = unwrapExpression(expression);
    if (!unwrapped || !ts.isCallExpression(unwrapped)) return undefined;

    const calleeName = getCalleeName(unwrapped.expression);
    return REACT_I18NEXT_TRANSLATOR_CALLEES.has(calleeName) ? '' : undefined;
  }

  // Resolves an expression that evaluates to the translator function `t` itself.
  function getTranslatorNamespace(initializer) {
    const unwrapped = unwrapExpression(initializer);
    if (!unwrapped) return undefined;

    if (isReactI18next && ts.isPropertyAccessExpression(unwrapped) && unwrapped.name.text === 't') {
      return getTranslatorObjectNamespace(unwrapped.expression);
    }

    if (!ts.isCallExpression(unwrapped)) return undefined;

    const calleeName = getCalleeName(unwrapped.expression);

    if (isReactI18next) {
      return REACT_I18NEXT_FIXED_TRANSLATOR_CALLEES.has(calleeName) ? '' : undefined;
    }

    if (!NEXT_INTL_TRANSLATOR_CALLEES.has(calleeName)) {
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
    const normalized = namespace ? `${namespace}${namespaceSeparator}${key}` : key;
    keys.add(normalized);
  }

  function addKeyFromArgument(argument, namespace, label) {
    if (!argument) return;

    const key = getStaticText(argument);

    if (key === null) {
      warnings.push(createWarning(sourceFile, argument, `Skipped dynamic translation key for ${label}`));
      return;
    }

    if (key) addKey(namespace, key);
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

    if (ts.isVariableDeclaration(node) && node.initializer) {
      if (ts.isIdentifier(node.name)) {
        const namespace = getTranslatorNamespace(node.initializer);
        if (namespace !== undefined) {
          setBinding(node.name.text, namespace);
        }
      } else if (isReactI18next) {
        // `const {t} = useTranslation()` / `const [t] = useTranslation()`
        const namespace = getTranslatorObjectNamespace(node.initializer);
        const translatorName = namespace === undefined ? null : getDestructuredTranslatorName(node.name);

        if (translatorName) {
          setBinding(translatorName, namespace);
        }
      }
    }

    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const namespace = getBinding(node.expression.text);
      if (namespace !== undefined) {
        addKeyFromArgument(node.arguments[0], namespace, `"${node.expression.text}(...)"`);
      }
    }

    if (isReactI18next && ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 't') {
      // `i18n.t('key')` and `useTranslation().t('key')`
      const receiver = node.expression.expression;
      const isI18nInstance = I18N_INSTANCE_PATTERN.test(getInstanceName(receiver) || '');

      if (isI18nInstance || getTranslatorObjectNamespace(receiver) !== undefined) {
        addKeyFromArgument(node.arguments[0], '', '"t(...)"');
      }
    }

    if (isReactI18next && ts.isJsxAttribute(node) && ts.isIdentifier(node.name) && node.name.text === 'i18nKey' && node.initializer) {
      // `<Trans i18nKey="key" />`
      const initializer = ts.isJsxExpression(node.initializer) ? node.initializer.expression : node.initializer;
      addKeyFromArgument(initializer, '', '"i18nKey"');
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

function getTranslationTargetLanguages(localLanguages) {
  if (config.targetLanguages.length > 0) {
    const invalid = config.targetLanguages.filter(language => language === config.defaultLanguage);
    if (invalid.length > 0) {
      throw new Error(`Cannot translate into DEFAULT_LANGUAGE "${config.defaultLanguage}".`);
    }

    return [...config.targetLanguages].sort(compareStrings);
  }

  return localLanguages.filter(language => language !== config.defaultLanguage);
}

function getMissingTranslationItems(sourceMessages, targetMessages) {
  const items = [];
  const skippedEmptySourceKeys = [];

  for (const key of Object.keys(sourceMessages).sort(compareStrings)) {
    const sourceText = normalizeCellValue(sourceMessages[key]);
    const targetHasKey = hasOwn(targetMessages, key);
    const targetText = targetHasKey ? normalizeCellValue(targetMessages[key]) : '';

    if (targetHasKey && targetText !== '') {
      continue;
    }

    if (sourceText === '') {
      skippedEmptySourceKeys.push(key);
      continue;
    }

    items.push({
      key,
      sourceText,
    });
  }

  return {
    items,
    skippedEmptySourceKeys,
  };
}

function getOpenAiResponseText(responseBody) {
  if (!responseBody || typeof responseBody !== 'object') {
    return '';
  }

  if (typeof responseBody.output_text === 'string' && responseBody.output_text.trim()) {
    return responseBody.output_text.trim();
  }

  const parts = [];

  for (const item of responseBody.output || []) {
    if (!item || !Array.isArray(item.content)) continue;

    for (const content of item.content) {
      if (content?.type === 'output_text' && typeof content.text === 'string') {
        parts.push(content.text);
      } else if (content?.type === 'refusal') {
        const reason = typeof content.refusal === 'string' ? content.refusal : 'The model refused to translate the batch.';
        throw new Error(reason);
      }
    }
  }

  return parts.join('').trim();
}

async function translateBatchWithOpenAi(items, sourceLanguage, targetLanguage) {
  const sourceLanguageName = getLanguageDisplayName(sourceLanguage);
  const targetLanguageName = getLanguageDisplayName(targetLanguage);

  const requestBody = {
    model: config.openAiModel,
    instructions: [
      'You are a professional software localization translator.',
      `Translate from ${sourceLanguageName} (${sourceLanguage}) to ${targetLanguageName} (${targetLanguage}).`,
      'Return only data that matches the provided JSON schema.',
      'Do not translate message keys.',
      'Preserve placeholders, ICU variables, HTML/XML tags, percent-style placeholders, and line breaks exactly.',
      'Use concise, natural UI language.',
    ].join(' '),
    input: JSON.stringify({
      source_language: {
        code: sourceLanguage,
        name: sourceLanguageName,
      },
      target_language: {
        code: targetLanguage,
        name: targetLanguageName,
      },
      items: items.map(item => ({
        key: item.key,
        text: item.sourceText,
      })),
    }),
    text: {
      format: {
        type: 'json_schema',
        name: 'translation_batch',
        strict: true,
        schema: {
          type: 'object',
          properties: {
            translations: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  key: { type: 'string' },
                  text: { type: 'string' },
                },
                required: ['key', 'text'],
              },
            },
          },
          required: ['translations'],
        },
      },
    },
  };

  const responseBody = await withRetry(async () => {
    const response = await fetch(`${config.openAiBaseUrl}/responses`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.openAiApiKey}`,
      },
      body: JSON.stringify(requestBody),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message = data?.error?.message || `${response.status} ${response.statusText}`;
      throw new Error(`OpenAI API request failed: ${message}`);
    }

    return data;
  }, { retries: 2, baseMs: 1000 });

  const responseText = getOpenAiResponseText(responseBody);
  if (!responseText) {
    throw new Error('OpenAI API returned an empty translation response.');
  }

  let parsed;

  try {
    parsed = JSON.parse(responseText);
  } catch (error) {
    throw new Error(`Failed to parse OpenAI translation response: ${error.message}`);
  }

  if (!parsed || !Array.isArray(parsed.translations)) {
    throw new Error('OpenAI translation response did not include a "translations" array.');
  }

  const translationsByKey = new Map();

  for (const translation of parsed.translations) {
    if (!translation || typeof translation.key !== 'string' || typeof translation.text !== 'string') {
      throw new Error('OpenAI translation response contained an invalid translation item.');
    }

    translationsByKey.set(translation.key, translation.text);
  }

  return items.map(item => {
    if (!translationsByKey.has(item.key)) {
      throw new Error(`OpenAI translation response is missing key "${item.key}".`);
    }

    const translatedText = normalizeCellValue(translationsByKey.get(item.key));
    const tokenValidation = validatePlaceholderTokens(item.sourceText, translatedText);

    if (tokenValidation.missing.length > 0 || tokenValidation.unexpected.length > 0) {
      const details = [];

      if (tokenValidation.missing.length > 0) {
        details.push(`missing ${tokenValidation.missing.join(', ')}`);
      }

      if (tokenValidation.unexpected.length > 0) {
        details.push(`unexpected ${tokenValidation.unexpected.join(', ')}`);
      }

      throw new Error(
        `OpenAI translation for "${item.key}" did not preserve placeholder tokens: ${details.join('; ')}.`
      );
    }

    return {
      key: item.key,
      text: translatedText,
    };
  });
}

async function translateBatchWithDeepL(items, sourceLanguage, targetLanguage) {
  const responseBody = await withRetry(async () => {
    const response = await fetch(`${config.deeplApiUrl}/translate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `DeepL-Auth-Key ${config.deeplApiKey}`,
      },
      body: JSON.stringify({
        text: items.map(item => item.sourceText),
        source_lang: normalizeDeepLLanguageCode(sourceLanguage),
        target_lang: normalizeDeepLLanguageCode(targetLanguage),
        preserve_formatting: true,
        model_type: config.deeplModelType,
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message = data?.message || data?.detail || `${response.status} ${response.statusText}`;
      throw new Error(`DeepL API request failed: ${message}`);
    }

    return data;
  }, { retries: 2, baseMs: 1000 });

  if (!responseBody || !Array.isArray(responseBody.translations)) {
    throw new Error('DeepL API response did not include a "translations" array.');
  }

  if (responseBody.translations.length !== items.length) {
    throw new Error(`DeepL API returned ${responseBody.translations.length} translations for ${items.length} source text(s).`);
  }

  return items.map((item, index) => {
    const translatedText = normalizeCellValue(responseBody.translations[index]?.text);
    const tokenValidation = validatePlaceholderTokens(item.sourceText, translatedText);

    if (tokenValidation.missing.length > 0 || tokenValidation.unexpected.length > 0) {
      const details = [];

      if (tokenValidation.missing.length > 0) {
        details.push(`missing ${tokenValidation.missing.join(', ')}`);
      }

      if (tokenValidation.unexpected.length > 0) {
        details.push(`unexpected ${tokenValidation.unexpected.join(', ')}`);
      }

      throw new Error(
        `DeepL translation for "${item.key}" did not preserve placeholder tokens: ${details.join('; ')}.`
      );
    }

    return {
      key: item.key,
      text: translatedText,
    };
  });
}

async function translateBatchWithGoogle(items, sourceLanguage, targetLanguage) {
  const requestUrl = new URL(config.googleTranslateApiUrl);
  requestUrl.searchParams.set('key', config.googleTranslateApiKey);

  const responseBody = await withRetry(async () => {
    const response = await fetch(requestUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        q: items.map(item => item.sourceText),
        source: normalizeLocaleCode(sourceLanguage),
        target: normalizeLocaleCode(targetLanguage),
        format: 'text',
        model: config.googleTranslateModel,
      }),
    });

    const data = await response.json().catch(() => null);

    if (!response.ok) {
      const message = data?.error?.message || `${response.status} ${response.statusText}`;
      throw new Error(`Google Cloud Translation API request failed: ${message}`);
    }

    return data;
  }, { retries: 2, baseMs: 1000 });

  const translations = responseBody?.data?.translations;

  if (!Array.isArray(translations)) {
    throw new Error('Google Cloud Translation API response did not include a "data.translations" array.');
  }

  if (translations.length !== items.length) {
    throw new Error(
      `Google Cloud Translation API returned ${translations.length} translations for ${items.length} source text(s).`
    );
  }

  return items.map((item, index) => {
    const translatedText = decodeHtmlEntities(normalizeCellValue(translations[index]?.translatedText));
    const tokenValidation = validatePlaceholderTokens(item.sourceText, translatedText);

    if (tokenValidation.missing.length > 0 || tokenValidation.unexpected.length > 0) {
      const details = [];

      if (tokenValidation.missing.length > 0) {
        details.push(`missing ${tokenValidation.missing.join(', ')}`);
      }

      if (tokenValidation.unexpected.length > 0) {
        details.push(`unexpected ${tokenValidation.unexpected.join(', ')}`);
      }

      throw new Error(
        `Google Cloud Translation result for "${item.key}" did not preserve placeholder tokens: ${details.join('; ')}.`
      );
    }

    return {
      key: item.key,
      text: translatedText,
    };
  });
}

async function translateBatch(items, sourceLanguage, targetLanguage) {
  if (config.translationProvider === 'deepl') {
    return translateBatchWithDeepL(items, sourceLanguage, targetLanguage);
  }

  if (config.translationProvider === 'google') {
    return translateBatchWithGoogle(items, sourceLanguage, targetLanguage);
  }

  return translateBatchWithOpenAi(items, sourceLanguage, targetLanguage);
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
    const messages = unflattenMessages(byLanguage[language]);
    const changed = await writeJsonFileIfChanged(filePath, messages);

    if (changed) {
      changedFiles += 1;
      const prefix = config.dryRun ? '[dry-run] Would write' : 'Wrote';
      console.log(`${prefix} ${path.relative(PROJECT_ROOT, filePath)}`);
    }
  }

  console.log(`Download complete. ${changedFiles}/${languages.length} file(s) changed.`);
}

async function syncLocalMessagesToSheet(local, options = {}) {
  const {
    fillEmpty = false,
    updateExisting = false,
    keys = local.keys,
    operationName = 'Upload',
    shouldAddRow = () => true,
    shouldSyncCell = () => true,
  } = options;

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
  const targetKeys = [...keys].sort(compareStrings);

  if (duplicateKeys.length > 0) {
    console.warn(`Duplicate keys found in sheet, last row wins during ${operationName.toLowerCase()}: ${duplicateKeys.join(', ')}`);
  }

  for (const key of targetKeys) {
    const existingRow = rowsByKey.get(key);
    if (!existingRow) {
      if (shouldAddRow(key)) {
        rowsToAdd.push(buildRowFromLocal(key, sheetLanguages, local.byLanguage));
      }
      continue;
    }

    let rowChanged = false;

    for (const language of sheetLanguages) {
      const localValue = local.byLanguage[language]?.[key];
      if (localValue === undefined || !shouldSyncCell(key, language, localValue)) continue;

      const sheetValue = normalizeCellValue(existingRow.get(language));

      if (updateExisting) {
        if (sheetValue !== localValue) {
          existingRow.set(language, localValue);
          rowChanged = true;
          updatedCellCount += 1;
        }
        continue;
      }

      if (fillEmpty && sheetValue === '' && localValue !== '') {
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
    console.log(`${operationName} complete. No sheet changes required.`);
    return {
      rowsAdded: 0,
      rowsUpdated: 0,
      updatedCellCount: 0,
    };
  }

  if (config.dryRun) {
    console.log(`[dry-run] Would add ${rowsToAdd.length} row(s).`);
    console.log(`[dry-run] Would update ${rowsToSave.length} existing row(s), ${updatedCellCount} cell(s).`);
    return {
      rowsAdded: rowsToAdd.length,
      rowsUpdated: rowsToSave.length,
      updatedCellCount,
    };
  }

  if (rowsToAdd.length > 0) {
    await withRetry(() => sheet.addRows(rowsToAdd));
  }

  for (const row of rowsToSave) {
    await withRetry(() => row.save());
  }

  console.log(`${operationName} complete. Added ${rowsToAdd.length} row(s), updated ${rowsToSave.length} row(s), ${updatedCellCount} cell(s).`);

  return {
    rowsAdded: rowsToAdd.length,
    rowsUpdated: rowsToSave.length,
    updatedCellCount,
  };
}

async function uploadTranslations() {
  const local = await getLocalMessagesByLanguage();

  await syncLocalMessagesToSheet(local, {
    fillEmpty: config.fillEmpty,
    updateExisting: config.updateExisting,
    operationName: 'Upload',
  });
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

async function translateMissingMessages() {
  const local = await getLocalMessagesByLanguage();
  const localByLanguage = Object.fromEntries(
    Object.entries(local.byLanguage).map(([language, messages]) => [language, { ...messages }])
  );
  const sourceMessages = localByLanguage[config.defaultLanguage];

  if (!sourceMessages) {
    throw new Error(`Default language "${config.defaultLanguage}" was not found locally.`);
  }

  const targetLanguages = getTranslationTargetLanguages(local.languages);
  const batchSize = getTranslationProviderBatchSize();

  if (targetLanguages.length === 0) {
    throw new Error(
      `No target languages found. Add locale files next to "${config.defaultLanguage}.json" or pass --language=<locale>.`
    );
  }

  let translatedLanguageCount = 0;
  let translatedKeyCount = 0;
  let skippedEmptySourceCount = 0;
  const translatedKeys = new Set();
  const translatedCells = new Set();

  for (const language of targetLanguages) {
    const targetMessages = localByLanguage[language] || {};
    localByLanguage[language] = targetMessages;
    const { items, skippedEmptySourceKeys } = getMissingTranslationItems(sourceMessages, targetMessages);
    skippedEmptySourceCount += skippedEmptySourceKeys.length;

    if (items.length === 0) {
      console.log(`No missing translations for ${language}.`);
      continue;
    }

    if (config.dryRun) {
      console.log(`[dry-run] Would translate ${items.length} key(s) into ${language}.`);

      for (const item of items) {
        targetMessages[item.key] = item.sourceText;
        translatedKeys.add(item.key);
        translatedCells.add(getCellSyncId(language, item.key));
      }

      if (config.verbose) {
        for (const item of items) {
          console.log(`- ${language}: ${item.key}`);
        }
      }
      translatedLanguageCount += 1;
      translatedKeyCount += items.length;
      continue;
    }

    console.log(`Translating ${items.length} key(s) into ${language} with ${getTranslationProviderDetails()}...`);

    for (const batch of chunkValues(items, batchSize)) {
      const translatedBatch = await translateBatch(batch, config.defaultLanguage, language);

      for (const item of translatedBatch) {
        targetMessages[item.key] = item.text;
        translatedKeys.add(item.key);
        translatedCells.add(getCellSyncId(language, item.key));
      }
    }

    const filePath = path.join(config.translationsDir, `${language}.json`);
    const changed = await writeJsonFileIfChanged(filePath, unflattenMessages(targetMessages));

    translatedLanguageCount += 1;
    translatedKeyCount += items.length;

    if (changed) {
      console.log(`Wrote ${path.relative(PROJECT_ROOT, filePath)}`);
    } else {
      console.log(`No file changes for ${language}.`);
    }

    if (config.verbose && skippedEmptySourceKeys.length > 0) {
      for (const key of skippedEmptySourceKeys) {
        console.warn(`- ${language}: skipped "${key}" because the source message is empty.`);
      }
    }
  }

  const translatedLocal = buildLocalMessagesSnapshot(localByLanguage);

  if (skippedEmptySourceCount > 0 && !config.verbose) {
    console.warn(
      `Skipped ${skippedEmptySourceCount} key(s) because the source language value was empty. Re-run with --verbose to list them.`
    );
  }

  if (config.toSheet) {
    if (translatedKeys.size === 0) {
      console.log(`${config.dryRun ? '[dry-run] ' : ''}Skipping sheet sync because no translations were generated.`);
    } else {
      console.log(`${config.dryRun ? '[dry-run] Would sync' : 'Syncing'} translated values to Google Sheets...`);
      await syncLocalMessagesToSheet(translatedLocal, {
        fillEmpty: true,
        updateExisting: false,
        keys: [...translatedKeys],
        operationName: 'Sheet sync',
        shouldAddRow: key => translatedKeys.has(key),
        shouldSyncCell: (key, language) => translatedCells.has(getCellSyncId(language, key)),
      });
    }
  }

  if (config.dryRun) {
    console.log(
      `[dry-run] Translation complete. Would add ${translatedKeyCount} translation(s) across ${translatedLanguageCount} language(s).`
    );
    return;
  }

  console.log(`Translation complete. Added ${translatedKeyCount} translation(s) across ${translatedLanguageCount} language(s).`);
}

function printUsage() {
  console.log(`Usage:
  ${CLI_NAME} download [--dry-run] [--key-separator=.|false]
  ${CLI_NAME} upload [--dry-run] [--fill-empty] [--update-existing] [--key-separator=.|false]
  ${CLI_NAME} find-new [--dry-run] [--verbose] [--framework=next-intl|react-i18next]
  ${CLI_NAME} translate-missing [--dry-run] [--verbose] [--language=en] [--provider=openai|deepl|google] [--model=gpt-5-mini] [--batch-size=25] [--to-sheet]

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
  TRANSLATIONS_FRAMEWORK=next-intl # optional: next-intl, react-i18next
  TRANSLATIONS_KEY_SEPARATOR=. # optional, "false" keeps flat keys as-is
  TRANSLATION_PROVIDER=openai # optional: openai, deepl, google
  TRANSLATION_BATCH_SIZE=25 # optional
  OPENAI_API_KEY=...
  OPENAI_TRANSLATION_MODEL=gpt-5-mini # optional
  OPENAI_BASE_URL=https://api.openai.com/v1 # optional
  DEEPL_API_KEY=...
  DEEPL_API_URL=https://api-free.deepl.com/v2 # optional
  DEEPL_MODEL_TYPE=prefer_quality_optimized # optional
  GOOGLE_TRANSLATE_API_KEY=...
  GOOGLE_TRANSLATE_API_URL=https://translation.googleapis.com/language/translate/v2 # optional
  GOOGLE_TRANSLATE_MODEL=nmt # optional
  TRANSLATIONS_PROJECT_ROOT=/path/to/project # optional, shell env only, defaults to cwd

Setup:
  1. Copy .env.example to .env
  2. Fill in your project values
  3. Run one of the commands below

Examples:
  ${CLI_NAME} download
  ${CLI_NAME} upload --fill-empty
  ${CLI_NAME} upload --update-existing
  ${CLI_NAME} find-new --dry-run --verbose
  ${CLI_NAME} find-new --framework=react-i18next --dry-run
  ${CLI_NAME} download --key-separator=false
  ${CLI_NAME} translate-missing --language=en --dry-run
  ${CLI_NAME} translate-missing --language=en,de --provider=deepl
  ${CLI_NAME} translate-missing --language=de --provider=google
  ${CLI_NAME} translate-missing --language=en --to-sheet`);
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

    ensureEnvConfig(executableCommands);

    for (const command of executableCommands) {
      if (command === 'download') {
        await downloadTranslations();
      } else if (command === 'upload') {
        await uploadTranslations();
      } else if (command === 'find-new') {
        await findNewKeys();
      } else if (command === 'translate-missing') {
        await translateMissingMessages();
      }
    }
  } catch (error) {
    console.error('Error:', error && error.message ? error.message : error);
    process.exitCode = 1;
  }
}

export const __internal = {
  config,
  extractPlaceholderTokens,
  parseFramework,
  parseKeySeparator,
  collectSourceTranslationKeys,
  extractTranslationKeysFromSource,
  flattenMessages,
  getMissingTranslationItems,
  getOpenAiResponseText,
  getTranslationTargetLanguages,
  getLocalMessagesByLanguage,
  validatePlaceholderTokens,
  unflattenMessages,
};
