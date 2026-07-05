import i18n from "i18next";
import LanguageDetector from "i18next-browser-languagedetector";
import { initReactI18next } from "react-i18next";
import en from "./locales/en.json";
import hi from "./locales/hi.json";

// Community translations: add ./locales/<lang>.json and register it here.
void i18n
  .use(LanguageDetector)
  .use(initReactI18next)
  .init({
    resources: {
      en: { translation: en },
      hi: { translation: hi },
    },
    fallbackLng: "en",
    interpolation: { escapeValue: false },
    detection: {
      // navigator language only — no localStorage, no cookies (anonymity:
      // Zenith leaves nothing behind in the browser).
      order: ["navigator"],
      caches: [],
    },
  });

export default i18n;
