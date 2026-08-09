/**
 * Live (release-day) source routing.
 * FRED remains the historical backfill engine; these providers are preferred on refresh.
 */

export type LiveProvider =
  | "bls"
  | "bea"
  | "ons"
  | "eurostat"
  | "adp"
  | "dol"
  | "atlanta_gdpnow";

export interface LiveSeriesRef {
  provider: LiveProvider;
  /** Provider-native series id / table key */
  seriesId: string;
  /** Optional BEA table / extra params encoded as "TABLE:LINE" or similar */
  note?: string;
}

/** Map metric id → official live series (release-day source of truth). */
export const LIVE_MAP: Record<string, LiveSeriesRef> = {
  // BLS — employment situation
  "us-nfp": { provider: "bls", seriesId: "CES0000000001" },
  "us-payrolls-level": { provider: "bls", seriesId: "CES0000000001" },
  "us-mfg-employment": { provider: "bls", seriesId: "CES3000000001" },
  "us-unemployment": { provider: "bls", seriesId: "LNS14000000" },
  "us-u6": { provider: "bls", seriesId: "LNS13327709" },
  "us-participation": { provider: "bls", seriesId: "LNS11300000" },
  "us-employment-population": { provider: "bls", seriesId: "LNS12300000" },
  "us-ahe": { provider: "bls", seriesId: "CES0500000003" },
  "us-avg-workweek": { provider: "bls", seriesId: "CES0500000002" },
  "us-temp-help": { provider: "bls", seriesId: "CES5613200001" },

  // BLS — CPI / PPI / ECI / JOLTS
  "us-cpi": { provider: "bls", seriesId: "CUSR0000SA0" },
  "us-cpi-yoy": { provider: "bls", seriesId: "CUSR0000SA0" },
  "us-cpi-mom": { provider: "bls", seriesId: "CUSR0000SA0" },
  "us-core-cpi": { provider: "bls", seriesId: "CUSR0000SA0L1E" },
  "us-core-cpi-yoy": { provider: "bls", seriesId: "CUSR0000SA0L1E" },
  "us-core-cpi-mom": { provider: "bls", seriesId: "CUSR0000SA0L1E" },
  "us-services-cpi-yoy": { provider: "bls", seriesId: "CUSR0000SASLE" },
  "us-services-cpi-mom": { provider: "bls", seriesId: "CUSR0000SASLE" },
  "us-shelter-cpi-yoy": { provider: "bls", seriesId: "CUSR0000SAH1" },
  "us-shelter-cpi-mom": { provider: "bls", seriesId: "CUSR0000SAH1" },
  "us-core-goods-cpi-yoy": { provider: "bls", seriesId: "CUSR0000SACL1E" },
  "us-core-goods-cpi-mom": { provider: "bls", seriesId: "CUSR0000SACL1E" },
  "us-food-cpi-yoy": { provider: "bls", seriesId: "CUSR0000SAF1" },
  "us-energy-cpi-yoy": { provider: "bls", seriesId: "CUSR0000SA0E" },
  "us-ppi-final-demand": { provider: "bls", seriesId: "WPSFD49207" },
  "us-ppi-core": { provider: "bls", seriesId: "WPSFD4131" },
  "us-eci-wages": { provider: "bls", seriesId: "CIS2020000000000Q" },
  "us-jolts-openings": { provider: "bls", seriesId: "JTS000000000000000JOL" },
  "us-jolts-quits": { provider: "bls", seriesId: "JTS000000000000000QUR" },
  "us-jolts-hires": { provider: "bls", seriesId: "JTS000000000000000HIR" },
  "us-jolts-layoffs": { provider: "bls", seriesId: "JTS000000000000000LDR" },

  // DOL weekly claims (official ETA)
  "us-initial-claims": { provider: "dol", seriesId: "initial" },
  "us-continuing-claims": { provider: "dol", seriesId: "continuing" },

  // ADP
  "us-adp-change": { provider: "adp", seriesId: "change" },
  "us-adp-level": { provider: "adp", seriesId: "level" },

  // Atlanta Fed
  "us-gdp-now": { provider: "atlanta_gdpnow", seriesId: "gdpnow" },

  // BEA (requires BEA_API_KEY)
  "us-gdp-real": { provider: "bea", seriesId: "T10101:1", note: "Real GDP % change SAAR" },
  "us-pce": { provider: "bea", seriesId: "T20804:1", note: "PCE price index" },
  "us-core-pce": { provider: "bea", seriesId: "T20804:24", note: "PCE ex food energy" },
  "us-core-pce-mom": { provider: "bea", seriesId: "T20804:24", note: "PCE ex food energy" },
  "us-personal-spending": { provider: "bea", seriesId: "T20600:1", note: "Real PCE" },

  // UK / EA already official on refresh via ONS / Eurostat when source is set
  "uk-cpih-yoy": { provider: "ons", seriesId: "L55O" },
  "uk-cpi-yoy": { provider: "ons", seriesId: "D7G7" },
  "uk-core-cpi-yoy": { provider: "ons", seriesId: "DKO8" },
  "uk-cpi-mom": { provider: "ons", seriesId: "D7OE" },
  "uk-core-cpi-mom": { provider: "ons", seriesId: "DKC6" },
  "uk-services-cpi-yoy": { provider: "ons", seriesId: "D7NN" },
  "uk-services-cpi-mom": { provider: "ons", seriesId: "D7MV" },
  "uk-goods-cpi-yoy": { provider: "ons", seriesId: "D7NM" },
  "uk-goods-cpi-mom": { provider: "ons", seriesId: "D7MU" },
  "uk-food-cpi-yoy": { provider: "ons", seriesId: "D7G8" },
  "uk-energy-cpi-yoy": { provider: "ons", seriesId: "D7GT" },
  "uk-housing-cpi-yoy": { provider: "ons", seriesId: "D7GB" },
  "uk-rpi-yoy": { provider: "ons", seriesId: "CZBH" },
  "uk-ppi-input-yoy": { provider: "ons", seriesId: "GHIP" },
  "uk-ppi-output-yoy": { provider: "ons", seriesId: "GB7S" },
  "uk-awe-regular-yoy": { provider: "ons", seriesId: "KAI9" },
  "uk-awe-total-yoy": { provider: "ons", seriesId: "KAC3" },
  "uk-vacancies": { provider: "ons", seriesId: "AP2Y" },
  "uk-gdp-yoy": { provider: "ons", seriesId: "IHYR" },
  "uk-gdp-qoq": { provider: "ons", seriesId: "IHYQ" },
  "uk-gdp-mom": { provider: "ons", seriesId: "ECYX" },
  "uk-gdp-3m-yoy": { provider: "ons", seriesId: "ED9T" },
  "uk-unemployment": { provider: "ons", seriesId: "MGSX" },
  "uk-employment-level": { provider: "ons", seriesId: "MGRZ" },
  "uk-industrial-production": { provider: "ons", seriesId: "K222" },
  "uk-retail-sales": { provider: "ons", seriesId: "J5EK" },
  "ea-hicp-yoy": { provider: "eurostat", seriesId: "prc_hicp_minr" },
  "ea-core-hicp-yoy": { provider: "eurostat", seriesId: "prc_hicp_minr_core" },
  "ea-hicp-mom": { provider: "eurostat", seriesId: "prc_hicp_mmor" },
  "ea-core-hicp-mom": { provider: "eurostat", seriesId: "prc_hicp_mmor_core" },
  "ea-services-hicp-yoy": { provider: "eurostat", seriesId: "prc_hicp_minr_serv" },
  "ea-services-hicp-mom": { provider: "eurostat", seriesId: "prc_hicp_mmor_serv" },
  "ea-goods-hicp-yoy": { provider: "eurostat", seriesId: "prc_hicp_minr_goods" },
  "ea-food-hicp-yoy": { provider: "eurostat", seriesId: "prc_hicp_minr_food" },
  "ea-energy-hicp-yoy": { provider: "eurostat", seriesId: "prc_hicp_minr_nrg" },
  "de-cpi-yoy": { provider: "eurostat", seriesId: "prc_hicp_minr_DE" },
  "fr-cpi-yoy": { provider: "eurostat", seriesId: "prc_hicp_minr_FR" },
  "it-cpi-yoy": { provider: "eurostat", seriesId: "prc_hicp_minr_IT" },
  "es-cpi-yoy": { provider: "eurostat", seriesId: "prc_hicp_minr_ES" },
  "ea-unemployment": { provider: "eurostat", seriesId: "une_rt_m" },
  "ea-youth-unemployment": { provider: "eurostat", seriesId: "une_rt_m_youth" },
  "ea-unemployed-persons": { provider: "eurostat", seriesId: "ei_lmhu_m" },
  "ea-employment-yoy": { provider: "eurostat", seriesId: "ei_lmhu_m" },
  "ea-ppi-yoy": { provider: "eurostat", seriesId: "sts_inpp_m" },
  "ea-industrial-production": { provider: "eurostat", seriesId: "sts_inpr_m" },
  "ea-retail-sales": { provider: "eurostat", seriesId: "ei_isrr_m" },
  "ea-esi": { provider: "eurostat", seriesId: "ei_bssi_esi" },
  "ea-business-confidence": { provider: "eurostat", seriesId: "ei_bssi_ici" },
};

export function liveSeriesIdsForProvider(provider: LiveProvider): string[] {
  return [
    ...new Set(
      Object.values(LIVE_MAP)
        .filter((v) => v.provider === provider)
        .map((v) => v.seriesId)
    ),
  ];
}
