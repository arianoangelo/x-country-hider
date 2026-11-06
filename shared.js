(function (global) {
  const COUNTRY_ALIASES = new Map(
    [
      ['bolivia plurinational state of', 'bolivia'],
      ['brunei darussalam', 'brunei'],
      ['burma', 'myanmar'],
      ['cape verde', 'cabo verde'],
      ['czech republic', 'czechia'],
      ['democratic republic of the congo', 'dr congo'],
      ['congo democratic republic of the', 'dr congo'],
      ['congo kinshasa', 'dr congo'],
      ['congo brazzaville', 'republic of the congo'],
      ['east timor', 'timor leste'],
      ['iran islamic republic of', 'iran'],
      ['ivory coast', 'cote d ivoire'],
      ['korea north', 'north korea'],
      ['korea south', 'south korea'],
      ['korea democratic people s republic of', 'north korea'],
      ['korea republic of', 'south korea'],
      ['lao people s democratic republic', 'laos'],
      ['macedonia', 'north macedonia'],
      ['micronesia federated states of', 'micronesia'],
      ['moldova republic of', 'moldova'],
      ['palestine state of', 'palestine'],
      ['russian federation', 'russia'],
      ['swaziland', 'eswatini'],
      ['syrian arab republic', 'syria'],
      ['taiwan province of china', 'taiwan'],
      ['tanzania united republic of', 'tanzania'],
      ['turkey', 'turkiye'],
      ['united states of america', 'united states'],
      ['usa', 'united states'],
      ['venezuela bolivarian republic of', 'venezuela'],
      ['viet nam', 'vietnam'],
    ].map(([alias, canonical]) => [alias, canonical]),
  );

  function normalizedLabel(value) {
    return String(value || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]/g, '')
      .replace(/[’‘]/g, "'")
      .replace(/&/g, ' and ')
      .toLocaleLowerCase('en')
      .replace(/[^a-z0-9]+/g, ' ')
      .trim()
      .replace(/\s+/g, ' ');
  }

  function normalizeCountry(value) {
    const label = normalizedLabel(value);
    return COUNTRY_ALIASES.get(label) || label;
  }

  function normalizeLanguage(value) {
    const code = String(value || '')
      .trim()
      .replace(/_/g, '-')
      .toLocaleLowerCase('en')
      .split('-')[0];
    const aliases = { in: 'id', iw: 'he', tl: 'fil' };
    const normalized = aliases[code] || code;
    return /^[a-z]{2,3}$/.test(normalized) ? normalized : '';
  }

  function normalizeRegionCode(value) {
    const code = String(value || '').trim().toUpperCase();
    return /^[A-Z]{2}$/.test(code) ? code : '';
  }

  function languageForRegion(value) {
    const region = normalizeRegionCode(value);
    if (!region) return '';
    try {
      return normalizeLanguage(new Intl.Locale(`und-${region}`).maximize().language);
    } catch (_) {
      return '';
    }
  }

  function normalizeSettings(value) {
    const countries = Array.isArray(value?.blockedCountries)
      ? value.blockedCountries
          .map((country) => String(country || '').trim())
          .filter(Boolean)
      : [];
    const seen = new Set();
    const blockedCountries = countries.filter((country) => {
      const key = normalizeCountry(country);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    const storedCountryCodes = value?.blockedCountryCodes;
    const blockedCountryCodeEntries = blockedCountries.flatMap((country) => {
      if (!storedCountryCodes || typeof storedCountryCodes !== 'object') return [];
      const countryKey = normalizeCountry(country);
      const region = normalizeRegionCode(storedCountryCodes[countryKey]);
      return region ? [[countryKey, region]] : [];
    });

    return {
      enabled: value?.enabled !== false,
      autoMute: Boolean(value?.autoMute),
      blockedCountries,
      blockedCountryCodes: Object.fromEntries(blockedCountryCodeEntries),
    };
  }

  function isCountryBlocked(country, blockedCountries) {
    if (!country || !Array.isArray(blockedCountries)) return false;
    const countryKey = normalizeCountry(country);
    if (!countryKey) return false;
    return blockedCountries.some(
      (blockedCountry) => normalizeCountry(blockedCountry) === countryKey,
    );
  }

  global.XHideShared = Object.freeze({
    isCountryBlocked,
    languageForRegion,
    normalizeCountry,
    normalizeLanguage,
    normalizeRegionCode,
    normalizeSettings,
  });
})(globalThis);
