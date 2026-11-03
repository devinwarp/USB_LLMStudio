import React, { createContext, useContext, useMemo } from "react";
import { DEFAULT_LOCALE, normalizeLocale, translate } from "./strings";

const I18nContext = createContext({ locale: DEFAULT_LOCALE, t: (key) => translate(DEFAULT_LOCALE, key) });

export function I18nProvider({ locale, children }) {
  const value = useMemo(() => {
    const safe = normalizeLocale(locale);
    return { locale: safe, t: (key) => translate(safe, key) };
  }, [locale]);
  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export const useI18n = () => useContext(I18nContext);
