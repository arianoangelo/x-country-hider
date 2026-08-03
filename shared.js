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

    return {
      enabled: value?.enabled !== false,
      blockedCountries,
    };
  }

  global.XHideShared = Object.freeze({
    normalizeCountry,
    normalizeSettings,
  });
})(globalThis);
