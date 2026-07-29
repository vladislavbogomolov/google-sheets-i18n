# `google-sheets-i18n`

[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![semantic-release: angular](https://img.shields.io/badge/semantic--release-angular-e10079?logo=semantic-release)](https://github.com/semantic-release/semantic-release)

CLI package for syncing `next-intl` and `react-i18next` JSON translations with Google Sheets.

It is designed for projects where translations live in locale files such as `src/messages/it.json`, while editors work in a Google Sheet.

## TL;DR

Install the package, add a few environment variables, then use:

```bash
npx google-sheets-i18n download
npx google-sheets-i18n upload --fill-empty
npx google-sheets-i18n find-new --dry-run --verbose
npx google-sheets-i18n translate-missing --language=en --dry-run
npx google-sheets-i18n translate-missing --language=de --provider=deepl
npx google-sheets-i18n translate-missing --language=en --to-sheet
```

Best for projects that:

- store translations in one JSON file per locale
- use nested `next-intl` messages or flat `react-i18next` resources
- manage translation editing in Google Sheets

## What It Does

- Downloads translations from Google Sheets into local JSON files
- Uploads local translation keys and values into Google Sheets
- Supports nested JSON and stores sheet keys in dot notation like `nav.profile`
- Supports flat locale files whose keys may contain dots, via `TRANSLATIONS_KEY_SEPARATOR=false`
- Scans source files for `next-intl` (`useTranslations`, `getTranslations`) or `react-i18next` (`useTranslation`, `getFixedT`, `i18n.t`, `<Trans i18nKey>`) usage, selected with `TRANSLATIONS_FRAMEWORK`
- Can draft missing local translations with OpenAI, DeepL, or Google Cloud Translation from your `DEFAULT_LANGUAGE`
- Warns about dynamic translation keys that cannot be resolved statically

## Requirements

- Node.js `18+`
- A Google service account with access to the spreadsheet
- A spreadsheet tab where:
  - the first column is `key`
  - the other columns are language codes like `it`, `en`, `de`

## Installation

Install the package as a dev dependency:

```bash
npm install --save-dev google-sheets-i18n
```

With `pnpm`:

```bash
pnpm add -D google-sheets-i18n
```

With `yarn`:

```bash
yarn add -D google-sheets-i18n
```

## Releases

Releases are automated with GitHub Actions and `semantic-release`.

Commits that affect package versions should follow Conventional Commits:

- `fix:` publishes a patch release
- `feat:` publishes a minor release
- `BREAKING CHANGE:` or `feat!:` publishes a major release

The release workflow runs on `master` and `main`, publishes to npm, updates `package.json`, and generates `CHANGELOG.md`.

To enable npm publishing, add the `NPM_TOKEN` repository secret in GitHub. `GITHUB_TOKEN` is provided automatically by GitHub Actions.

If you keep the current non-conventional commit history, the first automated release will happen only after the next release-worthy commit such as `feat:` or `fix:`. If you want to align history immediately, create the initial tag manually before enabling the workflow.

## Quick Start

1. Create a Google service account and enable the Google Sheets API.
2. Share the spreadsheet with the service account email.
3. Create a worksheet tab for translations.
4. Set the first row headers, for example:

```text
key | it | en | de
```

5. Copy your environment template:

```bash
cp .env.example .env
```

6. Fill the required variables in `.env`.
7. Run one of the commands:

```bash
npx google-sheets-i18n download
npx google-sheets-i18n upload --fill-empty
npx google-sheets-i18n find-new --dry-run --verbose
npx google-sheets-i18n translate-missing --language=en
npx google-sheets-i18n translate-missing --language=en --to-sheet
```

## Configuration

The package reads `.env` and `.env.local` from the current project directory.

Example:

```env
GOOGLE_SHEET_ID=your_spreadsheet_id
GOOGLE_SHEET_TITLE=Translations

GOOGLE_SERVICE_ACCOUNT_EMAIL=service-account@project-id.iam.gserviceaccount.com
GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"

TRANSLATIONS_DIR=src/messages
TRANSLATIONS_SOURCE_DIR=src
DEFAULT_LANGUAGE=it

TRANSLATION_PROVIDER=openai
TRANSLATION_BATCH_SIZE=25

OPENAI_API_KEY=your_openai_api_key
OPENAI_TRANSLATION_MODEL=gpt-5-mini
```

Required variables:

- `GOOGLE_SHEET_ID`
  Spreadsheet ID from the Google Sheets URL.
- `GOOGLE_SHEET_TITLE`
  Worksheet tab name inside the spreadsheet, not the spreadsheet document title.
- `TRANSLATIONS_DIR`
  Directory with locale JSON files such as `src/messages/it.json`.
- `TRANSLATIONS_SOURCE_DIR`
  Directory to scan for translation key usage, usually `src`.
- `DEFAULT_LANGUAGE`
  Expected base locale for the project. It should exist locally.

Authentication options:

- Recommended: `GOOGLE_SERVICE_ACCOUNT_EMAIL` + `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`
- Alternative: `GOOGLE_SERVICE_ACCOUNT_JSON`
- Alternative: `GOOGLE_APPLICATION_CREDENTIALS`

Optional variable:

- `TRANSLATIONS_PROJECT_ROOT`
  Use this when you run the CLI from another directory and want it to operate on a different project root.
- `TRANSLATIONS_FRAMEWORK`
  Which i18n library `find-new` should scan for. Supported values: `next-intl`, `react-i18next` (alias: `i18next`). Default: `next-intl`.
- `TRANSLATIONS_KEY_SEPARATOR`
  Separator used to map nested JSON to sheet keys. Default: `.`. Set it to `false` (also `none`, `off`, `flat`, or an empty value) to keep locale files flat and treat sheet keys literally, which is what you want when keys are whole sentences or contain dots.
- `TRANSLATION_PROVIDER`
  Optional translation driver for `translate-missing`. Supported values: `openai`, `deepl`, `google`. Default: `openai`.
- `TRANSLATION_BATCH_SIZE`
  Optional provider-agnostic batch size for `translate-missing`. Default: `25`.
- `OPENAI_API_KEY`
  Required only when `TRANSLATION_PROVIDER=openai`.
- `OPENAI_TRANSLATION_MODEL`
  Optional model override for OpenAI. Default: `gpt-5-mini`.
- `OPENAI_BASE_URL`
  Optional API base URL override. Default: `https://api.openai.com/v1`.
- `DEEPL_API_KEY`
  Required only when `TRANSLATION_PROVIDER=deepl`.
- `DEEPL_API_URL`
  Optional DeepL API base URL. Default: `https://api-free.deepl.com/v2`.
- `DEEPL_MODEL_TYPE`
  Optional DeepL model type. Default: `prefer_quality_optimized`.
- `GOOGLE_TRANSLATE_API_KEY`
  Required only when `TRANSLATION_PROVIDER=google`.
- `GOOGLE_TRANSLATE_API_URL`
  Optional Google Translation Basic v2 endpoint. Default: `https://translation.googleapis.com/language/translate/v2`.
- `GOOGLE_TRANSLATE_MODEL`
  Optional Google Translation model. Default: `nmt`.

## Expected Local Structure

The package expects one JSON file per locale:

```text
src/messages/
  it.json
  en.json
  de.json
```

Nested JSON is supported. For example:

```json
{
  "nav": {
    "profile": "Profilo"
  }
}
```

In Google Sheets this becomes:

```text
key          | it
nav.profile  | Profilo
```

### Flat locale files

`react-i18next` projects often keep one flat object per locale, where the key is the source phrase itself and may contain dots:

```json
{
  "Data di arrivo": "Arrivo",
  "The birthday does not match the format d.m.Y.": "Formato non valido."
}
```

Set `TRANSLATIONS_KEY_SEPARATOR=false` for those projects. Keys are then read from and written to the sheet verbatim, and `download` never splits them into nested objects. With nesting disabled, a nested object in a locale file is reported as an error instead of being flattened silently.

## Expected Spreadsheet Structure

The worksheet tab must contain:

- a `key` column as the first header
- one column per language, for example `it`, `en`, `de`
- one row per translation key

Example:

```text
key                | it            | en
nav.profile        | Profilo       | Profile
breadcrumb.home    | Home          | Home
```

If local JSON files contain languages that are missing in the sheet, the package adds those columns automatically during `upload` and `find-new`.

## Commands

If you are not sure which command you need:

- The sheet changed and you want local files updated: `download`
- Local files changed and you want the sheet updated: `upload`
- You added new translation keys in code and they are missing in the sheet: `find-new`
- A locale file has missing translations and you want draft text generated automatically: `translate-missing`

Quick summary:

| Command | What it is for |
| --- | --- |
| `download` | Pull translations from Google Sheets into local JSON files |
| `upload` | Push local JSON translations into Google Sheets |
| `find-new` | Find translation keys in code and add them to Google Sheets |
| `translate-missing` | Fill missing local translations with OpenAI, DeepL, or Google |

### `download`

Copies translations from Google Sheets into your local locale files.

```bash
google-sheets-i18n download
```

Run this when translators changed Google Sheets and you want the same data in local JSON files.

What happens:

- reads the sheet
- builds locale JSON files from the sheet data
- updates files in `TRANSLATIONS_DIR`

Good to know:

- this command updates local files from the sheet
- if the sheet changed, your local files will change too
- `--dry-run` only shows what would be written

Options:

- `--dry-run`
  Shows which files would be written without changing them.
- `--key-separator=<separator|false>`
  Overrides `TRANSLATIONS_KEY_SEPARATOR` for a single run. Use `false` to write flat files.

### `upload`

Copies local translations into Google Sheets.

```bash
google-sheets-i18n upload
```

Run this when local JSON files changed and you want those changes in Google Sheets.

Default behavior:

- adds missing keys as new rows
- does not overwrite existing sheet values
- does not fill existing empty cells unless you ask for it

What happens:

- reads local locale files
- adds missing keys to the sheet
- optionally fills empty cells in the sheet
- can fully update existing rows if you allow it

Good to know:

- plain `upload` is safe by default
- it does not overwrite existing sheet values unless you ask it to
- `--fill-empty` only fills blank cells
- `--update-existing` fully syncs local values into existing rows

Options:

- `--dry-run`
  Shows what would change without writing to Google Sheets.
- `--fill-empty`
  Fills only empty cells in existing rows.
- `--update-existing`
  Fully syncs local values into existing rows, including non-empty cells.
- `--key-separator=<separator|false>`
  Overrides `TRANSLATIONS_KEY_SEPARATOR` for a single run.

Examples:

```bash
google-sheets-i18n upload --fill-empty
google-sheets-i18n upload --update-existing
```

### `find-new`

Finds translation keys used in code and adds missing ones to Google Sheets.

```bash
google-sheets-i18n find-new
```

Run this when developers added new translation keys in code and those keys are not yet in Google Sheets.

What it looks for depends on `TRANSLATIONS_FRAMEWORK`.

With `next-intl` (default):

- `useTranslations('namespace')`
- `getTranslations('namespace')`
- static calls like `t('title')`, stored as `namespace.title`

With `react-i18next`:

- `const {t} = useTranslation()` and `const [t] = useTranslation()`, including renames like `const {t: tCard} = useTranslation()`
- `useTranslation().t` and `getFixedT(...)`
- `i18n.t('key')` and `i18next.t('key')`
- `<Trans i18nKey="key" />`
- namespaces are ignored, because this tool maps one JSON file per locale, so keys are stored bare without a `namespace:` prefix

Result:

- new keys found in source code are added to the sheet
- if a key exists locally, its values are written into language columns
- if a key does not exist locally, it is created in the sheet with empty values

What happens:

- scans your source files
- finds translation keys used in code
- adds missing keys to the sheet

Good to know:

- it works best with static keys
- dynamic keys are skipped on purpose
- if a key already exists locally, its current values are added to the new row
- if a key does not exist locally, the row is added with empty values

Options:

- `--dry-run`
  Shows how many keys would be added.
- `--verbose`
  Shows every skipped dynamic key warning and a detailed list of missing local keys.
- `--framework=<next-intl|react-i18next>`
  Overrides `TRANSLATIONS_FRAMEWORK` for a single run.

### `translate-missing`

Generates draft translations for missing local values using `DEFAULT_LANGUAGE` as the source.

```bash
google-sheets-i18n translate-missing --language=en
```

Run this when one locale has missing translations and you want draft text generated automatically.

Default behavior:

- translates only missing or empty values
- never overwrites existing non-empty translations
- uses the default locale JSON file as the source language
- writes results back into local JSON files
- with `--to-sheet`, syncs only the translations generated in the current run into Google Sheets
- uses the configured provider from `--provider` or `TRANSLATION_PROVIDER`

What happens:

- uses `DEFAULT_LANGUAGE` as the source locale
- finds empty or missing values in target locales
- generates draft translations with the selected provider
- writes only the missing values

Good to know:

- this command fills gaps, not everything
- existing non-empty translations stay untouched
- placeholders like `{name}` are checked after translation
- machine translation should usually be reviewed by a human
- `--to-sheet` sends only the newly generated values to Google Sheets

Options:

- `--dry-run`
  Shows how many keys would be translated without changing files.
- `--verbose`
  Prints the translated key list and skipped empty-source keys.
- `--language=<locale>`
  Target locale to translate. Repeat or comma-separate values like `--language=en,de`.
- `--provider=<openai|deepl|google>`
  Selects the translation driver for this run. Default: `openai`.
- `--model=<model>`
  Overrides `OPENAI_TRANSLATION_MODEL` for this run when `--provider=openai`.
- `--batch-size=<number>`
  Overrides `TRANSLATION_BATCH_SIZE` for this run.
- `--to-sheet`
  After translation, fills matching empty cells in Google Sheets without overwriting existing sheet values.

Examples:

```bash
google-sheets-i18n translate-missing --language=en --dry-run
google-sheets-i18n translate-missing --language=en,de
google-sheets-i18n translate-missing --language=de --provider=openai --model=gpt-5-mini
google-sheets-i18n translate-missing --language=de --provider=deepl
google-sheets-i18n translate-missing --language=de --provider=google
google-sheets-i18n translate-missing --language=en --to-sheet
```

Notes:

- placeholders such as `{name}`, `{{name}}`, `%s`, and HTML/XML tags are validated after translation
- existing translations are left untouched
- if you omit `--language`, the command translates every existing locale file except `DEFAULT_LANGUAGE`
- `--to-sheet` requires the same Google Sheets credentials as `upload`
- `--to-sheet` only fills sheet cells for the keys translated in the current run, so it stays narrower than a full `upload --fill-empty`
- `DeepL` uppercases locale codes before calling the API, so locales like `en-GB` become `EN-GB`
- `Google` integration uses the Cloud Translation Basic v2 REST API with an API key

## Dynamic Keys

Static analysis works best for keys like:

```ts
const t = useTranslations('nav');
t('profile');
```

Dynamic keys such as template strings with variables cannot be resolved safely:

```ts
t(`locales.${locale}`);
```

These cases are skipped and reported as warnings. Re-run with `--verbose` to see the full list.

## Recommended `package.json` Scripts

```json
{
  "scripts": {
    "translations:download": "google-sheets-i18n download",
    "translations:upload": "google-sheets-i18n upload --fill-empty",
    "translations:sync": "google-sheets-i18n upload --update-existing",
    "translations:find-new": "google-sheets-i18n find-new --dry-run --verbose",
    "translations:translate:en": "google-sheets-i18n translate-missing --language=en",
    "translations:translate:en:deepl": "google-sheets-i18n translate-missing --language=en --provider=deepl",
    "translations:translate:en:sheet": "google-sheets-i18n translate-missing --language=en --to-sheet"
  }
}
```

## Typical Workflow

1. Translators update the Google Sheet.
2. Run `google-sheets-i18n download` to refresh local locale files.
3. Developers add new translation calls in code.
4. Run `google-sheets-i18n find-new` to add new keys to the sheet.
5. Optionally run `google-sheets-i18n translate-missing --language=en` to draft local translations.
6. If you want the generated drafts in Google Sheets immediately, run `google-sheets-i18n translate-missing --language=en --to-sheet`.
7. Run `google-sheets-i18n upload --fill-empty` to backfill any remaining missing sheet values from local JSON.

## Troubleshooting

### Missing required environment variables

If the CLI says that required environment variables are missing:

- make sure `.env` exists in the project root
- check that variable names match exactly
- if you run the command from another directory, set `TRANSLATIONS_PROJECT_ROOT`

### Sheet not found

If you get `Sheet "..." not found`:

- `GOOGLE_SHEET_ID` must be the spreadsheet document ID from the URL
- `GOOGLE_SHEET_TITLE` must be the worksheet tab name inside that spreadsheet

### Permission denied from Google

If Google rejects the request:

- verify that the Google Sheets API is enabled
- share the spreadsheet with the service account email
- make sure the private key and service account email belong to the same service account

### Private key format issues

If authentication fails and you use inline credentials:

- keep the private key wrapped in quotes
- preserve `\n` line breaks exactly as shown in the example
- avoid trimming the `-----BEGIN PRIVATE KEY-----` and `-----END PRIVATE KEY-----` lines

### Dynamic keys were skipped

If `find-new` warns about skipped keys:

- static keys like `t('profile')` are supported
- dynamic expressions like ``t(`locales.${locale}`)`` cannot be resolved safely
- re-run with `--verbose` to see every skipped location

### `find-new` finds nothing

If `find-new` reports no keys even though the code clearly uses translations:

- check `TRANSLATIONS_FRAMEWORK` — a `react-i18next` project scanned with the default `next-intl` matchers finds nothing
- `--framework=react-i18next` overrides it for one run

### Download nested my flat keys

If `download` turned keys such as `Format d.m.Y.` into nested objects:

- set `TRANSLATIONS_KEY_SEPARATOR=false` and run `download` again

### Machine translation failed

If `translate-missing` fails:

- verify that the API key for the selected provider is set
- check that the selected provider is one of `openai`, `deepl`, or `google`
- if you use OpenAI, check that the selected model exists for your account
- try a smaller `TRANSLATION_BATCH_SIZE`, for example `10`
- if a placeholder validation error appears, review the affected string before retrying

### No files changed during download

If `download` finishes but nothing changes locally:

- the sheet values may already match your JSON files
- the worksheet may not contain language columns yet
- check that your language headers match local file names like `it.json` -> `it`

### Duplicate keys in the sheet

If the CLI reports duplicate keys:

- the last matching row wins
- clean up duplicates in Google Sheets to avoid confusing sync behavior

## Notes

- The package works with `next-intl` style nested JSON files, and with flat `react-i18next` resources when `TRANSLATIONS_KEY_SEPARATOR=false`.
- Source scanning supports `.js`, `.jsx`, `.ts`, and `.tsx`.
- If duplicate keys exist in the sheet, the last row wins and a warning is shown.
- The package automatically reads `.env` before validation, so it works well in CI and local development.
