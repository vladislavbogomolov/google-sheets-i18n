# `google-sheets-i18n`

[![Node.js >=18](https://img.shields.io/badge/node-%3E%3D18-339933?logo=node.js&logoColor=white)](https://nodejs.org/)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)

CLI package for syncing `next-intl` style JSON translations with Google Sheets.

It is designed for projects where translations live in locale files such as `src/messages/it.json`, while editors work in a Google Sheet.

## TL;DR

Install the package, add a few environment variables, then use:

```bash
npx google-sheets-i18n download
npx google-sheets-i18n upload --fill-empty
npx google-sheets-i18n find-new --dry-run --verbose
```

Best for projects that:

- store translations in one JSON file per locale
- use nested `next-intl` messages
- manage translation editing in Google Sheets

## What It Does

- Downloads translations from Google Sheets into local JSON files
- Uploads local translation keys and values into Google Sheets
- Supports nested JSON and stores sheet keys in dot notation like `nav.profile`
- Scans source files for `useTranslations(...)` and `getTranslations(...)`
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

### `download`

Downloads all translations from the worksheet and writes them into local JSON files.

```bash
google-sheets-i18n download
```

Useful when translators changed the Google Sheet and you want to refresh local files.

Options:

- `--dry-run`
  Shows which files would be written without changing them.

### `upload`

Uploads local translations into the worksheet.

```bash
google-sheets-i18n upload
```

Default behavior:

- adds missing keys as new rows
- does not overwrite existing sheet values
- does not fill existing empty cells unless you ask for it

Options:

- `--dry-run`
  Shows what would change without writing to Google Sheets.
- `--fill-empty`
  Fills only empty cells in existing rows.
- `--update-existing`
  Fully syncs local values into existing rows, including non-empty cells.

Examples:

```bash
google-sheets-i18n upload --fill-empty
google-sheets-i18n upload --update-existing
```

### `find-new`

Scans source files for translation keys and adds missing keys to the worksheet.

```bash
google-sheets-i18n find-new
```

What it looks for:

- `useTranslations('namespace')`
- `getTranslations('namespace')`
- static calls such as `t('title')`

Result:

- new keys found in source code are added to the sheet
- if a key exists locally, its values are written into language columns
- if a key does not exist locally, it is created in the sheet with empty values

Options:

- `--dry-run`
  Shows how many keys would be added.
- `--verbose`
  Shows every skipped dynamic key warning and a detailed list of missing local keys.

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
    "translations:find-new": "google-sheets-i18n find-new --dry-run --verbose"
  }
}
```

## Typical Workflow

1. Translators update the Google Sheet.
2. Run `google-sheets-i18n download` to refresh local locale files.
3. Developers add new translation calls in code.
4. Run `google-sheets-i18n find-new` to add new keys to the sheet.
5. Run `google-sheets-i18n upload --fill-empty` to backfill missing sheet values from local JSON.

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

- The package works with `next-intl` style nested JSON files.
- Source scanning supports `.js`, `.jsx`, `.ts`, and `.tsx`.
- If duplicate keys exist in the sheet, the last row wins and a warning is shown.
- The package automatically reads `.env` before validation, so it works well in CI and local development.
