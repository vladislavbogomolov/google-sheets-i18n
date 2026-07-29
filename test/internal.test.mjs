import assert from 'node:assert/strict';
import test from 'node:test';

import { __internal } from '../src/index.mjs';

const {
  extractTranslationKeysFromSource,
  flattenMessages,
  parseFramework,
  parseKeySeparator,
  unflattenMessages,
} = __internal;

test('parseKeySeparator disables nesting for falsy-ish values', () => {
  assert.equal(parseKeySeparator('.'), '.');
  assert.equal(parseKeySeparator('_'), '_');
  assert.equal(parseKeySeparator(''), null);
  assert.equal(parseKeySeparator('false'), null);
  assert.equal(parseKeySeparator('NONE'), null);
  assert.equal(parseKeySeparator(undefined), null);
});

test('parseFramework normalizes aliases', () => {
  assert.equal(parseFramework(''), 'next-intl');
  assert.equal(parseFramework('next-intl'), 'next-intl');
  assert.equal(parseFramework('i18next'), 'react-i18next');
  assert.equal(parseFramework('React-I18next'), 'react-i18next');
  assert.equal(parseFramework('vue-i18n'), 'vue-i18n');
});

test('flattenMessages joins nested keys with the configured separator', () => {
  const messages = { nav: { profile: 'Profilo' }, title: 'Ciao' };

  assert.deepEqual(flattenMessages(messages, { keySeparator: '.' }), {
    'nav.profile': 'Profilo',
    title: 'Ciao',
  });
  assert.deepEqual(flattenMessages(messages, { keySeparator: '_' }), {
    nav_profile: 'Profilo',
    title: 'Ciao',
  });
});

test('flattenMessages keeps dotted flat keys intact when nesting is disabled', () => {
  const messages = {
    'The birthday does not match the format d.m.Y.': 'Formato non valido.',
    'reservation.added': 'Aggiunta',
  };

  assert.deepEqual(flattenMessages(messages, { keySeparator: null }), messages);
});

test('flattenMessages rejects nested objects when nesting is disabled', () => {
  assert.throws(
    () => flattenMessages({ nav: { profile: 'Profilo' } }, { keySeparator: null }),
    /Nested object at "nav" is not supported/
  );
});

test('unflattenMessages nests dot notation and round-trips with flattenMessages', () => {
  const flat = { 'nav.profile': 'Profilo', title: 'Ciao' };
  const nested = unflattenMessages(flat, { keySeparator: '.' });

  assert.deepEqual(nested, { nav: { profile: 'Profilo' }, title: 'Ciao' });
  assert.deepEqual(flattenMessages(nested, { keySeparator: '.' }), flat);
});

test('unflattenMessages keeps keys flat and sorted when nesting is disabled', () => {
  const flat = {
    'reservation.added': 'Aggiunta',
    'A key': 'Valore',
  };

  const result = unflattenMessages(flat, { keySeparator: null });

  assert.deepEqual(result, flat);
  assert.deepEqual(Object.keys(result), ['A key', 'reservation.added']);
});

test('next-intl scanning prefixes keys with the namespace', () => {
  const source = `
    import { useTranslations } from 'next-intl';

    export function Nav() {
      const t = useTranslations('nav');
      const tRoot = useTranslations();
      return [t('profile'), tRoot('title')];
    }
  `;

  const { keys } = extractTranslationKeysFromSource(source, 'nav.tsx', { framework: 'next-intl' });

  assert.deepEqual(keys, ['nav.profile', 'title']);
});

test('react-i18next scanning collects keys from destructured translators', () => {
  const source = `
    import { useTranslation, Trans } from 'react-i18next';
    import i18n from './i18n';

    export function Card() {
      const { t } = useTranslation();
      const { t: tAlias } = useTranslation('other');
      const [tArray] = useTranslation();
      const tFixed = i18n.getFixedT('en');
      const tProp = useTranslation().t;

      return (
        <div title={t('Data di arrivo')}>
          {tAlias('Cognome')}
          {tArray('Adulti')}
          {tFixed('reservation.added')}
          {tProp('Aggiorna risultato')}
          {i18n.t('The birthday does not match the format d.m.Y.')}
          <Trans i18nKey="Accetto la normativa sulla privacy" />
        </div>
      );
    }
  `;

  const { keys } = extractTranslationKeysFromSource(source, 'card.tsx', {
    framework: 'react-i18next',
    keySeparator: null,
  });

  assert.deepEqual(keys, [
    'Accetto la normativa sulla privacy',
    'Adulti',
    'Aggiorna risultato',
    'Cognome',
    'Data di arrivo',
    'reservation.added',
    'The birthday does not match the format d.m.Y.',
  ]);
});

test('react-i18next scanning warns about dynamic keys and ignores unrelated calls', () => {
  const source = `
    import { useTranslation } from 'react-i18next';

    export function Widget({ locale, api }) {
      const { t } = useTranslation();
      api.t('not a translation');
      return [t(\`locales.\${locale}\`), t('Adulti')];
    }
  `;

  const { keys, warnings } = extractTranslationKeysFromSource(source, 'widget.tsx', {
    framework: 'react-i18next',
    keySeparator: null,
  });

  assert.deepEqual(keys, ['Adulti']);
  assert.equal(warnings.length, 1);
  assert.match(warnings[0].message, /Skipped dynamic translation key/);
});

test('next-intl scanning ignores react-i18next patterns and vice versa', () => {
  const reactSource = `
    const { t } = useTranslation();
    t('Adulti');
  `;
  const nextIntlSource = `
    const t = useTranslations('nav');
    t('profile');
  `;

  assert.deepEqual(
    extractTranslationKeysFromSource(reactSource, 'a.tsx', { framework: 'next-intl' }).keys,
    []
  );
  assert.deepEqual(
    extractTranslationKeysFromSource(nextIntlSource, 'b.tsx', { framework: 'react-i18next' }).keys,
    []
  );
});
