/**
 * Maps our vocabularies onto the official UK classifications the free sources search by.
 * Configuration rather than data: the codes are fixed external standards, versioned with the code
 * that queries them.
 *
 * - SIC 2007 (Companies House "nature of business") for `industries`.
 * - CPV (Common Procurement Vocabulary, used by Contracts Finder) for `service_categories`.
 */

/** UK SIC 2007 codes per industry slug. An industry missing here can't be searched on Companies House. */
export const INDUSTRY_SIC_CODES: Record<string, string[]> = {
  accounting: ["69201", "69202", "69203"],
  legal: ["69101", "69102", "69109"],
  financial_services: ["64191", "64999", "66190", "66300"],
  insurance: ["65110", "65120", "66220"],
  real_estate: ["68100", "68201", "68209", "68310", "68320"],
  healthcare: ["86101", "86210", "86900"],
  dental: ["86230"],
  education: ["85200", "85310", "85410", "85590"],
  retail: ["47190", "47710", "47750"],
  ecommerce: ["47910"],
  hospitality: ["55100", "56101", "56302"],
  food_beverage: ["10710", "10890", "11050"],
  construction: ["41201", "41202", "43390", "43999"],
  manufacturing: ["25620", "28290", "32990"],
  logistics: ["49410", "52103", "52290", "53202"],
  automotive: ["45111", "45200"],
  saas: ["62012", "58290"],
  it_services: ["62020", "62090", "63110"],
  telecommunications: ["61100", "61900"],
  media_marketing: ["73110", "73120", "70210"],
  professional_services: ["70229", "74909", "82990"],
  recruitment_staffing: ["78109", "78200", "78300"],
  nonprofit: ["94990", "88990"],
  government: ["84110"],
  energy: ["35110", "35140"],
  agriculture: ["01110", "01410"],
};

/** The industry a SIC code belongs to (first match), for companies found on Companies House. */
export function industryForSicCodes(codes: string[]): string | null {
  for (const code of codes) {
    for (const [industry, sic] of Object.entries(INDUSTRY_SIC_CODES)) if (sic.includes(code)) return industry;
  }
  return null;
}

/** CPV codes per service category: the kinds of public contract each service can bid for. */
export const CATEGORY_CPV_CODES: Record<string, string[]> = {
  web_development: ["72413000", "72420000"],
  seo: ["79342000"],
  conversion_optimization: ["79342000"],
  digital_marketing: ["79340000"],
  content_marketing: ["79340000"],
  paid_media: ["79341000"],
  branding_design: ["79822500", "79930000"],
  ui_ux_design: ["72413000", "79822500"],
  software_development: ["72200000", "72230000"],
  mobile_development: ["72230000"],
  mvp_development: ["72200000", "72230000"],
  ecommerce_development: ["72413000", "72230000"],
  qa_testing: ["72254000"],
  cloud_devops: ["72300000", "72510000"],
  cybersecurity: ["72150000", "72220000"],
  data_analytics: ["72316000"],
  ai_ml: ["72200000", "72316000"],
  crm_implementation: ["72263000", "48445000"],
  erp_implementation: ["72263000", "48451000"],
  it_managed_services: ["72500000", "72600000"],
  staff_augmentation: ["79620000"],
  customer_support_outsourcing: ["79512000"],
  back_office_outsourcing: ["79500000"],
  appointment_setting: ["79512000"],
  recruitment_rpo: ["79600000"],
  consulting: ["79410000", "72220000"],
};
